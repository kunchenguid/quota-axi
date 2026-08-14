import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderSource,
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

// Cline (app.cline.bot) exposes a daily-resetting credit balance through its
// public API. Phase 2 reads the local Bearer token, resolves the account's
// organization, and reports the absolute remaining daily credit balance.
const API_BASE = "https://api.cline.bot/api/v1";
const API_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 256 * 1024;

const PROVIDERS_JSON_SOURCE = "cline-providers-json";
const API_KEY_SOURCE = "cline-api-key";
const CLINE_SOURCE: ProviderSource = "api";
const CLINE_SIGN_IN_REQUIRED_ERROR = "Cline sign-in required";
const CLINE_QUOTA_UNAVAILABLE_ERROR = "Cline quota unavailable";

type CredentialState =
  | { status: "available"; token: string; source: AuthSourceReport }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

type NormalizedClineQuota = {
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits: ProviderQuota["credits"];
  refreshedAt: string;
};

export const clineAdapter: ProviderAdapter = {
  id: "cline",
  label: "Cline",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const state = readCredentialState();

  if (state.status !== "available") {
    return failedProvider({
      provider: "cline",
      label: "Cline",
      status: statusFromError(CLINE_SIGN_IN_REQUIRED_ERROR),
      error: CLINE_SIGN_IN_REQUIRED_ERROR,
      sourcesTried: [state.source.source],
      attempts: [
        {
          source: state.source.source,
          status: "skipped",
          error: `credentials_${state.status}`,
          credentialPresent: false,
        },
      ],
    });
  }

  const attempts: SourceAttempt[] = [{ source: "api", status: "failed" }];

  try {
    const quota = await fetchClineQuota(state.token);
    attempts[attempts.length - 1] = { source: "api", status: "success" };
    return successProvider({
      provider: "cline",
      label: "Cline",
      source: CLINE_SOURCE,
      ...(quota.account ? { account: quota.account } : {}),
      windows: quota.windows,
      credits: quota.credits,
      refreshedAt: quota.refreshedAt,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const finalError = errorMessage(error);
    const retryAfter =
      error instanceof RateLimitError ? error.retryAfter : undefined;
    attempts[attempts.length - 1] = {
      source: "api",
      status: "failed",
      error: finalError,
    };

    const cached = readCachedProvider("cline");
    if (cached) {
      return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
    }

    return failedProvider({
      provider: "cline",
      label: "Cline",
      status: retryAfter ? "rate_limited" : statusFromError(finalError),
      error: finalError,
      retryAfter,
      source: CLINE_SOURCE,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const state = readCredentialState();
  return { provider: "cline", sources: [state.source] };
}

/**
 * Resolve the account's organization, then read its daily credit balance.
 * `balance` is an absolute integer credit count that resets daily, so it is
 * reported through `credits` (like a prepaid balance) plus a percent-less
 * `daily_credits` window carrying the next UTC-midnight reset. No daily maximum
 * is exposed, so no percentage is fabricated.
 */
export async function fetchClineQuota(
  token: string,
): Promise<NormalizedClineQuota> {
  const me = objectValue(await clineGet("/users/me", token));
  const meData = objectValue(me?.data);
  const organizations = Array.isArray(meData?.organizations)
    ? meData.organizations
    : [];
  const organization = objectValue(organizations[0]);
  const organizationId = stringValue(organization?.organizationId);
  if (!organizationId) throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);

  const balancePayload = objectValue(
    await clineGet(
      `/organizations/${encodeURIComponent(organizationId)}/balance`,
      token,
    ),
  );
  const balance = numberValue(objectValue(balancePayload?.data)?.balance);
  if (balance === undefined) throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);

  const email = stringValue(meData?.email);
  const organizationName = stringValue(organization?.name);
  const account =
    email || organizationName
      ? {
          ...(email ? { email } : {}),
          ...(organizationName ? { organization: organizationName } : {}),
        }
      : undefined;

  const windows: QuotaWindow[] = [
    {
      id: "daily_credits",
      label: "daily credits",
      kind: "credits",
      resetsAt: nextUtcMidnightIso(),
    },
  ];

  return {
    ...(account ? { account } : {}),
    windows,
    credits: { remaining: balance, unit: "credits" },
    refreshedAt: nowIso(),
  };
}

async function clineGet(path: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted)
        throw new SafeClineError("Cline quota request timed out");
      throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
    }
    rejectUnusableResponse(response);
    return await readBoundedJson(response);
  } finally {
    clearTimeout(timer);
  }
}

function rejectUnusableResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new SafeClineError(CLINE_SIGN_IN_REQUIRED_ERROR);
  }
  if (response.status === 429) {
    throw new RateLimitError(retryAfterToIso(response.headers.get("retry-after")));
  }
  if (!response.ok) throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > RESPONSE_LIMIT_BYTES
  ) {
    throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
  }
  if (!response.body) throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
  }
}

function readCredentialState(): CredentialState {
  const inlineToken = stringValue(process.env.CLINE_API_KEY);
  if (inlineToken) {
    return {
      status: "available",
      token: inlineToken,
      source: authSource(API_KEY_SOURCE, undefined, "available"),
    };
  }
  const path = clineProvidersFile();
  return extractCredentialState(readJsonFileResult(path), path);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: authSource(PROVIDERS_JSON_SOURCE, path, "missing"),
    };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: authSource(PROVIDERS_JSON_SOURCE, path, "invalid", raw.error),
    };
  const token = accessTokenFrom(raw.value);
  if (!token)
    return {
      status: "invalid",
      source: authSource(PROVIDERS_JSON_SOURCE, path, "invalid"),
    };
  return {
    status: "available",
    token,
    source: authSource(PROVIDERS_JSON_SOURCE, path, "available"),
  };
}

/** JSON path: providers.cline.settings.auth.accessToken. */
function accessTokenFrom(value: unknown): string | undefined {
  const providers = objectValue(objectValue(value)?.providers);
  const cline = objectValue(providers?.cline);
  const settings = objectValue(cline?.settings);
  const auth = objectValue(settings?.auth);
  return stringValue(auth?.accessToken);
}

function clineProvidersFile(): string {
  return (
    stringValue(process.env.CLINE_CONFIG) ??
    join(homedir(), ".cline", "data", "settings", "providers.json")
  );
}

function nextUtcMidnightIso(from: Date = new Date()): string {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1),
  ).toISOString();
}

function authSource(
  source: string,
  path: string | undefined,
  status: AuthSourceReport["status"],
  error?: string,
): AuthSourceReport {
  return {
    source,
    ...(path ? { path } : {}),
    status,
    ...(error ? { error } : {}),
    credentialPresent: status === "available",
  };
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof SafeClineError
    ? error.message
    : CLINE_QUOTA_UNAVAILABLE_ERROR;
}

class SafeClineError extends Error {}

class RateLimitError extends SafeClineError {
  constructor(readonly retryAfter?: string) {
    super("Cline quota endpoint rate limited");
  }
}
