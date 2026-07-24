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

const KEY = "RUNPOD_API_KEY";
const URL = "https://api.runpod.io/graphql";

export const runpodAdapter: ProviderAdapter = {
  id: "runpod",
  label: "RunPod",
  fetchQuota,
  inspectAuth,
};

type Response = {
  data?: { myself?: { clientBalance?: number; currentSpendPerHr?: number } };
  errors?: { message?: string }[];
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
    const cached = readCachedProvider("runpod");
    if (cached)
      return staleFromCache(
        cached,
        `${KEY} unavailable`,
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "runpod",
      label: "RunPod",
      status: "auth_required",
      error: `${KEY} is not available`,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  attempts.push({ source: "graphql", status: "failed" });
  try {
    const response = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.value}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: "{ myself { clientBalance currentSpendPerHr } }",
      }),
    });
    if (!response.ok) throw new Error(`RunPod HTTP ${response.status}`);
    const body = (await response.json()) as Response;
    if (body.errors?.length)
      throw new Error(body.errors[0]?.message ?? "RunPod GraphQL error");
    const balance = finite(body.data?.myself?.clientBalance);
    attempts[0] = { source: "graphql", status: "success" };
    return successProvider({
      provider: "runpod",
      label: "RunPod",
      source: "api",
      windows: [],
      credits: { remaining: balance, unit: "usd" },
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[0] = { source: "graphql", status: "failed", error: message };
    const cached = readCachedProvider("runpod");
    if (cached)
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    return failedProvider({
      provider: "runpod",
      label: "RunPod",
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
    provider: "runpod",
    sources: [credentialSource(KEY, credential, options.allowKeychainPrompt)],
  };
}

const finite = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
