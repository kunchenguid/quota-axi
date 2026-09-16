import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { deleteCachedProvider, readCachedProviderInContext } from "../cache.js";
import { collapseHome } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import {
  clampPercent,
  nowIso,
  parseEpochOrIso,
  percentRemaining,
  retryAfterToIso,
} from "../lib/time.js";
import { VERSION } from "../version.js";
import type {
  AuthSourceReport,
  ProviderAdapter,
  ProviderAuthStatus,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
} from "./common.js";
import { withKiroReadingContext } from "./kiro-cache-context.js";

const KIRO_DB_ENV = "KIRO_CLI_DB";
const KIRO_REGION_ENV = "KIRO_REGION";
const KIRO_PROFILE_ARN_ENV = "KIRO_PROFILE_ARN";
const KIRO_DB_DEFAULT = join(
  homedir(),
  ".local",
  "share",
  "kiro-cli",
  "data.sqlite3",
);
const KIRO_TOKEN_KEY = "kirocli:odic:token";
const KIRO_SOURCE = "kiro-sqlite";
const API_TIMEOUT_MS = 15_000;
const API_TARGET = "AmazonCodeWhispererService.GetUsageLimits";
const SQLITE_BUSY_CODES = new Set([5, 6]);

type SqliteStatement = { get(...params: unknown[]): unknown };
type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type SqliteDatabaseConstructor = new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

let sqliteDatabase: SqliteDatabaseConstructor | undefined;
function loadSqlite(): SqliteDatabaseConstructor {
  if (!sqliteDatabase) {
    const require = createRequire(import.meta.url);
    sqliteDatabase = (
      require("node:sqlite") as { DatabaseSync: SqliteDatabaseConstructor }
    ).DatabaseSync;
  }
  return sqliteDatabase;
}

type KiroCredentials = {
  accessToken: string;
  region: string;
  storedExpired: boolean;
  refreshable: boolean;
};
export type KiroCredentialState =
  | {
      status: "available" | "expired";
      credentials: KiroCredentials;
      source: AuthSourceReport;
    }
  | {
      status: "missing" | "invalid" | "error";
      source: AuthSourceReport;
    };
type KiroDependencies = {
  fetch?: typeof fetch;
  readCredentialState?: () => KiroCredentialState;
};

export const kiroAdapter: ProviderAdapter = createKiroAdapter();

export function createKiroAdapter(
  dependencies: KiroDependencies = {},
): ProviderAdapter {
  const readCredentials =
    dependencies.readCredentialState ?? readCredentialState;
  return {
    id: "kiro",
    label: "Kiro",
    fetchQuota: (options) =>
      fetchQuotaWith(
        options,
        dependencies.fetch ?? providerFetch,
        readCredentials,
      ),
    inspectAuth: async () => ({
      provider: "kiro",
      sources: [readCredentials().source],
    }),
  };
}

async function fetchQuotaWith(
  _options: ProviderOptions,
  request: typeof fetch,
  readCredentials: () => KiroCredentialState,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const databasePath = process.env[KIRO_DB_ENV] || KIRO_DB_DEFAULT;
  const profileArn = process.env[KIRO_PROFILE_ARN_ENV]?.trim() || undefined;
  const configuredRegion = stringValue(process.env[KIRO_REGION_ENV]);
  const credentialState = readCredentials();
  const region =
    configuredRegion ??
    ("credentials" in credentialState
      ? credentialState.credentials.region
      : undefined);
  const contextId = region
    ? createHash("sha256")
        .update(
          JSON.stringify([resolve(databasePath), region, profileArn ?? null]),
        )
        .digest("hex")
    : undefined;
  const credentialPresent =
    credentialState.status !== "missing" && credentialState.status !== "error";

  if (!("credentials" in credentialState)) {
    attempts.push({
      source: KIRO_SOURCE,
      status: "skipped",
      ...(credentialState.status === "error"
        ? { error: credentialState.source.error, degraded: true }
        : {
            error: `credentials_${credentialState.status}`,
            ...(credentialPresent ? { credentialPresent } : {}),
          }),
    });
    return unavailableReport(
      credentialState.status === "error"
        ? { error: "Kiro credential store unavailable", status: "error" }
        : { error: "Kiro sign-in required", status: "auth_required" },
      attempts,
      contextId,
    );
  }

  attempts.push({ source: KIRO_SOURCE, status: "failed", credentialPresent });
  try {
    const quota = await fetchKiroUsage(
      credentialState.credentials,
      request,
      profileArn,
    );
    attempts[attempts.length - 1] = {
      source: KIRO_SOURCE,
      status: "success",
      credentialPresent,
    };
    return withKiroReadingContext(
      successProvider({
        provider: "kiro",
        label: "Kiro",
        source: "api",
        plan: quota.plan,
        windows: quota.windows,
        credits: quota.credits,
        refreshedAt: quota.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      }),
      contextId,
    );
  } catch (error) {
    const failure = classifyFailure(error, credentialState.credentials);
    attempts[attempts.length - 1] = {
      source: KIRO_SOURCE,
      status: "failed",
      error: failure.error,
      credentialPresent,
    };
    return unavailableReport(failure, attempts, contextId);
  }
}

