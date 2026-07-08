import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import {
  clampPercent,
  nowIso,
  percentRemaining,
  retryAfterToIso,
} from "../lib/time.js";
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
} from "./common.js";

const USER_URL = "https://api.github.com/copilot_internal/user";
const API_TIMEOUT_MS = 15_000;

type CopilotCredentials = {
  oauthToken: string;
  login?: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: CopilotCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

export const copilotAdapter: ProviderAdapter = {
  id: "copilot",
  label: "GitHub Copilot",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;
  let retryAfter: string | undefined;

  const credentialState = readCredentialState();
  if (credentialState.status === "available") {
    attempts.push({ source: "api", status: "failed" });
    try {
      const quota = await fetchCopilotUser(credentialState.credentials);
      attempts[attempts.length - 1] = { source: "api", status: "success" };
      return successProvider({
        provider: "copilot",
        label: "GitHub Copilot",
        source: "api",
        plan: quota.plan,
        account: quota.account,
        windows: quota.windows,
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
      source: "apps-json",
      status: "skipped",
      error: `credentials_${credentialState.status}`,
    });
    finalError = "GitHub Copilot sign-in required";
  }

  const cached = readCachedProvider("copilot");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "copilot",
    label: "GitHub Copilot",
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
  const credentialState = readCredentialState();
  return { provider: "copilot", sources: [credentialState.source] };
}

export function normalizeCopilotUser(raw: unknown):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      refreshedAt: string;
    }
  | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const windows = normalizeQuotaSnapshots(
    objectValue(data.quota_snapshots),
    data.quota_reset_date_utc,
  );
  const plan =
    stringValue(data.copilot_plan) ??
    stringValue(data.access_type_sku) ??
    stringValue(data.sku);
  const accountId = stringValue(data.login);
  if (windows.length === 0 && !plan && !accountId) return undefined;
  return {
    plan,
    account: accountId ? { accountId } : undefined,
    windows,
    refreshedAt: nowIso(),
  };
}

async function fetchCopilotUser(credentials: CopilotCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(USER_URL, {
      headers: {
        authorization: `Bearer ${credentials.oauthToken}`,
        accept: "application/json",
        "user-agent": "GitHubCopilotCLI/1.0",
      },
      signal: controller.signal,
    });
    rejectUnusableUsageResponse(response);
    const quota = normalizeCopilotUser(await response.json());
    if (!quota) throw new Error("GitHub Copilot quota unavailable");
    return quota;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeQuotaSnapshots(
  snapshots: Record<string, unknown> | undefined,
  resetFallback: unknown,
): QuotaWindow[] {
  if (!snapshots) return [];
  const windows: QuotaWindow[] = [];
  for (const [id, value] of Object.entries(snapshots)) {
    const item = objectValue(value);
    if (!item) continue;
    const remaining = numberValue(item.percent_remaining);
    const percentUsed =
      remaining === undefined ? undefined : clampPercent(100 - remaining);
    windows.push({
      id,
      label: id.replace(/_/g, " "),
      kind: "monthly",
      percentUsed,
      percentRemaining:
        remaining === undefined
          ? percentRemaining(percentUsed)
          : clampPercent(remaining),
      resetsAt:
        parseEpochSecondsOrMillis(item.quota_reset_at) ??
        parseEpochSecondsOrMillis(resetFallback),
    });
  }
  return windows;
}

function readCredentialState(authFile = copilotAppsFile()): CredentialState {
  return extractCredentialState(readJsonFileResult(authFile), authFile);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: { source: "apps-json", path, status: "missing" },
    };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: {
        source: "apps-json",
        path,
        status: "invalid",
        error: raw.error,
      },
    };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "invalid",
      source: { source: "apps-json", path, status: "invalid" },
    };
  for (const value of Object.values(data)) {
    const item = objectValue(value);
    const oauthToken = stringValue(item?.oauth_token);
    if (oauthToken) {
      return {
        status: "available",
        credentials: { oauthToken, login: stringValue(item?.user) },
        source: { source: "apps-json", path, status: "available" },
      };
    }
  }
  return {
    status: "invalid",
    source: { source: "apps-json", path, status: "invalid" },
  };
}

function copilotAppsFile(): string {
  return process.env.GITHUB_COPILOT_APPS_JSON
    ? process.env.GITHUB_COPILOT_APPS_JSON
    : join(homedir(), ".config", "github-copilot", "apps.json");
}

function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub Copilot sign-in required");
  }
  if (response.status === 429) {
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  }
  if (!response.ok)
    throw new Error(`GitHub Copilot quota unavailable (${response.status})`);
}

function parseEpochSecondsOrMillis(value: unknown): string | undefined {
  const number = numberValue(value);
  if (number !== undefined) {
    return new Date(
      number > 10_000_000_000 ? number : number * 1000,
    ).toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parseEpochSecondsOrMillis(parsed);
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "GitHub Copilot quota request timed out";
  return error instanceof Error
    ? error.message
    : "GitHub Copilot quota unavailable";
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("GitHub Copilot quota endpoint rate limited");
  }
}
