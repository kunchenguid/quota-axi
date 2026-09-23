import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedClineProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { providerFetch, readBoundedResponseBody } from "../lib/http.js";
import { usableLiteralSecret } from "../lib/secret.js";
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
import {
  clearClineReadingContextId,
  clineCacheContextId,
  publishClineReadingContextId,
} from "./cline-cache-context.js";

// Cline (app.cline.bot) exposes a daily-resetting credit balance through its
// public API. Phase 2 reads the local Bearer token, resolves the account's
// organization, and reports the absolute remaining daily credit balance.
const API_BASE = "https://api.cline.bot/api/v1";
const API_TIMEOUT_MS = 15_000;

const PROVIDERS_JSON_SOURCE = "cline-providers-json";
const API_KEY_SOURCE = "cline-api-key";
const CLINE_SOURCE: ProviderSource = "api";
const CLINE_SIGN_IN_REQUIRED_ERROR = "Cline sign-in required";
const CLINE_QUOTA_UNAVAILABLE_ERROR = "Cline quota unavailable";
const CLINE_CREDENTIAL_INVALID_ERROR = "cline_credential_invalid";

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
  clearClineReadingContextId();
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
          credentialPresent: state.source.credentialPresent ?? false,
        },
      ],
    });
  }

  const cacheContextId = clineCacheContextId(state.source.source, state.token);
  publishClineReadingContextId(cacheContextId);

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

    const cached = readCachedClineProvider(cacheContextId);
    const stale = cached
      ? staleFromCache(cached, finalError, sourceNames(attempts), attempts)
      : undefined;
    if (stale) return stale;

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
  const providersFilePath = clineProvidersFile();
  const apiKeySource = inspectApiKeySource();
  const providersJsonSource = extractCredentialState(
    readJsonFileResult(providersFilePath),
    providersFilePath,
  ).source;
  return { provider: "cline", sources: [apiKeySource, providersJsonSource] };
}

function inspectApiKeySource(): AuthSourceReport {
  const resolution = resolveApiKeyCredential();
  return authSource(
    API_KEY_SOURCE,
    undefined,
    resolution.status,
    resolution.status === "invalid"
      ? CLINE_CREDENTIAL_INVALID_ERROR
      : undefined,
  );
}

type ApiKeyResolution =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "available"; token: string };

/**
 * A non-blank `CLINE_API_KEY` that is not a usable literal secret (a `$VAR` /
 * `!cmd` reference, or a value with control bytes) is the identity the vendor
 * would use, not an absent one; it must not be sent as a Bearer token, and
 * falling through to providers.json here would silently report a different
 * account. Only a blank or unset variable defers to the file.
 */
function resolveApiKeyCredential(): ApiKeyResolution {
  const raw = process.env.CLINE_API_KEY;
  if (raw === undefined || raw.trim().length === 0)
    return { status: "missing" };
  const token = usableLiteralSecret(raw);
  return token ? { status: "available", token } : { status: "invalid" };
}

/**
 * Resolve the account's active organization, then read its daily credit
 * balance. An account can belong to several organizations with one marked
 * `active`; reporting any other would silently return the wrong balance, so a
 * missing or ambiguous active flag fails closed rather than guessing.
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
  const activeOrganizations = organizations
    .map((org) => objectValue(org))
    .filter((org): org is Record<string, unknown> => org?.active === true);
  if (activeOrganizations.length !== 1)
    throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
  const organization = activeOrganizations[0];
  const organizationId = stringValue(organization?.organizationId);
  if (!organizationId) throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);

  const balancePayload = objectValue(
    await clineGet(
      `/organizations/${encodeURIComponent(organizationId)}/balance`,
      token,
    ),
  );
  const balance = numberValue(objectValue(balancePayload?.data)?.balance);
  if (balance === undefined)
    throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);

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
      response = await providerFetch(`${API_BASE}${path}`, {
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
    const bytes = await readBoundedResponseBody(
      response,
      controller.signal,
      () => new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR),
    );
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
    }
  } finally {
    clearTimeout(timer);
  }
}

function rejectUnusableResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new SafeClineError(CLINE_SIGN_IN_REQUIRED_ERROR);
  }
  if (response.status === 429) {
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  }
  if (!response.ok) throw new SafeClineError(CLINE_QUOTA_UNAVAILABLE_ERROR);
}

function readCredentialState(): CredentialState {
  const resolution = resolveApiKeyCredential();
  if (resolution.status === "available") {
    return {
      status: "available",
      token: resolution.token,
      source: authSource(API_KEY_SOURCE, undefined, "available"),
    };
  }
  if (resolution.status === "invalid") {
    return {
      status: "invalid",
      source: authSource(
        API_KEY_SOURCE,
        undefined,
        "invalid",
        CLINE_CREDENTIAL_INVALID_ERROR,
      ),
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
  return usableLiteralSecret(auth?.accessToken);
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
    // "invalid" always means a source was present but unusable (a malformed
    // providers.json, a missing accessToken, or a non-literal CLINE_API_KEY
    // reference), never absence.
    credentialPresent: status === "available" || status === "invalid",
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
