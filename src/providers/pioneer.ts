import { readCachedProvider } from "../cache.js";
import { nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
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

const URL = "https://api.pioneer.ai/billing/plan-info";
const KEY = "PIONEER_API_KEY";

export const pioneerAdapter: ProviderAdapter = {
  id: "pioneer",
  label: "Pioneer",
  fetchQuota,
  inspectAuth,
};

type Plan = {
  payment_plan?: string;
  credit_limit?: number;
  total_usage?: number;
  remaining_credits?: number;
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
    const cached = readCachedProvider("pioneer");
    if (cached)
      return staleFromCache(
        cached,
        "Pioneer credentials unavailable",
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "pioneer",
      label: "Pioneer",
      status: "auth_required",
      error: `${KEY} is not available`,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  attempts.push({ source: "api", status: "failed" });
  try {
    const plan = await fetchPlan(credential.value);
    attempts[0] = { source: "api", status: "success" };
    const total = finite(plan.credit_limit);
    const spent = finite(plan.total_usage);
    return successProvider({
      provider: "pioneer",
      label: "Pioneer",
      source: "api",
      plan: plan.payment_plan,
      windows:
        total > 0
          ? [
              withRemaining({
                id: "credit_pool",
                label: "credit pool",
                kind: "credits",
                percentUsed: (spent / total) * 100,
              }),
            ]
          : [],
      credits: { remaining: finite(plan.remaining_credits) / 100, unit: "usd" },
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[0] = { source: "api", status: "failed", error: message };
    const cached = readCachedProvider("pioneer");
    if (cached)
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    return failedProvider({
      provider: "pioneer",
      label: "Pioneer",
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
    provider: "pioneer",
    sources: [credentialSource(KEY, credential, options.allowKeychainPrompt)],
  };
}

async function fetchPlan(key: string): Promise<Plan> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Pioneer HTTP ${response.status}`);
    return (await response.json()) as Plan;
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
