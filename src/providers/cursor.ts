import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { execFileText, commandExists } from "../lib/process.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
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
  withRemaining,
} from "./common.js";
import {
  cursorCliAuthPath,
  createCursorCliCredentialSource,
  DEFAULT_CURSOR_CLIENT_VERSION,
} from "./cursor-cli-auth.js";
import {
  isCursorCliSourceSupported,
  readCursorCliCredentialState,
} from "./cursor-cli-credential.js";

const API_URL = "https://api2.cursor.sh";
const API_TIMEOUT_MS = 15_000;
const SQLITE_TIMEOUT_MS = 5_000;
const STATE_DB = cursorStateDbPath();

type CursorCredentials = {
  accessToken: string;
  email?: string;
  membershipType?: string;
  clientType: "editor" | "cli";
  clientVersion?: string;
};

type UnavailableCredentialState = {
  status: "missing" | "invalid" | "skipped" | "expired";
  source: AuthSourceReport;
};

type CredentialState =
  | {
      status: "available";
      credentials: CursorCredentials;
      source: AuthSourceReport;
    }
  | UnavailableCredentialState;

type CursorCredentialSourceName =
  | "state-vscdb"
  | "cursor-cli-auth"
  | "cli-keychain";

type CredentialReader = {
  source: CursorCredentialSourceName;
  read: () => Promise<CredentialState>;
};

export const cursorAdapter: ProviderAdapter = {
  id: "cursor",
  label: "Cursor",
  fetchQuota,
  inspectAuth,
};

/**
 * The Cursor editor and CLI keep credentials in different stores, and any
 * source alone is enough. Quota fetching tries the non-prompting stores
 * first — the editor state.vscdb, then the CLI auth.json — and reads the
 * prompt-gated CLI Keychain value (macOS only) last, only when no earlier
 * source yields a usable token or an earlier token is rejected by Cursor.
 */
