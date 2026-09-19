/**
 * OpenRouter (openrouter) provider adapter.
 *
 * OpenRouter publishes a single bounded, read-only `GET /api/v1/auth/key`
 * endpoint that returns the key's label, current usage, and (when set) its
 * spending limit. quota-axi reports exactly that:
 *  - When `data.usage` is numeric and `data.limit` is positive, the adapter
 *    surfaces a single `credits` window with `spentUsd` and `limitUsd` so
 *    callers can see real usage. There is no reset timestamp in this response,
 *    so pace/runway stay unknown.
 *  - When the limit is null, missing, or zero, or usage is unavailable, the
 *    adapter confirms auth usability but reports no windows - matching the Grok
 *    Pi OAuth "live_no_quota" path. It never derives a percentage from usage
 *    alone.
 *
 * It honours the smallest opt-in surface agreed in the package:
 *  - `$OPENROUTER_API_KEY` first (explicit caller intent).
 *  - opencode `auth.json` `openrouter` literal key entry.
 *  - Pi's `$PI_CODING_AGENT_DIR/auth.json` `openrouter` entry.
 *
 * Nothing else is read or written. The adapter never refreshes credentials,
 * never calls inference, and never infers a quota percentage from usage alone.
 */

import { providerFetch } from "../lib/http.js";
import { readBoundedResponseText } from "../lib/bounded-response.js";
import { selectCredential } from "./credential-selection.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { withUsageFetchFailure } from "./usage-fetch-failure.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";

const LABEL = "OpenRouter";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const OPENROUTER_HOST = "openrouter.ai";
const OPENROUTER_AUTH_PATH = "/api/v1/auth/key";

const OPENROUTER_PROVIDER_IDS = ["openrouter"];
const OPENROUTER_CREDENTIAL_KEYS = [
  "key",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "auth_token",
];

const ENV_OPENROUTER_API_KEY = "OPENROUTER_API_KEY";
const OPENCODE_AUTH_SOURCE = "opencode:auth.json";
const PI_OPENROUTER_SOURCE = "pi:openrouter";

