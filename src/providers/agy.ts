import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
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

// Antigravity (Google Code Assist) exposes a per-model daily request quota
// through the cloudcode-pa endpoint. Each bucket carries a remainingFraction
// (0..1) and a resetTime, so agy reports one real-percent window per model.
const QUOTA_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const API_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 256 * 1024;

const AUTH_SOURCE = "antigravity-oauth-token";
const AGY_SOURCE: ProviderSource = "oauth";
const AGY_SIGN_IN_REQUIRED_ERROR = "Antigravity sign-in required";
const AGY_ACCESS_TOKEN_EXPIRED_ERROR = "Antigravity access token expired";
const AGY_QUOTA_UNAVAILABLE_ERROR = "Antigravity quota unavailable";

type CredentialState =
  | { status: "available"; token: string; source: AuthSourceReport }
  | { status: "missing" | "invalid" | "expired"; source: AuthSourceReport };

type NormalizedAgyQuota = {
  windows: QuotaWindow[];
  refreshedAt: string;
};

export const agyAdapter: ProviderAdapter = {
  id: "agy",
  label: "Antigravity",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const state = readCredentialState();

  if (state.status !== "available") {
    const error =
      state.status === "expired"
        ? AGY_ACCESS_TOKEN_EXPIRED_ERROR
        : AGY_SIGN_IN_REQUIRED_ERROR;
    return failedProvider({
      provider: "agy",
      label: "Antigravity",
      status: statusFromError(error),
      error,
      source: AGY_SOURCE,
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
    const quota = await fetchAgyQuota(state.token);
    attempts[attempts.length - 1] = { source: "api", status: "success" };
    return successProvider({
      provider: "agy",
      label: "Antigravity",
      source: AGY_SOURCE,
      windows: quota.windows,
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

    const cached = readCachedProvider("agy");
    if (cached) {
      return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
    }

    return failedProvider({
      provider: "agy",
      label: "Antigravity",
      status: retryAfter ? "rate_limited" : statusFromError(finalError),
      error: finalError,
      retryAfter,
      source: AGY_SOURCE,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const state = readCredentialState();
  return { provider: "agy", sources: [state.source] };
}

/**
 * One QuotaWindow per model bucket. `remainingFraction` (0..1) is real percent
 * data, so each window carries percentRemaining/percentUsed and the bucket's
 * resetTime. tokenType REQUESTS maps to the model-scoped window kind.
 */
export async function fetchAgyQuota(token: string): Promise<NormalizedAgyQuota> {
  const payload = objectValue(await retrieveUserQuota(token));
  const buckets = Array.isArray(payload?.buckets) ? payload.buckets : [];

  const windows: QuotaWindow[] = [];
  for (const raw of buckets) {
    const bucket = objectValue(raw);
    const modelId = stringValue(bucket?.modelId);
    if (!modelId) continue;
    const fraction = numberValue(bucket?.remainingFraction);
    const percentRemaining =
      fraction === undefined ? undefined : clampPercent(fraction * 100);
    const resetsAt = stringValue(bucket?.resetTime);
    windows.push({
      id: modelId,
      label: modelId,
      kind: "model",
      ...(percentRemaining !== undefined
        ? {
            percentRemaining,
            percentUsed: clampPercent(100 - percentRemaining),
          }
        : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  if (windows.length === 0)
    throw new SafeAgyError(AGY_QUOTA_UNAVAILABLE_ERROR);

  return { windows, refreshedAt: nowIso() };
}

async function retrieveUserQuota(token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(QUOTA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted)
        throw new SafeAgyError("Antigravity quota request timed out");
      throw new SafeAgyError(AGY_QUOTA_UNAVAILABLE_ERROR);
    }
    rejectUnusableResponse(response);
    return await readBoundedJson(response);
  } finally {
    clearTimeout(timer);
  }
}

function rejectUnusableResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new SafeAgyError(AGY_SIGN_IN_REQUIRED_ERROR);
  }
  if (response.status === 429) {
    throw new RateLimitError(retryAfterToIso(response.headers.get("retry-after")));
  }
  if (!response.ok) throw new SafeAgyError(AGY_QUOTA_UNAVAILABLE_ERROR);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > RESPONSE_LIMIT_BYTES
  ) {
    throw new SafeAgyError(AGY_QUOTA_UNAVAILABLE_ERROR);
  }
  if (!response.body) throw new SafeAgyError(AGY_QUOTA_UNAVAILABLE_ERROR);

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
        throw new SafeAgyError(AGY_QUOTA_UNAVAILABLE_ERROR);
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
    throw new SafeAgyError(AGY_QUOTA_UNAVAILABLE_ERROR);
  }
}

function readCredentialState(path = agyTokenFile()): CredentialState {
  return extractCredentialState(readJsonFileResult(path), path);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return { status: "missing", source: authSource(path, "missing") };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: authSource(path, "invalid", raw.error),
    };
  const data = objectValue(raw.value);
  const token = accessTokenFrom(data);
  if (!data || !token)
    return { status: "invalid", source: authSource(path, "invalid") };

  // Treat the credential as expired only when an expiry is actually exposed —
  // at the top level or inside the nested token object.
  const tokenObject = objectValue(data.token);
  const expiresAt =
    stringValue(data.expires_at) ??
    stringValue(data.expiresAt) ??
    stringValue(tokenObject?.expiry) ??
    stringValue(tokenObject?.expires_at) ??
    stringValue(tokenObject?.expiresAt);
  if (isExpired(expiresAt))
    return { status: "expired", source: authSource(path, "expired") };

  return {
    status: "available",
    token,
    source: authSource(path, "available"),
  };
}

/**
 * The access token lives at `token.access_token`. `token` may instead be a
 * bare string, or expose `accessToken`/`id_token`; as a last resort accept any
 * long string field. auth_method is "consumer".
 */
function accessTokenFrom(data: Record<string, unknown> | undefined):
  | string
  | undefined {
  if (!data) return undefined;
  const tokenString = stringValue(data.token);
  if (tokenString) return tokenString;
  const tokenObject = objectValue(data.token);
  if (!tokenObject) return undefined;
  return (
    stringValue(tokenObject.access_token) ??
    stringValue(tokenObject.accessToken) ??
    stringValue(tokenObject.id_token) ??
    firstLongStringField(tokenObject)
  );
}

function firstLongStringField(
  object: Record<string, unknown>,
): string | undefined {
  for (const value of Object.values(object)) {
    if (typeof value === "string" && value.length > 40) return value;
  }
  return undefined;
}

function agyTokenFile(): string {
  return (
    stringValue(process.env.AGY_OAUTH_TOKEN) ??
    stringValue(process.env.ANTIGRAVITY_OAUTH_TOKEN) ??
    join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token")
  );
}

function authSource(
  path: string,
  status: AuthSourceReport["status"],
  error?: string,
): AuthSourceReport {
  return {
    source: AUTH_SOURCE,
    path,
    status,
    ...(error ? { error } : {}),
    credentialPresent: status === "available",
  };
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= Date.now();
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
  return error instanceof SafeAgyError
    ? error.message
    : AGY_QUOTA_UNAVAILABLE_ERROR;
}

class SafeAgyError extends Error {}

class RateLimitError extends SafeAgyError {
  constructor(readonly retryAfter?: string) {
    super("Antigravity quota endpoint rate limited");
  }
}
