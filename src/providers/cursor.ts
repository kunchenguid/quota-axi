import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { providerFetch } from "../lib/http.js";
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
  CURSOR_CLI_AUTHFILE_SOURCE,
  CURSOR_CLI_SOURCE,
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
};

type UnavailableCredentialState = {
  status: "missing" | "invalid" | "skipped";
  source: AuthSourceReport;
};

type CredentialState =
  | {
      status: "available";
      credentials: CursorCredentials;
      source: AuthSourceReport;
    }
  | UnavailableCredentialState;

export const cursorAdapter: ProviderAdapter = {
  id: "cursor",
  label: "Cursor",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;
  let retryAfter: string | undefined;

  const resolution = await resolveCredentials(options);
  for (const state of resolution.unavailable) {
    attempts.push({
      source: state.source.source,
      status: "skipped",
      error: cursorCredentialError(state),
      ...(state.source.credentialPresent === undefined
        ? {}
        : { credentialPresent: state.source.credentialPresent }),
    });
  }

  if (resolution.credentials) {
    // The editor-credential fetch keeps its established `api` attempt name; a
    // CLI-resolved fetch is named for its credential store so `sourcesTried`
    // shows which CLI store, not the absent editor store, answered.
    const quotaSource =
      resolution.source === undefined || resolution.source === "state-vscdb"
        ? "api"
        : resolution.source;
    attempts.push({ source: quotaSource, status: "failed" });
    try {
      const quota = await fetchCursorUsage(resolution.credentials);
      attempts[attempts.length - 1] = {
        source: quotaSource,
        status: "success",
      };
      return cursorSuccess(quota, attempts);
    } catch (error) {
      finalError = errorMessage(error);
      attempts[attempts.length - 1] = {
        source: quotaSource,
        status: "failed",
        error: finalError,
      };
      if (
        error instanceof CursorAuthError &&
        resolution.source === "state-vscdb" &&
        isCursorCliSourceSupported()
      ) {
        attempts[attempts.length - 1] = {
          source: "state-vscdb",
          status: "failed",
          error: finalError,
        };
        const cliState = await readCliCredentialState(options);
        if (cliState.status === "available") {
          attempts.push({
            source: cliState.source.source,
            status: "failed",
          });
          try {
            const quota = await fetchCursorUsage(cliState.credentials);
            attempts[attempts.length - 1] = {
              source: cliState.source.source,
              status: "success",
            };
            return cursorSuccess(quota, attempts);
          } catch (cliError) {
            finalError = errorMessage(cliError);
            attempts[attempts.length - 1] = {
              source: cliState.source.source,
              status: "failed",
              error: finalError,
            };
            if (cliError instanceof RateLimitError)
              retryAfter = cliError.retryAfter;
          }
        } else {
          attempts.push({
            source: cliState.source.source,
            status: "skipped",
            error: cursorCredentialError(cliState),
            ...(cliState.source.credentialPresent === undefined
              ? {}
              : { credentialPresent: cliState.source.credentialPresent }),
          });
        }
      } else if (error instanceof RateLimitError) {
        retryAfter = error.retryAfter;
      }
    }
  } else {
    const primary = primaryUnavailable(resolution.unavailable);
    finalError = cursorFinalError(primary, cursorCredentialError(primary));
  }

  const cached = readCachedProvider("cursor");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "cursor",
    label: "Cursor",
    status: retryAfter ? "rate_limited" : statusFromError(finalError),
    error: finalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const editorState = await readCredentialState();
  const sources = [editorState.source];
  if (isCursorCliSourceSupported()) {
    const editorAvailable = editorState.status === "available";
    sources.push(
      (
        await readCliCredentialState(
          editorAvailable
            ? { ...options, allowKeychainPrompt: false }
            : options,
          editorAvailable,
        )
      ).source,
    );
  }
  return { provider: "cursor", sources };
}

/**
 * The Cursor editor and CLI keep credentials in different stores, and either
 * source is enough, so a CLI-only machine with no editor `state.vscdb` can
 * still refresh quota after the CLI credential is available. Quota fetching
 * tries the non-prompting editor store first; it reads the platform CLI
 * credential source when the editor token is absent, unreadable, or rejected
 * by Cursor.
 */
async function resolveCredentials(options: ProviderOptions): Promise<{
  credentials?: CursorCredentials;
  source?:
    | "state-vscdb"
    | typeof CURSOR_CLI_SOURCE
    | typeof CURSOR_CLI_AUTHFILE_SOURCE;
  unavailable: UnavailableCredentialState[];
}> {
  const unavailable: UnavailableCredentialState[] = [];
  const editorState = await readCredentialState();
  if (editorState.status === "available") {
    return {
      credentials: editorState.credentials,
      source: "state-vscdb",
      unavailable,
    };
  }
  unavailable.push(editorState);

  if (!isCursorCliSourceSupported()) return { unavailable };
  const cliState = await readCliCredentialState(options);
  if (cliState.status === "available") {
    return {
      credentials: cliState.credentials,
      source: cliState.source.source as
        | typeof CURSOR_CLI_SOURCE
        | typeof CURSOR_CLI_AUTHFILE_SOURCE,
      unavailable,
    };
  }
  unavailable.push(cliState);
  return { unavailable };
}

/**
 * A CLI-only machine has no editor store at all, so reporting the editor's
 * `credentials_missing` would tell a signed-in `cursor-agent` user to sign in
 * again. Prefer a source that still holds a credential - a Keychain value read
 * waiting on the one-time prompt - so the error carries its actual remedy.
 */
