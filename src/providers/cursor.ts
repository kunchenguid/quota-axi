import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider, retireCachedSlot } from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { traceInput } from "../lib/input-trace.js";
import { execFileText, commandExists } from "../lib/process.js";
import {
  calendarMonthsBefore,
  clampPercent,
  nowIso,
  retryAfterToIso,
} from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAccount,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleUnlessSignOut,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";
import {
  CURSOR_CLI_AUTHFILE_SOURCE,
  CURSOR_CLI_SOURCE,
  cursorCliConfigPath,
  isCursorCliSourceSupported,
  readCursorCliCredentialState,
  readCursorCliIdentity,
} from "./cursor-cli-credential.js";

const API_URL = "https://api2.cursor.sh";
const API_TIMEOUT_MS = 15_000;
const SQLITE_TIMEOUT_MS = 5_000;
const STATE_DB = cursorStateDbPath();

/**
 * When the editor and CLI are signed in to different accounts, each becomes
 * its own lane under these keys. They are stable store identities (like Codex's
 * `codex-home`), not a credential digest: there is exactly one editor store and
 * one CLI store on a machine, so the key names the lane, and a separate cache
 * slot per key is what keeps one account's windows from answering for the other.
 */
const CURSOR_EDITOR_ACCOUNT_KEY = "cursor-editor";
const CURSOR_CLI_ACCOUNT_KEY = "cursor-cli";

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
  discoverAccounts: discoverCursorAccounts,
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
          if (cliState.source.credentialPresent === true) {
            finalError = cursorFinalError(
              cliState,
              cursorCredentialError(cliState),
            );
          }
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
  const stale = staleUnlessSignOut(
    cached,
    finalError,
    sourceNames(attempts),
    attempts,
    {
      definitive: finalError === "Cursor sign-in required",
      retire: () => retireCachedSlot("cursor"),
    },
  );
  if (stale) return stale;

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
 * The editor (`state.vscdb`) and the `cursor-agent` CLI (identity in
 * `cli-config.json`, token in the login Keychain or `auth.json`) are separate
 * sign-ins that can be different accounts. When both logins are present and
 * their emails differ, quota is reported as two account lanes so a team login
 * is never hidden behind a personal one: the editor keeps its own lane and the
 * CLI becomes a lane beside it. Each lane reads only its own store and caches
 * under its own account key, so one account's windows never stand in for the
 * other's. When the identities match, or either is unknown, there is nothing
 * to split and Cursor keeps its single selected account, read exactly as
 * before.
 *
 * The comparison reads only `cursorAuth/cachedEmail` and `cli-config.json`
 * `authInfo.email`; it never reads a token, prompts, or calls the API. On Linux
 * the CLI credential carries no identity, so no split is ever established there
 * and the single-lane path is kept.
 */
async function discoverCursorAccounts(
  _options?: ProviderOptions,
  _operation?: "quota" | "auth",
): Promise<ProviderAccount[] | undefined> {
  if (!isCursorCliSourceSupported()) return undefined;
  const editorEmail = await readEditorEmail();
  const cliEmail = readCliIdentityEmail();
  if (!editorEmail || !cliEmail) return undefined;
  if (normalizeEmail(editorEmail) === normalizeEmail(cliEmail))
    return undefined;
  return [editorLaneAccount(), cliLaneAccount()];
}

function editorLaneAccount(): ProviderAccount {
  return {
    accountKey: CURSOR_EDITOR_ACCOUNT_KEY,
    fetchQuota: (options) => fetchLaneQuota("editor", options),
    inspectAuth: (options) => inspectLaneAuth("editor", options),
  };
}

function cliLaneAccount(): ProviderAccount {
  return {
    accountKey: CURSOR_CLI_ACCOUNT_KEY,
    fetchQuota: (options) => fetchLaneQuota("cli", options),
    inspectAuth: (options) => inspectLaneAuth("cli", options),
  };
}

/** The editor sign-in's cached email, or undefined when it cannot be read. */
async function readEditorEmail(): Promise<string | undefined> {
  const state = await readCredentialState();
  return state.status === "available" ? state.credentials.email : undefined;
}

