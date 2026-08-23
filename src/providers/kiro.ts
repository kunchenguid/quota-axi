import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { collapseHome } from "../lib/fs.js";
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
  ProviderOptions,
  ProviderQuota,
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
const API_TIMEOUT_MS = 15_000;
const API_TARGET = "AmazonCodeWhispererService.GetUsageLimits";

const require = createRequire(import.meta.url);
type SqliteStatement = { get(...params: unknown[]): unknown };
type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type SqliteDatabaseConstructor = new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: SqliteDatabaseConstructor;
};

type KiroCredentials = { accessToken: string; region: string };
export type KiroCredentialState =
  | {
      status: "available";
      credentials: KiroCredentials;
      source: AuthSourceReport;
    }
  | {
      status: "missing" | "invalid" | "expired";
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
        dependencies.fetch ?? globalThis.fetch,
        readCredentials,
      ),
    inspectAuth: async () => ({
      provider: "kiro",
      sources: [readCredentials().source],
    }),
  };
}

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWith(options, globalThis.fetch, readCredentialState);
}

async function fetchQuotaWith(
  _options: ProviderOptions,
  request: typeof fetch,
  readCredentials: () => KiroCredentialState,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const credentialState = readCredentials();
  const source = "kiro-sqlite";

  if (credentialState.status !== "available") {
    attempts.push({
      source,
      status: "skipped",
      error: `credentials_${credentialState.status}`,
    });
    const finalError = "Kiro sign-in required";
    const cached = readCachedProvider("kiro");
    if (cached) {
      return staleFromCache(
        cached,
        finalError,
        sourceNames(attempts),
        attempts,
      );
    }
    return failedProvider({
      provider: "kiro",
      label: "Kiro",
      status: statusFromError(finalError),
      error: finalError,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  attempts.push({ source, status: "failed" });
  try {
    const quota = await fetchKiroUsage(credentialState.credentials, request);
    attempts[attempts.length - 1] = { source, status: "success" };
    return successProvider({
      provider: "kiro",
      label: "Kiro",
      source: "api",
      plan: quota.plan,
      windows: quota.windows,
      credits: quota.credits,
      refreshedAt: quota.refreshedAt,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const finalError = errorMessage(error);
    attempts[attempts.length - 1] = {
      source,
      status: "failed",
      error: finalError,
    };
    const retryAfter =
      error instanceof RateLimitError ? error.retryAfter : undefined;
    const cached = readCachedProvider("kiro");
    if (cached) {
      return staleFromCache(
        cached,
        finalError,
        sourceNames(attempts),
        attempts,
      );
    }
    return failedProvider({
      provider: "kiro",
      label: "Kiro",
      status: retryAfter ? "rate_limited" : statusFromError(finalError),
      error: finalError,
      retryAfter,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
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
  const resetAt = parseEpochOrIso(data.nextDateReset ?? data.next_date_reset);
  const breakdowns = arrayValue(
    data.usageBreakdownList ?? data.usage_breakdown_list,
  );
  const windows = normalizeBreakdowns(breakdowns, resetAt);
  const fallbackWindows =
    windows.length > 0
      ? windows
      : normalizeLimits(arrayValue(data.limits), resetAt);
  const subscription = objectValue(
    data.subscriptionInfo ?? data.subscription_info,
  );
  const plan =
    stringValue(subscription?.subscriptionTitle) ??
    stringValue(subscription?.type);
  if (fallbackWindows.length === 0 && !plan && !subscription) return undefined;
  const balance = creditBalance(breakdowns);
  return {
    plan,
    windows: fallbackWindows,
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
): Promise<{
  plan?: string;
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = { isEmailRequired: true };
    const profileArn = process.env[KIRO_PROFILE_ARN_ENV]?.trim();
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
  let database: SqliteDatabase;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    const missing = errorCode(error) === "ENOENT";
    return {
      status: missing ? "missing" : "invalid",
      source: {
        source: "kiro-sqlite",
        path,
        status: missing ? "missing" : "invalid",
        error: missing ? undefined : "database_read_error",
      },
    };
  }
  try {
    const row = objectValue(
      database
        .prepare("SELECT value FROM auth_kv WHERE key = ?")
        .get(KIRO_TOKEN_KEY),
    );
    const raw = stringValue(row?.value);
    if (!raw) {
      return {
        status: "missing",
        source: { source: "kiro-sqlite", path, status: "missing" },
      };
    }
    let token: Record<string, unknown>;
    try {
      token = objectValue(JSON.parse(raw)) ?? {};
    } catch {
      return {
        status: "invalid",
        source: {
          source: "kiro-sqlite",
          path,
          status: "invalid",
          error: "json_parse_error",
        },
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
        source: {
          source: "kiro-sqlite",
          path,
          status: "invalid",
          error: "credential_shape_invalid",
        },
      };
    }
    const expiresAt = epochMillis(token.expires_at);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      return {
        status: "expired",
        source: {
          source: "kiro-sqlite",
          path,
          status: "expired",
          error: "access_token_expired",
        },
      };
    }
    return {
      status: "available",
      credentials: { accessToken, region },
      source: { source: "kiro-sqlite", path, status: "available" },
    };
  } finally {
    database.close();
  }
}

function creditBalance(values: unknown[]): number | undefined {
  for (const value of values) {
    const item = objectValue(value);
    if (!item) continue;
    const used =
      numberValue(item.currentUsageWithPrecision) ??
      numberValue(item.current_usage_with_precision) ??
      numberValue(item.currentUsage) ??
      numberValue(item.current_usage);
    const limit =
      numberValue(item.usageLimitWithPrecision) ??
      numberValue(item.usage_limit_with_precision) ??
      numberValue(item.usageLimit) ??
      numberValue(item.usage_limit);
    if (used !== undefined && limit !== undefined && limit > 0)
      return Math.max(0, limit - used);
  }
  return undefined;
}

function normalizeBreakdowns(
  values: unknown[],
  fallbackReset: string | undefined,
): QuotaWindow[] {
  return values
    .map((value, index): QuotaWindow | undefined => {
      const item = objectValue(value);
      if (!item) return undefined;
      const used =
        numberValue(item.currentUsageWithPrecision) ??
        numberValue(item.current_usage_with_precision) ??
        numberValue(item.currentUsage) ??
        numberValue(item.current_usage);
      const limit =
        numberValue(item.usageLimitWithPrecision) ??
        numberValue(item.usage_limit_with_precision) ??
        numberValue(item.usageLimit) ??
        numberValue(item.usage_limit);
      if (used === undefined || limit === undefined || limit <= 0)
        return undefined;
      const percentUsed = clampPercent((used / limit) * 100);
      const resource =
        stringValue(item.resourceType) ??
        stringValue(item.resource_type) ??
        stringValue(item.displayName) ??
        `credit_${index + 1}`;
      const label =
        stringValue(item.displayNamePlural) ??
        stringValue(item.display_name_plural) ??
        stringValue(item.displayName) ??
        "Credits";
      return {
        id: slug(resource, index),
        label,
        kind: "credits" as const,
        percentUsed,
        percentRemaining: percentRemaining(percentUsed),
        resetsAt:
          parseEpochOrIso(item.nextDateReset ?? item.next_date_reset) ??
          fallbackReset,
      };
    })
    .filter((window): window is QuotaWindow => Boolean(window));
}

function normalizeLimits(
  values: unknown[],
  fallbackReset: string | undefined,
): QuotaWindow[] {
  return values
    .map((value, index): QuotaWindow | undefined => {
      const item = objectValue(value);
      if (!item) return undefined;
      const directPercent = numberValue(item.percentUsed ?? item.percent_used);
      const used = numberValue(item.currentUsage ?? item.current_usage);
      const limit = numberValue(item.totalUsageLimit ?? item.total_usage_limit);
      const percentUsed =
        directPercent !== undefined
          ? clampPercent(directPercent)
          : used !== undefined && limit !== undefined && limit > 0
            ? clampPercent((used / limit) * 100)
            : undefined;
      if (percentUsed === undefined) return undefined;
      const feature =
        stringValue(item.feature) ??
        stringValue(item.resourceType) ??
        `limit_${index + 1}`;
      return {
        id: slug(feature, index),
        label: humanize(feature),
        kind: "credits",
        percentUsed,
        percentRemaining: percentRemaining(percentUsed),
        resetsAt: fallbackReset,
      };
    })
    .filter((window): window is QuotaWindow => Boolean(window));
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

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function rejectUnusableResponse(response: Response): void {
  if (response.status >= 300 && response.status < 400)
    throw new Error("redirect_rejected");
  if (response.status === 429)
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  if (response.status === 401 || response.status === 403)
    throw new Error("Kiro sign-in required");
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
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? typeof error.code === "string"
      ? error.code
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