function credentialReaders(options: ProviderOptions): CredentialReader[] {
  return [
    { source: "state-vscdb", read: readCredentialState },
    { source: "cursor-cli-auth", read: () => readCliAuthCredentialState() },
    ...(isCursorCliSourceSupported()
      ? [
          {
            source: "cli-keychain" as const,
            read: () => readCliCredentialState(options),
          },
        ]
      : []),
  ];
}

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const unavailable: UnavailableCredentialState[] = [];
  let finalError: string | undefined;
  let retryAfter: string | undefined;

  const readers = credentialReaders(options);
  for (let index = 0; index < readers.length; index += 1) {
    const reader = readers[index];
    const state = await reader.read();
    if (state.status !== "available") {
      unavailable.push(state);
      attempts.push(unavailableAttempt(state));
      continue;
    }
    // The editor-credential fetch keeps its established `api` attempt name; a
    // CLI-resolved fetch is named for its credential store so `sourcesTried`
    // shows which store, not the absent editor store, answered.
    const label = reader.source === "state-vscdb" ? "api" : reader.source;
    attempts.push({ source: label, status: "failed" });
    try {
      const quota = await fetchCursorUsage(state.credentials);
      attempts[attempts.length - 1] = { source: label, status: "success" };
      return cursorSuccess(quota, attempts);
    } catch (error) {
      finalError = errorMessage(error);
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
      const hasFallback = index < readers.length - 1;
      attempts[attempts.length - 1] = {
        source:
          error instanceof CursorAuthError && hasFallback
            ? reader.source
            : label,
        status: "failed",
        error: finalError,
      };
      if (!(error instanceof CursorAuthError)) break;
    }
  }

  const resolvedFinalError =
    finalError ?? combinedCursorFinalError(unavailable);

  const cached = readCachedProvider("cursor");
  if (cached) {
    return staleFromCache(
      cached,
      resolvedFinalError,
      sourceNames(attempts),
      attempts,
    );
  }

  return failedProvider({
    provider: "cursor",
    label: "Cursor",
    status: retryAfter ? "rate_limited" : statusFromError(resolvedFinalError),
    error: resolvedFinalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const editorState = await readCredentialState();
  const cliAuthState = await readCliAuthCredentialState({
    includeClientVersion: false,
  });
  const sources = [editorState.source, cliAuthState.source];
  if (isCursorCliSourceSupported()) {
    const nonPromptingAvailable =
      editorState.status === "available" ||
      cliAuthState.status === "available";
    sources.push(
      (
        await readCliCredentialState(
          nonPromptingAvailable
            ? { ...options, allowKeychainPrompt: false }
            : options,
          nonPromptingAvailable,
        )
      ).source,
    );
  }
  return { provider: "cursor", sources };
}

function unavailableAttempt(state: UnavailableCredentialState): SourceAttempt {
  return {
    source: state.source.source,
    status: "skipped",
    error: cursorCredentialError(state),
    ...(state.source.credentialPresent === undefined
      ? {}
      : { credentialPresent: state.source.credentialPresent }),
  };
}

/**
 * Prefers a genuine diagnostic ("invalid": e.g. a locked/corrupted sqlite
 * DB, then "expired": a stale CLI token) over a plain absence from any
 * source, so a real signal is not masked just because the other sources are
 * also unavailable. Next, a source that provably still holds a credential —
 * a Keychain value read waiting on the one-time prompt — outranks a merely
 * absent store, so a signed-in `cursor-agent` user sees the Keychain remedy
 * instead of `Cursor sign-in required`. Otherwise the first non-skipped
 * source decides, preserving the original cursorFinalError "missing"
 * semantics. When every source is skipped and none holds a credential,
 * state-vscdb's skip reason wins (e.g. sqlite3_unavailable on win32 without
 * sqlite3).
 */
function combinedCursorFinalError(
  states: UnavailableCredentialState[],
): string {
  const decisive =
    states.find((state) => state.status === "invalid") ??
    states.find((state) => state.status === "expired") ??
    states.find((state) => state.source.credentialPresent === true) ??
    states.find((state) => state.status !== "skipped") ??
    states[0];
  return cursorFinalError(decisive, cursorCredentialError(decisive));
}

export function normalizeCursorUsage(
  usage: unknown,
  planInfo?: unknown,
  credentials?: Pick<CursorCredentials, "email" | "membershipType">,
):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  const data = objectValue(usage);
  if (!data) return undefined;
  const planData = objectValue(planInfo);
  const plan = objectValue(planData?.planInfo);
  const planName =
    stringValue(plan?.planName) ??
    stringValue(plan?.price) ??
    credentials?.membershipType;
  const reset =
    parseEpochMillisOrIso(data.billingCycleEnd) ??
    parseEpochMillisOrIso(plan?.billingCycleEnd);
  const planUsage = objectValue(data.planUsage);
  const windows: QuotaWindow[] = [];

  const total = numberValue(planUsage?.totalPercentUsed);
  if (total !== undefined) {
    windows.push(
      withRemaining({
        id: "included_usage",
        label: "included usage",
        kind: "monthly",
        percentUsed: clampPercent(total),
        resetsAt: reset,
      }),
    );
  }
  const auto = numberValue(planUsage?.autoPercentUsed);
  if (auto !== undefined) {
    windows.push(
      withRemaining({
        id: "auto_usage",
        label: "auto usage",
        kind: "monthly",
        percentUsed: clampPercent(auto),
        resetsAt: reset,
      }),
    );
  }
  const api = numberValue(planUsage?.apiPercentUsed);
  if (api !== undefined) {
    windows.push(
      withRemaining({
        id: "api_usage",
        label: "API usage",
        kind: "monthly",
        percentUsed: clampPercent(api),
        resetsAt: reset,
      }),
    );
  }

  const spend = objectValue(data.spendLimitUsage);
  const individualLimit = numberValue(spend?.individualLimit);
  const individualRemaining = numberValue(spend?.individualRemaining);
  const individualUsed =
    numberValue(spend?.individualUsed) ??
    (individualLimit !== undefined && individualRemaining !== undefined
      ? individualLimit - individualRemaining
      : undefined);
  if (individualLimit !== undefined && individualLimit > 0) {
    windows.push(
      withRemaining({
        id: "spend_limit",
        label: "spend limit",
        kind: "credits",
        percentUsed:
          individualUsed === undefined
            ? undefined
            : clampPercent((individualUsed / individualLimit) * 100),
        spentUsd:
          individualUsed === undefined ? undefined : individualUsed / 100,
        limitUsd: individualLimit / 100,
        resetsAt: reset,
      }),
    );
  }

  if (windows.length === 0) return undefined;
  return {
    plan: planName,
    account: { email: credentials?.email },
    windows,
    refreshedAt: nowIso(),
  };
}

async function fetchCursorUsage(credentials: CursorCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  const [usage, planInfo] = await Promise.all([
    postDashboardRpc(credentials, "GetCurrentPeriodUsage"),
    postDashboardRpc(credentials, "GetPlanInfo").catch(() => undefined),
  ]);
  const quota = normalizeCursorUsage(usage, planInfo, credentials);
  if (!quota) throw new Error("Cursor quota unavailable");
  return quota;
}

async function postDashboardRpc(
  credentials: CursorCredentials,
  method: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${API_URL}/aiserver.v1.DashboardService/${method}`,
      {
        method: "POST",
        headers: cursorRequestHeaders(credentials),
        body: "{}",
        signal: controller.signal,
      },
    );
    rejectUnusableUsageResponse(response);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Editor-origin requests keep today's exact header set, and Keychain-sourced
 * CLI tokens keep it too, matching the behaviour they shipped with. Requests
 * bearing an auth.json CLI token additionally carry the two x-cursor-*
 * headers the CLI endpoint expects; clientVersion is already ANSI-stripped
 * and charset-validated by the credential source, so it is safe to use here.
 */
function cursorRequestHeaders(
  credentials: CursorCredentials,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.accessToken}`,
    accept: "application/json",
    "content-type": "application/json",
    "connect-protocol-version": "1",
  };
  if (credentials.clientType === "cli") {
    headers["x-cursor-client-type"] = "cli";
    headers["x-cursor-client-version"] =
      credentials.clientVersion ?? DEFAULT_CURSOR_CLIENT_VERSION;
  }
  return headers;
}