/**
 * The CLI sign-in's email, read from the identity file the CLI credential
 * itself uses (so the comparison matches the store the CLI lane will read). The
 * Linux auth file carries no identity, so no comparison is made there.
 */
function readCliIdentityEmail(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = readCursorCliIdentity(cursorCliConfigPath());
  return result.status === "present" ? result.identity.email : undefined;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * One lane's reading: its own credential store, its own cache slot, and no
 * fallback to the sibling's store - a rejected editor token is this lane's auth
 * error, not a reason to report the CLI's account as the editor's.
 */
async function fetchLaneQuota(
  lane: "editor" | "cli",
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const accountKey =
    lane === "editor" ? CURSOR_EDITOR_ACCOUNT_KEY : CURSOR_CLI_ACCOUNT_KEY;
  const retire = () => retireCachedSlot("cursor", accountKey);
  const attempts: SourceAttempt[] = [];
  const state =
    lane === "editor"
      ? await readCredentialState()
      : await readCliCredentialState(options);
  if (state.status !== "available") {
    attempts.push({
      source: state.source.source,
      status: "skipped",
      error: cursorCredentialError(state),
      ...(state.source.credentialPresent === undefined
        ? {}
        : { credentialPresent: state.source.credentialPresent }),
    });
    return laneFailure(
      accountKey,
      cursorFinalError(state, cursorCredentialError(state)),
      undefined,
      attempts,
      retire,
    );
  }
  // The editor fetch keeps its established `api` attempt name; a CLI fetch is
  // named for its credential store so `sourcesTried` shows which store answered.
  const quotaSource = lane === "editor" ? "api" : state.source.source;
  attempts.push({ source: quotaSource, status: "failed" });
  try {
    const quota = await fetchCursorUsage(state.credentials);
    attempts[attempts.length - 1] = { source: quotaSource, status: "success" };
    return cursorSuccess(quota, attempts);
  } catch (error) {
    const finalError = errorMessage(error);
    attempts[attempts.length - 1] = {
      source: quotaSource,
      status: "failed",
      error: finalError,
    };
    const retryAfter =
      error instanceof RateLimitError ? error.retryAfter : undefined;
    return laneFailure(accountKey, finalError, retryAfter, attempts, retire);
  }
}

function laneFailure(
  accountKey: string,
  finalError: string,
  retryAfter: string | undefined,
  attempts: SourceAttempt[],
  retire: () => void,
): ProviderQuota {
  const cached = readCachedProvider("cursor", accountKey);
  const stale = staleUnlessSignOut(
    cached,
    finalError,
    sourceNames(attempts),
    attempts,
    {
      definitive: finalError === "Cursor sign-in required",
      retire,
    },
  );
  if (stale) return stale;
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

/**
 * One lane's credential sources. The CLI lane never forces a Keychain prompt
 * here: `auth` reports the state it finds on disk (so a granted marker reads as
 * available), and the gated one-time value read belongs to the lane's quota
 * fetch, not to a describe-only pass.
 */
async function inspectLaneAuth(
  lane: "editor" | "cli",
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  if (lane === "editor") {
    const editorState = await readCredentialState();
    return { provider: "cursor", sources: [editorState.source] };
  }
  const cliState = await readCliCredentialState({
    ...options,
    allowKeychainPrompt: false,
  });
  return { provider: "cursor", sources: [cliState.source] };
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
    // Without sqlite3 the database cannot be opened, so only the file's
    // existence can say whether an editor sign-in might be there; an absent
    // database must not hold back a sign-out verdict from the CLI source.
    traceInput(STATE_DB);
    if (stateDbAbsent()) {
      return {
        status: "missing",
        source: { source: "state-vscdb", path: STATE_DB, status: "missing" },
      };
    }
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

/**
 * Only a missing entry counts as absent: a path that cannot be checked (for
 * example EACCES on a parent directory) may still hold an editor sign-in, and
 * `existsSync` would misreport it as absent and retire a live login's cache.
 */
function stateDbAbsent(): boolean {
  try {
    return statSync(STATE_DB, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
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
  return cycleEnd === undefined ? undefined : calendarMonthsBefore(cycleEnd, 1);
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
