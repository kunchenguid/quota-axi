import { readCachedProvider } from "../cache.js";
import { nowIso, parseEpochOrIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { readProviderCredential, credentialSource } from "./credential.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";

const BASE_URL = "https://api.commandcode.ai";
const KEY = "COMMANDCODE_API_KEY";

export const commandcodeAdapter: ProviderAdapter = {
  id: "commandcode",
  label: "Command Code",
  fetchQuota,
  inspectAuth,
};

type Limit = {
  used?: number;
  cap?: number;
  exceeded?: boolean;
  resetAt?: number;
};
type Credits = {
  credits?: {
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
  };
  windowLimits?: { fiveHour?: Limit; weekly?: Limit };
};
type Summary = { totalMonthlyCredits?: number };

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const credential = await readProviderCredential(
    KEY,
    options.allowKeychainPrompt,
  );
  if (!credential) {
    attempts.push({
      source: "env/keychain",
      status: "skipped",
      error: "credential_missing",
    });
    const cached = readCachedProvider("commandcode");
    if (cached)
      return staleFromCache(
        cached,
        "Command Code credentials unavailable",
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "commandcode",
      label: "Command Code",
      status: "auth_required",
      error: `${KEY} is not available`,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  attempts.push({ source: "api", status: "failed" });
  try {
    const credits = await fetchJSON<Credits>(
      `${BASE_URL}/alpha/billing/credits`,
      credential.value,
    );
    let summary: Summary | undefined;
    try {
      summary = await fetchJSON<Summary>(
        `${BASE_URL}/alpha/usage/summary`,
        credential.value,
      );
    } catch {
      /* credits remain authoritative */
    }
    attempts[0] = { source: "api", status: "success" };
    const windows: QuotaWindow[] = [];
    for (const [id, limit] of [
      ["five_hour", credits.windowLimits?.fiveHour],
      ["weekly", credits.windowLimits?.weekly],
    ] as const) {
      if (limit?.cap && Number.isFinite(limit.used))
        windows.push(
          withRemaining({
            id,
            label: id,
            kind: id === "weekly" ? "weekly" : "session",
            percentUsed: ((limit.used ?? 0) / limit.cap) * 100,
            resetsAt: parseEpochOrIso(limit.resetAt),
          }),
        );
    }
    const remaining = finite(credits.credits?.monthlyCredits);
    const spent = finite(summary?.totalMonthlyCredits);
    const total = remaining + spent;
    if (total > 0)
      windows.push(
        withRemaining({
          id: "credit_pool",
          label: "credit pool",
          kind: "credits",
          percentUsed: (spent / total) * 100,
        }),
      );
    return successProvider({
      provider: "commandcode",
      label: "Command Code",
      source: "api",
      windows,
      credits: { remaining, unit: "credits" },
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[0] = { source: "api", status: "failed", error: message };
    const cached = readCachedProvider("commandcode");
    if (cached)
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    return failedProvider({
      provider: "commandcode",
      label: "Command Code",
      source: "api",
      status: statusFromError(message),
      error: message,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const credential = await readProviderCredential(
    KEY,
    options.allowKeychainPrompt,
  );
  return {
    provider: "commandcode",
    sources: [credentialSource(KEY, credential, options.allowKeychainPrompt)],
  };
}

async function fetchJSON<T>(url: string, key: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Command Code HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
