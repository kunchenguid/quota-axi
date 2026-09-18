import { homedir } from "node:os";
import { join } from "node:path";
import { providerFetch } from "../lib/http.js";
import { execFileText, commandExists } from "../lib/process.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderAuthStatus,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";
import {
  isCursorCliSourceSupported,
  readCursorCliCredentialState,
} from "./cursor-cli-credential.js";
import { selectCredential } from "./credential-selection.js";
import {
  createPiCursorCredentialBroker,
  type PiCursorCredentialInspection,
  type PiCursorCredentialResolution,
} from "./pi-cursor-credential.js";

const API_URL = "https://api2.cursor.sh";
const API_TIMEOUT_MS = 15_000;
const SQLITE_TIMEOUT_MS = 5_000;
const STATE_DB = cursorStateDbPath();

type CursorCredentials = {
  accessToken: string;
  email?: string;
  membershipType?: string;
};

type AvailableCredentialState =
  | {
      status: "available";
      localState: "valid";
      credentials: CursorCredentials;
      source: AuthSourceReport;
    }
  | {
      status: "expired";
      localState: "expired";
      credentials: CursorCredentials;
      source: AuthSourceReport;
      refreshable: boolean;
    };

type UnavailableCredentialState = {
  status: "missing" | "invalid" | "skipped" | "error";
  source: AuthSourceReport;
};

type CredentialState = AvailableCredentialState | UnavailableCredentialState;

const PI_CURSOR_CREDENTIAL_SOURCE = "pi:cursor";
/** Existing non-prompting/editor and CLI precedence remains authoritative. */
export const CURSOR_CREDENTIAL_SOURCE_ORDER = [
  "state-vscdb",
  "cursor-cli",
  PI_CURSOR_CREDENTIAL_SOURCE,
] as const;

const piCursorBroker = createPiCursorCredentialBroker();

export const cursorAdapter: ProviderAdapter = {
  id: "cursor",
  label: "Cursor",
  fetchQuota,
  inspectAuth,
};

/**
 * Cursor's editor, platform CLI, and Pi stores are independent. They stay in a
 * fixed ownership/stability order; stored expiry only describes one source and
 * never moves Pi ahead of an existing source. A 401/403 hands over, while a
 * transport, policy, decoding, rate-limit, or server failure stops the run so
 * it cannot turn into a false sign-out against a sibling credential.
 */
export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const unavailable: UnavailableCredentialState[] = [];
  let finalError = "Cursor quota unavailable";
  let retryAfter: string | undefined;
  let rejected = false;
  let rejectedExpiredRefreshable = false;

  for (const source of CURSOR_CREDENTIAL_SOURCE_ORDER) {
    if (source === "cursor-cli" && !isCursorCliSourceSupported()) continue;
    const state = await resolveCredentialSource(source, options);
    if (state.status !== "available" && state.status !== "expired") {
      unavailable.push(state);
      attempts.push(unavailableAttempt(state));
      continue;
    }

    // One candidate per shared-selection call preserves source order even for
    // a stored-expired Pi OAuth token; the endpoint remains the verdict.
    const selection = await selectCredential(
      [
        {
          source: state.source.source,
          localState: state.localState,
          credential: state.credentials,
          ...(state.status === "expired" && state.refreshable
            ? { refreshable: true }
            : {}),
        },
      ],
      async (candidate) => {
        attempts.push({ source: state.source.source, status: "failed" });
        try {
          const quota = await fetchCursorUsage(candidate.credential);
          attempts[attempts.length - 1] = {
            source: source === "state-vscdb" ? "api" : state.source.source,
            status: "success",
          };
          return { kind: "quota" as const, result: quota };
        } catch (error) {
          const message = credentialSafeErrorMessage(
            error,
            candidate.credential.accessToken,
          );
          const definitiveAuth = error instanceof CursorAuthError;
          attempts[attempts.length - 1] = {
            source:
              source === "state-vscdb" && !definitiveAuth
                ? "api"
                : state.source.source,
            status: "failed",
            error: message,
          };
          if (error instanceof RateLimitError) {
            return {
              kind: "transient" as const,
              error: message,
              retryAfter: error.retryAfter,
            };
          }
          return definitiveAuth
            ? { kind: "rejected" as const, error: message }
            : { kind: "transient" as const, error: message };
        }
      },
    );

    if (selection.outcome === "quota" && selection.result) {
      return cursorSuccess(selection.result, attempts);
    }
    if (selection.outcome === "transient") {
      finalError = selection.transientError ?? finalError;
      retryAfter = selection.retryAfter;
      return cursorFailureReport(finalError, retryAfter, attempts);
    }
    if (selection.outcome === "all_rejected") {
      rejected = true;
      rejectedExpiredRefreshable ||=
        state.status === "expired" && state.refreshable;
    }
  }

  let authStatus: ProviderAuthStatus | undefined;
  if (rejectedExpiredRefreshable) {
    finalError = "Cursor Pi access token expired";
    authStatus = "expired_refreshable";
  } else if (rejected) {
    finalError = "Cursor sign-in required";
    authStatus = "unusable";
  } else {
    const primary = primaryUnavailable(unavailable);
    finalError = cursorFinalError(primary, cursorCredentialError(primary));
    if (finalError === "Cursor sign-in required") authStatus = "unusable";
  }

  return cursorFailureReport(finalError, retryAfter, attempts, authStatus);
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
  let piInspection: PiCursorCredentialInspection;
  try {
    piInspection = await piCursorBroker.inspect();
  } catch {
    piInspection = {
      path: "",
      status: "error",
      error: "credential_resolution_failed",
    };
  }
  sources.push(piInspectionSource(piInspection));
  return { provider: "cursor", sources };
}

