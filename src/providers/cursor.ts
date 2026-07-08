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

const API_URL = "https://api2.cursor.sh";
const API_TIMEOUT_MS = 15_000;
const SQLITE_TIMEOUT_MS = 5_000;
const STATE_DB = cursorStateDbPath();

type CursorCredentials = {
  accessToken: string;
  email?: string;
  membershipType?: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: CursorCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid" | "skipped"; source: AuthSourceReport };

export const cursorAdapter: ProviderAdapter = {
  id: "cursor",
  label: "Cursor",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;
  let retryAfter: string | undefined;

  const credentialState = await readCredentialState();
  if (credentialState.status === "available") {
    attempts.push({ source: "api", status: "failed" });
    try {
      const quota = await fetchCursorUsage(credentialState.credentials);
      attempts[attempts.length - 1] = { source: "api", status: "success" };
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
    } catch (error) {
      finalError = errorMessage(error);
      attempts[attempts.length - 1] = {
        source: "api",
        status: "failed",
        error: finalError,
      };
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
    }
  } else {
    attempts.push({
      source: credentialState.source.source,
      status: "skipped",
      error: `credentials_${credentialState.status}`,
    });
    finalError = "Cursor sign-in required";
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
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const credentialState = await readCredentialState();
  return { provider: "cursor", sources: [credentialState.source] };
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
    postDashboardRpc(credentials.accessToken, "GetCurrentPeriodUsage"),
    postDashboardRpc(credentials.accessToken, "GetPlanInfo").catch(
      () => undefined,
    ),
  ]);
  const quota = normalizeCursorUsage(usage, planInfo, credentials);
  if (!quota) throw new Error("Cursor quota unavailable");
  return quota;
}

async function postDashboardRpc(
  accessToken: string,
  method: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(
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
    throw new Error("Cursor sign-in required");
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
      credentials: { accessToken, email, membershipType },
      source: { source: "state-vscdb", path: STATE_DB, status: "available" },
    };
  } catch (error) {
    return {
      status: "invalid",
      source: {
        source: "state-vscdb",
        path: STATE_DB,
        status: "invalid",
        error: sqliteErrorMessage(error),
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
  return value.length > 0 ? value : undefined;
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
    homedir(),
    ".config",
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Cursor quota request timed out";
  return error instanceof Error ? error.message : "Cursor quota unavailable";
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Cursor quota endpoint rate limited");
  }
}