type KiroFailure = {
  error: string;
  status: ProviderStatus;
  retryAfter?: string;
  authStatus?: ProviderAuthStatus;
};

function classifyFailure(
  error: unknown,
  credentials: KiroCredentials,
): KiroFailure {
  if (error instanceof RateLimitError) {
    return {
      error: error.message,
      status: "rate_limited",
      retryAfter: error.retryAfter,
    };
  }
  if (error instanceof RejectedError) {
    if (credentials.storedExpired && credentials.refreshable) {
      return {
        error: "Kiro access token expired",
        status: "unavailable",
        authStatus: "expired_refreshable",
      };
    }
    return {
      error: "Kiro sign-in required",
      status: "auth_required",
      authStatus: "unusable",
    };
  }
  const message = errorMessage(error);
  return { error: message, status: statusFromError(message) };
}

function unavailableReport(
  failure: KiroFailure,
  attempts: SourceAttempt[],
  contextId: string | undefined,
): ProviderQuota {
  const definitiveAuthFailure = failure.status === "auth_required";
  if (definitiveAuthFailure && contextId) retireCache(contextId);
  const cached =
    definitiveAuthFailure || !contextId
      ? undefined
      : readCachedProviderInContext("kiro", contextId);
  if (cached) {
    const stale = staleFromCache(
      cached,
      failure.error,
      sourceNames(attempts),
      attempts,
    );
    return {
      ...stale,
      state: {
        ...stale.state,
        ...(failure.authStatus ? { authStatus: failure.authStatus } : {}),
        ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      },
    };
  }
  const report = failedProvider({
    provider: "kiro",
    label: "Kiro",
    status: failure.status,
    error: failure.error,
    retryAfter: failure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  return failure.authStatus
    ? { ...report, state: { ...report.state, authStatus: failure.authStatus } }
    : report;
}

function retireCache(contextId: string): void {
  try {
    deleteCachedProvider("kiro", contextId);
  } catch {
    return;
  }
}

export function normalizeKiroUsage(raw: unknown):
  | {
      plan?: string;
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const resetAt = parseEpochOrIso(data.nextDateReset);
  const breakdowns = arrayValue(data.usageBreakdownList);
  const normalized = normalizeBreakdowns(breakdowns, resetAt);
  const windows = normalized.map(({ window }) => window);
  const subscription = objectValue(data.subscriptionInfo);
  const plan =
    stringValue(subscription?.subscriptionTitle) ??
    stringValue(subscription?.type);
  if (windows.length === 0 && !plan && !subscription) return undefined;
  const balance = normalized.find(
    ({ window }) => window.id === "credit",
  )?.remaining;
  return {
    plan,
    windows,
    credits:
      balance === undefined
        ? undefined
        : { remaining: balance, unit: "credits" },
    refreshedAt: nowIso(),
  };
}

async function fetchKiroUsage(
  credentials: KiroCredentials,
  request: typeof fetch,
  profileArn: string | undefined,
): Promise<{
  plan?: string;
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {};
    if (profileArn) body.profileArn = profileArn;
    const response = await request(
      `https://codewhisperer.${credentials.region}.amazonaws.com/`,
      {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          accept: "application/json",
          "content-type": "application/x-amz-json-1.0",
          "user-agent": `quota-axi/${VERSION}`,
          "x-amz-target": API_TARGET,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    rejectUnusableResponse(response);
    const quota = normalizeKiroUsage(await response.json());
    if (!quota) throw new Error("Kiro quota unavailable");
    return quota;
  } finally {
    clearTimeout(timer);
  }
}

export function readCredentialState(
  databasePath = process.env[KIRO_DB_ENV] || KIRO_DB_DEFAULT,
): KiroCredentialState {
  const path = collapseHome(databasePath);
  const report = (
    status: AuthSourceReport["status"],
    error?: string,
  ): AuthSourceReport => ({
    source: KIRO_SOURCE,
    path,
    status,
    ...(error ? { error } : {}),
    ...(status === "missing" || status === "error"
      ? {}
      : { credentialPresent: true }),
  });
  if (!existsSync(databasePath)) {
    return { status: "missing", source: report("missing") };
  }
  let raw: string | undefined;
  try {
    const database = new (loadSqlite())(databasePath, { readOnly: true });
    try {
      const row = objectValue(
        database
          .prepare("SELECT value FROM auth_kv WHERE key = ?")
          .get(KIRO_TOKEN_KEY),
      );
      raw = stringValue(row?.value);
    } finally {
      database.close();
    }
  } catch (error) {
    return SQLITE_BUSY_CODES.has(sqliteErrorCode(error) ?? -1)
      ? { status: "error", source: report("error", "database_busy") }
      : { status: "invalid", source: report("invalid", "database_read_error") };
  }
  if (!raw) {
    return {
      status: "missing",
      source: { source: KIRO_SOURCE, path, status: "missing" },
    };
  }
  let token: Record<string, unknown>;
  try {
    token = objectValue(JSON.parse(raw)) ?? {};
  } catch {
    return {
      status: "invalid",
      source: report("invalid", "json_parse_error"),
    };
  }
  const accessToken = stringValue(token.access_token);
  const region =
    stringValue(process.env[KIRO_REGION_ENV]) ??
    stringValue(token.region) ??
    "us-east-1";
  if (!accessToken || !/^[a-z0-9-]+$/.test(region)) {
    return {
      status: "invalid",
      source: report("invalid", "credential_shape_invalid"),
    };
  }
  const expiresAt = epochMillis(token.expires_at);
  const storedExpired = expiresAt !== undefined && expiresAt <= Date.now();
  const credentials: KiroCredentials = {
    accessToken,
    region,
    storedExpired,
    refreshable: Object.hasOwn(token, "refresh_token"),
  };
  if (storedExpired) {
    return {
      status: "expired",
      credentials,
      source: report("expired", "access_token_expired"),
    };
  }
  return { status: "available", credentials, source: report("available") };
}

function creditPool(
  item: Record<string, unknown>,
): { used: number; limit: number } | undefined {
  const used =
    numberValue(item.currentUsageWithPrecision) ??
    numberValue(item.currentUsage);
  const limit =
    numberValue(item.usageLimitWithPrecision) ?? numberValue(item.usageLimit);
  if (used === undefined || limit === undefined || used < 0 || limit < 0)
    return undefined;
  return { used: Math.min(used, limit), limit };
}

function normalizeBreakdowns(
  values: unknown[],
  fallbackReset: string | undefined,
): { window: QuotaWindow; remaining: number }[] {
  return values.flatMap((value, index) => {
    const item = objectValue(value);
    if (!item) return [];
    const base = creditPool(item);
    if (!base) return [];
    let { used, limit } = base;
    const trial = objectValue(item.freeTrialInfo);
    const trialExpiry = parseEpochOrIso(trial?.freeTrialExpiry);
    if (
      trial?.freeTrialStatus === "ACTIVE" &&
      (!trialExpiry || Date.parse(trialExpiry) > Date.now())
    ) {
      const pool = creditPool(trial);
      if (!pool) return [];
      used += pool.used;
      limit += pool.limit;
    }
    if (limit <= 0) return [];
    const percentUsed = clampPercent((used / limit) * 100);
    const resource =
      stringValue(item.resourceType) ??
      stringValue(item.displayName) ??
      `credit_${index + 1}`;
    const label =
      stringValue(item.displayNamePlural) ??
      stringValue(item.displayName) ??
      "Credits";
    return [
      {
        remaining: Math.max(0, limit - used),
        window: {
          id: slug(resource, index),
          label,
          kind: "credits" as const,
          percentUsed,
          percentRemaining: percentRemaining(percentUsed),
          resetsAt: parseEpochOrIso(item.nextDateReset) ?? fallbackReset,
        },
      },
    ];
  });
}

function slug(value: string, index: number): string {
  const normalized = value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || `credit_${index + 1}`;
}

function rejectUnusableResponse(response: Response): void {
  if (response.status >= 300 && response.status < 400)
    throw new Error("redirect_rejected");
  if (response.status === 429)
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  if (response.status === 401 || response.status === 403)
    throw new RejectedError();
  if (!response.ok)
    throw new Error(`Kiro quota unavailable (${response.status})`);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
function epochMillis(value: unknown): number | undefined {
  const number = numberValue(value);
  if (number !== undefined)
    return number > 10_000_000_000 ? number : number * 1000;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
function sqliteErrorCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "errcode" in error
    ? typeof error.errcode === "number"
      ? error.errcode
      : undefined
    : undefined;
}
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Kiro quota request timed out";
  return error instanceof Error ? error.message : "Kiro quota unavailable";
}
class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Kiro quota endpoint rate limited");
  }
}
class RejectedError extends Error {
  constructor() {
    super("Kiro credential rejected");
  }
}