function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new CursorAuthError();
  }
  if (response.status === 429) {
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  }
  if (!response.ok)
    throw new Error(`Cursor quota unavailable (${response.status})`);
}

async function readCredentialState(): Promise<CredentialState> {
  if (!(await commandExists("sqlite3"))) {
    return {
      status: "skipped",
      source: {
        source: "state-vscdb",
        path: STATE_DB,
        status: "skipped",
        error: "sqlite3_unavailable",
      },
    };
  }
  try {
    const accessToken = await readCursorStateValue("cursorAuth/accessToken");
    if (!accessToken) {
      return {
        status: "missing",
        source: { source: "state-vscdb", path: STATE_DB, status: "missing" },
      };
    }
    const email = await readCursorStateValue("cursorAuth/cachedEmail");
    const membershipType = await readCursorStateValue(
      "cursorAuth/stripeMembershipType",
    );
    return {
      status: "available",
      credentials: { accessToken, email, membershipType, clientType: "editor" },
      source: { source: "state-vscdb", path: STATE_DB, status: "available" },
    };
  } catch (error) {
    const sqliteError = sqliteErrorMessage(error);
    if (sqliteError === "credentials_missing") {
      return {
        status: "missing",
        source: { source: "state-vscdb", path: STATE_DB, status: "missing" },
      };
    }
    return {
      status: "invalid",
      source: {
        source: "state-vscdb",
        path: STATE_DB,
        status: "invalid",
        error: sqliteError,
      },
    };
  }
}

async function readCliAuthCredentialState(options?: {
  includeClientVersion?: boolean;
}): Promise<CredentialState> {
  const path = cursorCliAuthPath();
  const resolution = await createCursorCliCredentialSource().resolve(options);

  if (resolution.status === "available") {
    return {
      status: "available",
      credentials: {
        accessToken: resolution.accessToken,
        clientType: "cli",
        clientVersion: resolution.clientVersion,
      },
      source: {
        source: "cursor-cli-auth",
        path,
        status: "available",
      },
    };
  }
  if (resolution.status === "skipped") {
    return {
      status: "skipped",
      source: {
        source: "cursor-cli-auth",
        path,
        status: "skipped",
        error: resolution.reason,
      },
    };
  }
  return {
    status: resolution.status,
    source: {
      source: "cursor-cli-auth",
      path,
      status: resolution.status,
    },
  };
}

async function readCliCredentialState(
  options: ProviderOptions,
  presenceOnly = false,
): Promise<CredentialState> {
  const state = await readCursorCliCredentialState(options, presenceOnly);
  if (state.status !== "available") return state;
  return {
    status: "available",
    // Keychain-sourced requests keep the editor header set: the dashboard
    // endpoint accepts this bearer without the x-cursor-* CLI headers.
    credentials: {
      accessToken: state.accessToken,
      email: state.identity.email,
      clientType: "editor",
    },
    source: state.source,
  };
}

async function readCursorStateValue(key: string): Promise<string | undefined> {
  const output = await execFileText(
    "sqlite3",
    [
      "-readonly",
      STATE_DB,
      `select value from ItemTable where key = '${key.replace(/'/g, "''")}' limit 1;`,
    ],
    SQLITE_TIMEOUT_MS,
  );
  const value = output.trim();
  if (value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
  } catch {
    return value;
  }
}

function cursorStateDbPath(): string {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function parseEpochMillisOrIso(value: unknown): string | undefined {
  const number = numberValue(value);
  if (number !== undefined) {
    return new Date(
      number > 10_000_000_000 ? number : number * 1000,
    ).toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parseEpochMillisOrIso(parsed);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sqliteErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /no such file|unable to open database/i.test(message)
    ? "credentials_missing"
    : "sqlite_read_error";
}

function cursorCredentialError(
  state: Exclude<CredentialState, { status: "available" }>,
): string {
  return state.source.error ?? `credentials_${state.status}`;
}

function cursorFinalError(
  state: Exclude<CredentialState, { status: "available" }>,
  error: string,
): string {
  return state.status === "missing" || error === "credentials_missing"
    ? "Cursor sign-in required"
    : error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Cursor quota request timed out";
  return error instanceof Error ? error.message : "Cursor quota unavailable";
}

function cursorSuccess(
  quota: Awaited<ReturnType<typeof fetchCursorUsage>>,
  attempts: SourceAttempt[],
): ProviderQuota {
  return successProvider({
    provider: "cursor",
    label: "Cursor",
    source: "api",
    plan: quota.plan,
    account: quota.account,
    windows: quota.windows,
    credits: quota.credits,
    refreshedAt: quota.refreshedAt,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

class CursorAuthError extends Error {
  constructor() {
    super("Cursor sign-in required");
  }
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Cursor quota endpoint rate limited");
  }
}
