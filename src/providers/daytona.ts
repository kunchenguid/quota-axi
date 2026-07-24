import { readCachedProvider } from "../cache.js";
import { nowIso } from "../lib/time.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
const API_KEY = "DAYTONA_API_KEY";
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
  const apiKeyCredential = credential
    ? undefined
    : await readProviderCredential(API_KEY, options.allowKeychainPrompt);
  const configToken =
    credential || apiKeyCredential ? undefined : await readDaytonaConfigToken();
  const token = credential?.value ?? apiKeyCredential?.value ?? configToken;
  if (!token) {
    attempts.push({
      source: "env/keychain",
      status: "skipped",
      error: "credential_missing",
    });
    const cached = readCachedProvider("daytona");
    if (cached)
      return staleFromCache(
        cached,
        `${KEY} and Daytona CLI config unavailable`,
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "daytona",
      label: "Daytona",
      status: "auth_required",
      error: "Daytona credentials unavailable; run `daytona login`",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  attempts.push({ source: "api", status: "failed" });
  try {
    const response = await fetch(URL, {
      headers: {
        Authorization: `Bearer ${token}`,
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
    sources: [
      credentialSource(KEY, credential, options.allowKeychainPrompt),
      credentialSource(API_KEY, credential, options.allowKeychainPrompt),
      {
        source: "daytona-cli-config",
        path: "~/Library/Application Support/daytona/config.json",
        status: (await readDaytonaConfigToken()) ? "available" : "missing",
      },
    ],
  };
}
async function readDaytonaConfigToken(): Promise<string | undefined> {
  try {
    const path = join(
      homedir(),
      "Library",
      "Application Support",
      "daytona",
      "config.json",
    );
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      profiles?: { api?: { token?: { accessToken?: string } } }[];
    };
    const token = raw.profiles?.[0]?.api?.token?.accessToken?.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
