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

const KEY = "DAYTONA_API_KEY";
const LEGACY_KEY = "DAYTONA_API_TOKEN";
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
  const legacyCredential = credential
    ? undefined
    : await readProviderCredential(LEGACY_KEY, options.allowKeychainPrompt);
  const configAuth =
    credential || legacyCredential ? undefined : await readDaytonaConfigToken();
  const token =
    credential?.value ?? legacyCredential?.value ?? configAuth?.token;
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
    const organizationId =
      !credential && !legacyCredential ? configAuth?.organizationId : undefined;
    // Daytona API keys authenticate with the bearer token alone. Browser
    // login stores a short-lived JWT, which additionally requires the active
    // organization header documented by Daytona's API-key/JWT contract.
    const response = await fetch(URL, {
      headers: buildDaytonaHeaders(token, organizationId),
    });
    if (response.status === 401) {
      const remedy =
        credential || legacyCredential
          ? "rotate DAYTONA_API_KEY and run `bridge secrets refresh`"
          : "run `daytona login` to refresh the JWT and organization context";
      throw new Error(`Daytona credentials rejected; ${remedy}`);
    }
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
  const legacyCredential = credential
    ? undefined
    : await readProviderCredential(LEGACY_KEY, options.allowKeychainPrompt);
  return {
    provider: "daytona",
    sources: [
      credentialSource(KEY, credential, options.allowKeychainPrompt),
      credentialSource(
        LEGACY_KEY,
        legacyCredential,
        options.allowKeychainPrompt,
      ),
      {
        source: "daytona-cli-config",
        path: "~/Library/Application Support/daytona/config.json",
        status: (await readDaytonaConfigToken()) ? "available" : "missing",
      },
    ],
  };
}

export function buildDaytonaHeaders(
  token: string,
  organizationId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (organizationId) headers["X-Daytona-Organization-ID"] = organizationId;
  return headers;
}

type DaytonaConfigAuth = { token: string; organizationId?: string };

async function readDaytonaConfigToken(): Promise<
  DaytonaConfigAuth | undefined
> {
  try {
    const path = join(
      homedir(),
      "Library",
      "Application Support",
      "daytona",
      "config.json",
    );
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      profiles?: {
        activeOrganizationId?: string;
        api?: { token?: { accessToken?: string } };
      }[];
    };
    const profile = raw.profiles?.[0];
    const token = profile?.api?.token?.accessToken?.trim();
    return token
      ? { token, organizationId: profile?.activeOrganizationId?.trim() }
      : undefined;
  } catch {
    return undefined;
  }
}
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