function primaryUnavailable(
  states: UnavailableCredentialState[],
): UnavailableCredentialState {
  return (
    states.find((state) => state.source.credentialPresent === true) ?? states[0]
  );
}

async function readCliCredentialState(
  options: ProviderOptions,
  presenceOnly = false,
): Promise<CredentialState> {
  const state = await readCursorCliCredentialState(options, presenceOnly);
  if (state.status !== "available") return state;
  return {
    status: "available",
    credentials: {
      accessToken: state.accessToken,
      email: state.identity.email,
    },
    source: state.source,
  };
}

export function normalizeCursorUsage(
  usage: unknown,
  planInfo?: unknown,
  credentials?: Pick<CursorCredentials, "email" | "membershipType">,
  sandUsage?: unknown,
):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  const data = objectValue(usage) ?? {};
  const planData = objectValue(planInfo);
  const plan = objectValue(planData?.planInfo);
  const planName =
    stringValue(plan?.planName) ??
    stringValue(plan?.price) ??
    credentials?.membershipType;
  const reset =
    parseEpochMillisOrIso(data.billingCycleEnd) ??
    parseEpochMillisOrIso(plan?.billingCycleEnd);
  const cycleStart = billingCycleStart(data, plan, reset);
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
        ...(cycleStart !== undefined ? { startsAt: cycleStart } : {}),
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
        ...(cycleStart !== undefined ? { startsAt: cycleStart } : {}),
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
        ...(cycleStart !== undefined ? { startsAt: cycleStart } : {}),
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

  const grokBot = grokBotWindow(sandUsage);
  if (grokBot !== undefined) windows.push(grokBot);

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
  const [usageResult, planResult, sandResult] = await Promise.allSettled([
    postDashboardRpc(credentials.accessToken, "GetCurrentPeriodUsage"),
    postDashboardRpc(credentials.accessToken, "GetPlanInfo"),
    postDashboardRpc(credentials.accessToken, "GetSandUsageStatus"),
  ]);
  if (usageResult.status === "rejected") {
    throw usageResult.reason;
  }
  const quota = normalizeCursorUsage(
    usageResult.value,
    planResult.status === "fulfilled" ? planResult.value : undefined,
    credentials,
    sandResult.status === "fulfilled" ? sandResult.value : undefined,
  );
  if (!quota) {
    throw new Error("Cursor quota unavailable");
  }
  return quota;
}

async function postDashboardRpc(
  accessToken: string,
  method: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await providerFetch(
      `${API_URL}/aiserver.v1.DashboardService/${method}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "content-type": "application/json",
          "connect-protocol-version": "1",
        },
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
        credentialPresent: true,
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
      credentials: { accessToken, email, membershipType },
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
        credentialPresent: true,
      },
    };
  }
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

/**
 * Grok Bot weekly usage is a separate Cursor-account meter from the IDE
 * monthly pools. The first-party DashboardService GetSandUsageStatus RPC
 * reports it; enterprise pooled allowances and missing percents stay absent.
 */
function grokBotWindow(sandUsage: unknown): QuotaWindow | undefined {
  const data = objectValue(sandUsage);
  if (!data) return undefined;
  if (
    booleanValue(
      pick(
        data,
        "usesPooledEnterpriseAllowance",
        "uses_pooled_enterprise_allowance",
      ),
    ) === true
  ) {
    return undefined;
  }
  const percent = numberValue(pick(data, "usagePercent", "usage_percent"));
  if (percent === undefined) return undefined;
  const startsAt = parseEpochMillisOrIso(
    pick(data, "currentPeriodStart", "current_period_start"),
  );
  const resetsAt = parseEpochMillisOrIso(
    pick(data, "nextResetTimestampUtc", "next_reset_timestamp_utc"),
  );
  return withRemaining({
    id: "grok_bot",
    label: "Grok Bot",
    kind: "weekly",
    percentUsed: clampPercent(percent),
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  });
}

/**
 * Cursor's included/auto/API pools reset once per monthly billing cycle on the
 * subscription renewal date, so the cycle start is the previous renewal, not a
 * fixed 30-day span before the reset. Prefer an explicit cycle-start field when
 * the payload carries one; otherwise step the renewal date back one calendar
 * month. Without either field the window keeps no trusted cycle.
 */
function billingCycleStart(
  data: Record<string, unknown>,
  plan: Record<string, unknown> | undefined,
  cycleEnd: string | undefined,
): string | undefined {
  const reported =
    parseEpochMillisOrIso(data.billingCycleStart) ??
    parseEpochMillisOrIso(plan?.billingCycleStart);
  if (reported !== undefined) return reported;
  return cycleEnd === undefined ? undefined : previousCalendarMonth(cycleEnd);
}

/**
 * The same civil (UTC) date one month earlier, clamped to the last day of that
 * month when the day does not exist there (a 31st renewal lands on Feb 28/29).
 */
function previousCalendarMonth(iso: string): string | undefined {
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return undefined;
  const month = end.getUTCMonth();
  const year = month === 0 ? end.getUTCFullYear() - 1 : end.getUTCFullYear();
  const targetMonth = month === 0 ? 11 : month - 1;
  const daysInTargetMonth = new Date(
    Date.UTC(year, targetMonth + 1, 0),
  ).getUTCDate();
  const start = new Date(end.getTime());
  start.setUTCFullYear(
    year,
    targetMonth,
    Math.min(end.getUTCDate(), daysInTargetMonth),
  );
  return Number.isNaN(start.getTime()) ? undefined : start.toISOString();
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

function pick(
  data: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return data[camel] !== undefined ? data[camel] : data[snake];
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