async function resolveCredentialSource(
  source: (typeof CURSOR_CREDENTIAL_SOURCE_ORDER)[number],
  options: ProviderOptions,
): Promise<CredentialState> {
  if (source === "state-vscdb") return readCredentialState();
  if (source === "cursor-cli") return readCliCredentialState(options);
  let resolution: PiCursorCredentialResolution;
  try {
    resolution = await piCursorBroker.resolve();
  } catch {
    resolution = { status: "error" };
  }
  if (resolution.status === "available") {
    return {
      status: "available",
      localState: "valid",
      credentials: { accessToken: resolution.credential },
      source: {
        source: PI_CURSOR_CREDENTIAL_SOURCE,
        status: "available",
        credentialPresent: true,
      },
    };
  }
  if (resolution.status === "expired") {
    return {
      status: "expired",
      localState: "expired",
      credentials: { accessToken: resolution.credential },
      refreshable: resolution.refreshable,
      source: {
        source: PI_CURSOR_CREDENTIAL_SOURCE,
        status: "expired",
        credentialPresent: true,
      },
    };
  }
  return {
    status: resolution.status === "unsupported" ? "invalid" : resolution.status,
    source: {
      source: PI_CURSOR_CREDENTIAL_SOURCE,
      status:
        resolution.status === "unsupported" ? "invalid" : resolution.status,
      error: piResolutionError(resolution),
      ...(resolution.status === "missing" ? {} : { credentialPresent: true }),
    },
  };
}

/** Prefer a known-present source's actionable failure over an absent store. */
function primaryUnavailable(
  states: UnavailableCredentialState[],
): UnavailableCredentialState {
  return (
    states.find((state) => state.source.credentialPresent === true) ?? states[0]
  );
}

function unavailableAttempt(state: UnavailableCredentialState): SourceAttempt {
  return {
    source: state.source.source,
    status: state.status === "error" ? "failed" : "skipped",
    error: cursorCredentialError(state),
    ...(state.source.credentialPresent === undefined
      ? {}
      : { credentialPresent: state.source.credentialPresent }),
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
    localState: "valid",
    credentials: {
      accessToken: state.accessToken,
      email: state.identity.email,
    },
    source: state.source,
  };
}

function piInspectionSource(
  inspection: PiCursorCredentialInspection,
): AuthSourceReport {
  const status: AuthSourceReport["status"] =
    inspection.status === "unsupported" ? "invalid" : inspection.status;
  return {
    source: PI_CURSOR_CREDENTIAL_SOURCE,
    ...(inspection.path ? { path: inspection.path } : {}),
    status,
    ...(inspection.error ? { error: inspection.error } : {}),
    ...(inspection.status === "missing" ? {} : { credentialPresent: true }),
  };
}

function piResolutionError(
  resolution: Exclude<
    PiCursorCredentialResolution,
    { status: "available" | "expired" }
  >,
): string {
  if (resolution.status === "missing") return "credentials_missing";
  if (resolution.status === "invalid") return "invalid_credential";
  if (resolution.status === "unsupported") return "unsupported_credential_type";
  return "credential_resolution_failed";
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
      localState: "valid",
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

function cursorCredentialError(state: UnavailableCredentialState): string {
  return state.source.error ?? `credentials_${state.status}`;
}

function cursorFinalError(
  state: UnavailableCredentialState,
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

function cursorFailureReport(
  error: string,
  retryAfter: string | undefined,
  attempts: SourceAttempt[],
  authStatus?: ProviderAuthStatus,
): ProviderQuota {
  const report = failedProvider({
    provider: "cursor",
    label: "Cursor",
    status: retryAfter
      ? "rate_limited"
      : authStatus === "expired_refreshable"
        ? "unavailable"
        : statusFromError(error),
    error,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  if (!authStatus) return report;
  return {
    ...report,
    state: {
      ...report.state,
      authStatus,
      ...(authStatus === "expired_refreshable"
        ? { reason: "credentials_expired" as const }
        : {}),
    },
  };
}

function credentialSafeErrorMessage(
  error: unknown,
  credential: string,
): string {
  return errorMessage(error).replaceAll(credential, "[redacted]");
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
