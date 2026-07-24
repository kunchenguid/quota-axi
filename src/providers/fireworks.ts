import { readCachedProvider } from "../cache.js";
import { nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { credentialSource, readProviderCredential } from "./credential.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
} from "./common.js";

const KEY = "FIREWORKS_API_KEY";
const BASE = "https://api.fireworks.ai/v1";
export const fireworksAdapter: ProviderAdapter = {
  id: "fireworks",
  label: "Fireworks",
  fetchQuota,
  inspectAuth,
};
type Accounts = { accounts?: { name?: string }[] };
type Billing = {
  serverlessCosts?: { promptTokens?: string; completionTokens?: string }[];
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
    const cached = readCachedProvider("fireworks");
    if (cached)
      return staleFromCache(
        cached,
        `${KEY} unavailable`,
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "fireworks",
      label: "Fireworks",
      status: "auth_required",
      error: `${KEY} is not available`,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  attempts.push({ source: "billing-api", status: "failed" });
  try {
    const accounts = await getJSON<Accounts>(
      `${BASE}/accounts`,
      credential.value,
    );
    const name = accounts.accounts?.[0]?.name;
    if (!name) throw new Error("Fireworks account name unavailable");
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const billing = await getJSON<Billing>(
      `${BASE}/${name}/billingUsage?start_time=${encodeURIComponent(start.toISOString())}&end_time=${encodeURIComponent(end.toISOString())}`,
      credential.value,
    );
    const spent = (billing.serverlessCosts ?? []).reduce(
      (total, item) =>
        total + number(item.promptTokens) + number(item.completionTokens),
      0,
    );
    attempts[0] = { source: "billing-api", status: "success" };
    return successProvider({
      provider: "fireworks",
      label: "Fireworks",
      source: "api",
      windows: [],
      credits: { spent, unit: "credits" },
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
      account: { accountId: name, identityStatus: "verified" },
      plan: `tokens_7d:${spent}`,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[0] = { source: "billing-api", status: "failed", error: message };
    const cached = readCachedProvider("fireworks");
    if (cached)
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    return failedProvider({
      provider: "fireworks",
      label: "Fireworks",
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
    provider: "fireworks",
    sources: [credentialSource(KEY, credential, options.allowKeychainPrompt)],
  };
}
async function getJSON<T>(url: string, key: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Fireworks HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
const number = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
