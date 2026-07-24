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

const KEY = "DAYTONA_API_TOKEN";
const URL = "https://app.daytona.io/api/sandbox";
export const daytonaAdapter: ProviderAdapter = {
  id: "daytona",
  label: "Daytona",
  fetchQuota,
  inspectAuth,
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
    const cached = readCachedProvider("daytona");
    if (cached)
      return staleFromCache(
        cached,
        `${KEY} unavailable`,
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "daytona",
      label: "Daytona",
      status: "auth_required",
      error: `${KEY} is not available; run daytona login and export the token`,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  attempts.push({ source: "api", status: "failed" });
  try {
    const response = await fetch(URL, {
      headers: {
        Authorization: `Bearer ${credential.value}`,
        Accept: "application/json",
      },
    });
    if (response.status === 401)
      throw new Error("Daytona token rejected; run daytona login");
    if (!response.ok && response.status !== 403)
      throw new Error(`Daytona HTTP ${response.status}`);
    attempts[0] = { source: "api", status: "success" };
    return successProvider({
      provider: "daytona",
      label: "Daytona",
      source: "api",
      windows: [],
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[0] = { source: "api", status: "failed", error: message };
    const cached = readCachedProvider("daytona");
    if (cached)
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    return failedProvider({
      provider: "daytona",
      label: "Daytona",
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
    provider: "daytona",
    sources: [credentialSource(KEY, credential, options.allowKeychainPrompt)],
  };
}
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
