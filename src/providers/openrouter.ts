import { readCachedProvider } from "../cache.js";
import { nowIso } from "../lib/time.js";
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

const BASE_URL = "https://openrouter.ai/api/v1";
const KEY = "OPENROUTER_API_KEY";
const TIMEOUT_MS = 15_000;

export const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",
  label: "OpenRouter",
  fetchQuota,
  inspectAuth,
};

type CreditsResponse = {
  data?: { total_credits?: number; total_usage?: number };
};
type KeyResponse = {
  data?: {
    usage?: number;
    limit?: number;
    limit_remaining?: number;
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
  };
};

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
    const cached = readCachedProvider("openrouter");
    if (cached)
      return staleFromCache(
        cached,
        "OpenRouter credentials unavailable",
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "openrouter",
      label: "OpenRouter",
      status: "auth_required",
      error: `${KEY} is not available`,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  attempts.push({ source: "api", status: "failed" });
  try {
    const [credits, key] = await Promise.all([
      fetchJSON<CreditsResponse>(`${BASE_URL}/credits`, credential.value),
      fetchJSON<KeyResponse>(`${BASE_URL}/auth/key`, credential.value),
    ]);
    attempts[0] = { source: "api", status: "success" };
    const total = finite(credits.data?.total_credits);
    const spent = finite(credits.data?.total_usage);
    const windows: QuotaWindow[] = [];
    for (const [id, value] of [
      ["daily", key.data?.usage_daily],
      ["weekly", key.data?.usage_weekly],
      ["monthly", key.data?.usage_monthly],
    ] as const) {
      if (value !== undefined && Number.isFinite(value))
        windows.push(
          withRemaining({
            id,
            label: id,
            kind:
              id === "monthly"
                ? "monthly"
                : id === "weekly"
                  ? "weekly"
                  : "unknown",
            percentUsed: value,
          }),
        );
    }
    if (total > 0)
      windows.push(
        withRemaining({
          id: "credit_pool",
          label: "credit pool",
          kind: "credits",
          percentUsed: Math.min(100, (spent / total) * 100),
        }),
      );
    return successProvider({
      provider: "openrouter",
      label: "OpenRouter",
      source: "api",
      windows,
      credits: { remaining: Math.max(0, total - spent), unit: "usd" },
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[0] = { source: "api", status: "failed", error: message };
    const cached = readCachedProvider("openrouter");
    if (cached)
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    return failedProvider({
      provider: "openrouter",
      label: "OpenRouter",
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
    provider: "openrouter",
    sources: [credentialSource(KEY, credential, options.allowKeychainPrompt)],
  };
}

async function fetchJSON<T>(url: string, key: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
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