export type OpenRouterCredentialResolution =
  | { status: "available"; apiKey: string; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export type OpenRouterCredentialInspection =
  | { status: "available"; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export function opencodeAuthFilePath(): string {
  const xdg = stringValue(process.env.XDG_DATA_HOME);
  if (xdg) return join(xdg, "opencode", "auth.json");
  if (process.platform === "win32") {
    const localAppData = stringValue(process.env.LOCALAPPDATA);
    if (localAppData) return join(localAppData, "opencode", "auth.json");
  }
  return join(join(homedir(), ".local", "share"), "opencode", "auth.json");
}

export function extractOpenRouterCredential(
  value: unknown,
  path: string,
): OpenRouterCredentialResolution {
  const data = objectValue(value);
  if (!data) return { status: "invalid", path, error: "json_parse_error" };
  let presentEntry = false;
  for (const providerId of OPENROUTER_PROVIDER_IDS) {
    const entry = data[providerId];
    if (entry === undefined || entry === null) continue;
    presentEntry = true;
    const key = extractCredentialKey(entry);
    if (key) return { status: "available", apiKey: key, path };
  }
  if (presentEntry)
    return { status: "invalid", path, error: "invalid_credential" };
  return { status: "missing", path };
}

function extractPiOpenRouterCredential(
  value: unknown,
  path: string,
): OpenRouterCredentialResolution {
  for (const providerId of OPENROUTER_PROVIDER_IDS) {
    const classified = classifyPiAuthEntry(value, providerId);
    if (classified.status === "missing") continue;
    if (classified.status === "invalid") {
      return { status: "invalid", path, error: "pi_entry_invalid" };
    }
    const entry = classified.entry;
    const type = entryType(entry);
    if (type === "api_key") {
      const key = usableLiteralSecret(entry.key);
      if (key) return { status: "available", apiKey: key, path };
      return { status: "invalid", path, error: "invalid_credential" };
    }
    if (type === "oauth") {
      const token = usableLiteralSecret(entry.access);
      if (token) return { status: "available", apiKey: token, path };
      return { status: "invalid", path, error: "invalid_credential" };
    }
    return { status: "invalid", path, error: "unsupported_entry_type" };
  }
  return { status: "missing", path };
}

function entryType(entry: Record<string, unknown>): string | undefined {
  const raw = entry.type;
  return typeof raw === "string" && raw.trim()
    ? raw.trim().toLowerCase()
    : undefined;
}

function extractCredentialKey(entry: unknown): string | undefined {
  if (typeof entry === "string") return usableLiteralSecret(entry);
  if (!objectValue(entry)) return undefined;
  for (const key of OPENROUTER_CREDENTIAL_KEYS) {
    const candidate = usableLiteralSecret(
      (entry as Record<string, unknown>)[key],
    );
    if (candidate) return candidate;
  }
  return undefined;
}

export type OpenRouterCredentialSource = {
  name: string;
  path: () => string;
  extract: (value: unknown, path: string) => OpenRouterCredentialResolution;
};

function resolveOpenRouterCredentialSource(
  source: OpenRouterCredentialSource,
): OpenRouterCredentialResolution {
  const path = source.path();
  const result: JsonFileReadResult = readJsonFileResult(path);
  if (result.status === "missing") return { status: "missing", path };
  if (result.status === "invalid") {
    return result.error === "file_read_error"
      ? { status: "error", path, error: result.error }
      : { status: "invalid", path, error: result.error };
  }
  return source.extract(result.value, path);
}

function inspectOpenRouterCredentialSource(
  source: OpenRouterCredentialSource,
): OpenRouterCredentialInspection {
  const resolution = resolveOpenRouterCredentialSource(source);
  if (resolution.status === "available")
    return { status: "available", path: resolution.path };
  if (resolution.status === "missing")
    return { status: "missing", path: resolution.path };
  return resolution;
}

export function defaultOpenRouterCredentialSources(): OpenRouterCredentialSource[] {
  return [
    {
      name: OPENCODE_AUTH_SOURCE,
      path: opencodeAuthFilePath,
      extract: extractOpenRouterCredential,
    },
    {
      name: PI_OPENROUTER_SOURCE,
      path: resolvePiAuthFilePath,
      extract: extractPiOpenRouterCredential,
    },
  ];
}

type OpenRouterDependencies = {
  credentialSources: OpenRouterCredentialSource[];
  envApiKey: () => string | undefined;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedOpenRouterKey = {
  label?: string;
  usage?: number;
  limit?: number;
  isFreeTier?: boolean;
  /** True when the response carried numeric usage and a positive limit. */
  credits: boolean;
};

export function createOpenRouterAdapter(
  overrides: Partial<OpenRouterDependencies> = {},
): ProviderAdapter {
  const dependencies: OpenRouterDependencies = {
    credentialSources: defaultOpenRouterCredentialSources(),
    envApiKey: () => process.env[ENV_OPENROUTER_API_KEY],
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "openrouter",
    label: LABEL,
    fetchQuota: (options: ProviderOptions) =>
      fetchQuotaWithDependencies(dependencies, options),
    inspectAuth: (_options: ProviderOptions) =>
      inspectAuthWithDependencies(dependencies),
  };
}

export const openrouterAdapter = createOpenRouterAdapter();

async function fetchQuotaWithDependencies(
  dependencies: OpenRouterDependencies,
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let credentialMissing = true;
  let definitiveAuth: string | undefined;
  let readError: string | undefined;
  let lastError: string | undefined;

  async function tryCredential(
    source: string,
    apiKey: string,
  ): Promise<ProviderQuota | undefined> {
    const selection = await selectCredential(
      [{ source, credential: apiKey, localState: "valid" }],
      async (candidate) => {
        try {
          return {
            kind: "quota",
            result: await probeOpenRouter(candidate.credential, dependencies),
          };
        } catch (error) {
          const code = errorCode(error);
          return {
            kind: code === "provider_auth_rejected" ? "rejected" : "transient",
            error: code,
          };
        }
      },
    );
    if (selection.outcome === "quota") {
      attempts.push({ source, status: "success" });
      return successOpenRouterReport(selection.result!, attempts, dependencies);
    }
    const code = selection.transientError ?? selection.results[0]!.error!;
    attempts.push({ source, status: "failed", error: code });
    if (selection.outcome === "transient") {
      return failedOpenRouterReport(attempts, code);
    }
    credentialMissing = false;
    definitiveAuth = preferDefinitiveAuth(definitiveAuth, code);
    lastError = code;
    return undefined;
  }

  const envKey = dependencies.envApiKey();
  if (envKey) {
    const report = await tryCredential(ENV_OPENROUTER_API_KEY, envKey);
    if (report) return report;
  }

  for (const source of dependencies.credentialSources) {
    const resolution = resolveOpenRouterCredentialSource(source);
    if (resolution.status !== "available") {
      attempts.push({
        source: source.name,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: credentialError(resolution),
        ...(resolution.status !== "missing" ? { credentialPresent: true } : {}),
      });
      if (resolution.status !== "missing") {
        credentialMissing = false;
        if (resolution.status === "error") {
          readError ??= credentialError(resolution);
        } else {
          definitiveAuth = preferDefinitiveAuth(
            definitiveAuth,
            credentialError(resolution),
          );
        }
      }
      lastError = credentialError(resolution);
      continue;
    }

    const report = await tryCredential(source.name, resolution.apiKey);
    if (report) return report;
  }

  if (attempts.length === 0) {
    attempts.push({
      source: ENV_OPENROUTER_API_KEY,
      status: "skipped",
      error: "openrouter_credential_unavailable",
    });
    lastError = "openrouter_credential_unavailable";
  }

  return failedOpenRouterReport(
    attempts,
    readError ?? definitiveAuth ?? lastError ?? "openrouter_quota_failed",
    credentialMissing && !definitiveAuth,
  );
}

function preferDefinitiveAuth(
  current: string | undefined,
  next: string,
): string {
  if (!current) return next;
  if (current === "provider_auth_rejected") return current;
  if (next === "provider_auth_rejected") return next;
  return current;
}

async function probeOpenRouter(
  apiKey: string,
  dependencies: OpenRouterDependencies,
): Promise<NormalizedOpenRouterKey> {
  const url = `https://${OPENROUTER_HOST}${OPENROUTER_AUTH_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.deadlineMs);
  try {
    const response = await dependencies.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("provider_auth_rejected");
    }
    if (response.status === 429) throw new Error("provider_rate_limited");
    if (!response.ok) throw new Error("provider_request_rejected");
    const text = await readBoundedResponseText(response, RESPONSE_LIMIT_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("malformed_json");
    }
    return normalizeOpenRouterKey(payload);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("provider_timeout", { cause: error });
    }
    if (
      error instanceof Error &&
      [
        "provider_auth_rejected",
        "provider_rate_limited",
        "provider_request_rejected",
        "response_too_large",
        "malformed_json",
        "provider_timeout",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("network_unavailable", { cause: error });
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

export function normalizeOpenRouterKey(raw: unknown): NormalizedOpenRouterKey {
  const root = objectValue(raw);
  if (!root) return { credits: false };
  const data = objectValue(root.data) ?? root;
  const label = firstString(data, ["label", "name"]);
  const usage = firstNumber(data, ["usage", "used", "used_usd", "spent"]);
  const limitPresent = Object.hasOwn(data, "limit");
  const limit = firstNumber(data, ["limit", "limit_usd", "limitUsd"]);
  const isFreeTier = data.is_free_tier;
  const hasUsableLimit = limitPresent && limit !== undefined && limit > 0;
  const credits = usage !== undefined && hasUsableLimit;
  return {
    ...(label ? { label } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(hasUsableLimit ? { limit: limit! } : {}),
    ...(typeof isFreeTier === "boolean" ? { isFreeTier } : {}),
    credits,
  };
}

function successOpenRouterReport(
  probe: NormalizedOpenRouterKey,
  attempts: SourceAttempt[],
  dependencies: OpenRouterDependencies,
): ProviderQuota {
  const windows = openRouterWindows(probe);
  const plan = probe.label;
  const base = successProvider({
    provider: "openrouter",
    label: LABEL,
    source: "api",
    ...(plan ? { plan } : {}),
    windows,
    refreshedAt: new Date(dependencies.now()).toISOString(),
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  return {
    ...base,
    state: {
      ...base.state,
      authStatus: "usable",
    },
  };
}

function openRouterWindows(probe: NormalizedOpenRouterKey): QuotaWindow[] {
  if (!probe.credits) return [];
  const usage = probe.usage ?? 0;
  const limit = probe.limit ?? 0;
  return [
    {
      id: "credits",
      label: "credits",
      kind: "credits",
      spentUsd: usage,
      limitUsd: limit,
    },
  ];
}

function failedOpenRouterReport(
  attempts: SourceAttempt[],
  error: string,
  credentialMissing = false,
): ProviderQuota {
  const status = credentialMissing ? "auth_required" : statusFromError(error);
  const report = failedProvider({
    provider: "openrouter",
    label: LABEL,
    status,
    error,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  if (status === "auth_required") return report;
  return withUsageFetchFailure(report);
}

function inspectAuthWithDependencies(
  dependencies: OpenRouterDependencies,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = [];
  const envKey = dependencies.envApiKey();
  sources.push({
    source: ENV_OPENROUTER_API_KEY,
    status: envKey ? "available" : "missing",
  });
  for (const source of dependencies.credentialSources) {
    const inspection = inspectOpenRouterCredentialSource(source);
    sources.push({
      source: source.name,
      path: inspection.path,
      status: inspection.status,
      ...(inspection.status === "invalid" || inspection.status === "error"
        ? { error: inspection.error }
        : {}),
    });
  }
  return Promise.resolve({ provider: "openrouter", sources });
}

function credentialError(
  resolution: Exclude<OpenRouterCredentialResolution, { status: "available" }>,
): string {
  switch (resolution.status) {
    case "missing":
      return "openrouter_credential_unavailable";
    case "invalid":
      return `openrouter_credential_invalid: ${resolution.error}`;
    case "error":
      return `credential_resolution_failed: ${resolution.error}`;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "openrouter_quota_failed";
}

function statusFromError(error: string) {
  if (
    error === "keychain_prompt_required" ||
    error === "credentials_expired" ||
    error === "provider_auth_rejected" ||
    error.startsWith("openrouter_credential_invalid") ||
    /sign-in|required|reauth|access token expired/i.test(error)
  )
    return "auth_required";
  if (/rate.?limit/i.test(error)) return "rate_limited";
  return "error";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return keys
    .map((key) => {
      const raw = value[key];
      return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    })
    .find((entry): entry is string => entry !== undefined);
}

function firstNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
