import { deleteCachedProvider as deleteCachedProviderFromDisk } from "../cache.js";
import { providerFetch } from "../lib/http.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import {
  credentialCandidates,
  type EnvPiCredentialResolution,
  type EnvPiCredentialSources,
  errorCode,
  extractPiKeyCredential,
  inspectEnvPiAuth,
  KeyEndpointError,
  type KeyCredentialFailure,
  keyCredentialFailure,
  preferCredentialFailure,
  preferRemoteAuthFailure,
  requestKeyEndpoint,
  resolveEnvPiCredentials,
  statusFromRequestError,
} from "./env-pi-credential.js";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
/**
 * The account balance, which is a different reading from the key's spend cap.
 * `/key` answers `limit`, `limit_remaining` and `usage` for one key: a ceiling
 * someone set on that key, not the money the account holds. `/credits` answers
 * `total_credits` and `total_usage` for the account. Reporting `limit_remaining`
 * as `credits` says a funded-looking key on an empty account still has money.
 */
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const OPENROUTER_PI_SOURCE = "pi:openrouter";
export const OPENROUTER_ENV_SOURCE = "env:OPENROUTER_API_KEY";

const LABEL = "OpenRouter";
const DEADLINE_MS = 15_000;

const OPENROUTER_SOURCES: EnvPiCredentialSources = {
  envVar: "OPENROUTER_API_KEY",
  envSource: OPENROUTER_ENV_SOURCE,
  piProviderId: "openrouter",
  piSource: OPENROUTER_PI_SOURCE,
};

type Dependencies = {
  credential: () => EnvPiCredentialResolution | EnvPiCredentialResolution[];
  fetch: typeof providerFetch;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedOpenRouterPayload = {
  label?: string;
  limit?: number;
  remaining?: number;
  period?: string;
  unlimited: boolean;
};

export function resolveOpenRouterCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path?: string,
): EnvPiCredentialResolution[] {
  return resolveEnvPiCredentials(OPENROUTER_SOURCES, environment, path);
}

export function extractOpenRouterCredential(
  value: unknown,
  path: string,
): EnvPiCredentialResolution {
  return extractPiKeyCredential(
    value,
    "openrouter",
    OPENROUTER_PI_SOURCE,
    path,
  );
}

export function createOpenRouterAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveOpenRouterCredentials(),
    fetch: providerFetch,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "openrouter",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const openrouterAdapter = createOpenRouterAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalFailure: KeyCredentialFailure | undefined;
  for (const resolution of credentialCandidates(dependencies.credential)) {
    if (resolution.status !== "available") {
      const failure = keyCredentialFailure("openrouter", resolution);
      attempts.push({
        source: resolution.source,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.error,
        ...(resolution.status === "invalid" || resolution.status === "error"
          ? { credentialPresent: true }
          : {}),
      });
      finalFailure = preferCredentialFailure(finalFailure, failure);
      continue;
    }

    try {
      const payload = await requestKeyEndpoint(
        OPENROUTER_KEY_URL,
        resolution.key,
        dependencies.fetch,
        dependencies.deadlineMs,
      );
      const normalized = normalizeOpenRouterPayload(payload);
      attempts.push({ source: resolution.source, status: "success" });

      // The account's own balance, when the endpoint answers. A failure here is
      // not fatal: the request succeeded and the key cap is still a real limit,
      // so the report falls back to it rather than losing the provider.
      const accountCredits = await readAccountCredits(
        resolution.key,
        dependencies,
      );

      const windows: QuotaWindow[] = [];
      if (
        !normalized.unlimited &&
        normalized.limit !== undefined &&
        normalized.remaining !== undefined
      ) {
        const used = Math.max(0, normalized.limit - normalized.remaining);
        const percentRemaining =
          normalized.limit > 0
            ? clampPercent(100 - (used / normalized.limit) * 100)
            : normalized.remaining <= 0
              ? 0
              : undefined;
        if (percentRemaining !== undefined) {
          windows.push({
            id: "key-limit",
            label: "Key spend cap",
            kind: "credits",
            spentUsd: used,
            limitUsd: normalized.limit,
            percentRemaining,
            ...(normalized.period ? { resetText: normalized.period } : {}),
          });
        }
      }

      return successProvider({
        provider: "openrouter",
        label: LABEL,
        source: "api",
        account: normalized.label
          ? { accountId: normalized.label, identityStatus: "unverified" }
          : undefined,
        windows,
        ...(normalized.unlimited
          ? { credits: { unlimited: true, unit: "usd" } }
          : accountCredits !== undefined
            ? { credits: { remaining: accountCredits, unit: "usd" } }
            : normalized.remaining !== undefined
              ? { credits: { remaining: normalized.remaining, unit: "usd" } }
              : {}),
        refreshedAt: new Date(dependencies.now()).toISOString(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      const code = errorCode(error);
      attempts.push({
        source: resolution.source,
        status: "failed",
        error: code,
      });
      if (code === "provider_auth_rejected") {
        finalFailure = preferRemoteAuthFailure(finalFailure, code);
        continue;
      }
      return failedProvider({
        provider: "openrouter",
        label: LABEL,
        status: statusFromRequestError(code),
        error: code,
        source: "unavailable",
        retryAfter:
          error instanceof KeyEndpointError ? error.retryAfter : undefined,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }
  }

  const failure = finalFailure ?? {
    status: "auth_required" as const,
    error: "openrouter_credential_unavailable",
  };
  if (failure.status === "auth_required") {
    try {
      dependencies.deleteCachedProvider("openrouter");
    } catch {
      // Preserve the current definitive auth result.
    }
  }
  return failedProvider({
    provider: "openrouter",
    label: LABEL,
    status: failure.status,
    error: failure.error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  return inspectEnvPiAuth(
    "openrouter",
    credentialCandidates(dependencies.credential),
  );
}

/** The account balance: `total_credits` minus `total_usage`, clamped at zero so
 *  an overdrawn account reads as empty rather than negative. Best effort: an
 *  absent or unexpected body leaves `undefined`, and the caller falls back to
 *  the key's remaining cap. */
async function readAccountCredits(
  key: string,
  dependencies: Dependencies,
): Promise<number | undefined> {
  try {
    const payload = await requestKeyEndpoint(
      OPENROUTER_CREDITS_URL,
      key,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const data = objectValue(objectValue(payload)?.data);
    const total = asFiniteNumber(data?.total_credits);
    const used = asFiniteNumber(data?.total_usage);
    if (total === undefined || used === undefined) return undefined;
    return Math.max(0, total - used);
  } catch {
    return undefined;
  }
}

export function normalizeOpenRouterPayload(
  raw: unknown,
): NormalizedOpenRouterPayload {
  const root = objectValue(raw);
  if (!root) throw new Error("invalid_payload");
  const data = objectValue(root.data);
  if (!data) throw new Error("missing_data");

  const unlimited = data.limit === null;
  const limit = unlimited ? undefined : asNonnegativeNumber(data.limit);
  if (!unlimited && limit === undefined) throw new Error("invalid_limit");
  const remaining = asFiniteNumber(data.limit_remaining);
  const period = asString(data.limit_reset);
  const label = asString(data.label);

  return {
    label,
    limit,
    remaining,
    period,
    unlimited,
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
