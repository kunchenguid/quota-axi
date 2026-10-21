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

export const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
export const SYNTHETIC_PI_SOURCE = "pi:synthetic";
export const SYNTHETIC_ENV_SOURCE = "env:SYNTHETIC_API_KEY";

const LABEL = "Synthetic";
const DEADLINE_MS = 15_000;

const SYNTHETIC_SOURCES: EnvPiCredentialSources = {
  envVar: "SYNTHETIC_API_KEY",
  envSource: SYNTHETIC_ENV_SOURCE,
  piProviderId: "synthetic",
  piSource: SYNTHETIC_PI_SOURCE,
};

/** The account-wide weekly credit allowance, one of the two model bounds. */
const WEEKLY_WINDOW_ID = "weekly";
const HOUR_SECONDS = 60 * 60;

/**
 * The payload's request-count meters. Each is a `{ limit, requests, renewsAt }`
 * triple describing one rolling counter that refills continuously, so each is
 * published as its own named window. `subscription` counts model requests, so
 * it also bounds `all_models` alongside the weekly allowance; the search and
 * tool-call meters do not. `search.hourly` names its own bucket length.
 */
type RequestCountWindow = {
  id: string;
  label: string;
  windowSeconds?: number;
};

const SUBSCRIPTION_WINDOW: RequestCountWindow = {
  id: "subscription",
  label: "requests",
};
const SEARCH_HOURLY_WINDOW: RequestCountWindow = {
  id: "search_hourly",
  label: "search",
  windowSeconds: HOUR_SECONDS,
};
const FREE_TOOL_CALLS_WINDOW: RequestCountWindow = {
  id: "free_tool_calls",
  label: "tool calls",
};

const RECOGNIZED_ROOT_KEYS = new Set([
  "weeklyTokenLimit",
  "subscription",
  "search",
  "freeToolCalls",
]);

type Dependencies = {
  credential: () => EnvPiCredentialResolution | EnvPiCredentialResolution[];
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedSyntheticPayload = {
  windows: QuotaWindow[];
  /** The vendor's own remaining weekly credit amount, when it is readable. */
  credits?: ProviderQuota["credits"];
  /**
   * Fields the payload declared but this reader could not establish, and
   * unrecognized object-valued fields that may hold a limit of their own. They
   * keep the account-wide reading non-definitive instead of being dropped.
   */
  untrustedWindowIds: string[];
};

export function resolveSyntheticCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path?: string,
): EnvPiCredentialResolution[] {
  return resolveEnvPiCredentials(SYNTHETIC_SOURCES, environment, path);
}

export function extractSyntheticCredential(
  value: unknown,
  path: string,
): EnvPiCredentialResolution {
  return extractPiKeyCredential(value, "synthetic", SYNTHETIC_PI_SOURCE, path);
}

export function createSyntheticAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveSyntheticCredentials(),
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "synthetic",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const syntheticAdapter = createSyntheticAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalFailure: KeyCredentialFailure | undefined;
  for (const resolution of credentialCandidates(dependencies.credential)) {
    if (resolution.status !== "available") {
      const failure = keyCredentialFailure("synthetic", resolution);
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
        SYNTHETIC_QUOTAS_URL,
        resolution.key,
        dependencies.fetch,
        dependencies.deadlineMs,
      );
      const normalized = normalizeSyntheticPayload(payload);
      attempts.push({ source: resolution.source, status: "success" });

      const report = successProvider({
        provider: "synthetic",
        label: LABEL,
        source: "api",
        windows: normalized.windows,
        ...(normalized.credits ? { credits: normalized.credits } : {}),
        refreshedAt: new Date(dependencies.now()).toISOString(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
      if (normalized.untrustedWindowIds.length === 0) return report;
      return {
        ...report,
        state: {
          ...report.state,
          untrustedWindowIds: [...normalized.untrustedWindowIds],
        },
      };
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
        provider: "synthetic",
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
    error: "synthetic_credential_unavailable",
  };
  return failedProvider({
    provider: "synthetic",
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
    "synthetic",
    credentialCandidates(dependencies.credential),
  );
}

/**
 * Normalize the vendor's own quota payload into windows.
 *
 * `weeklyTokenLimit` is Synthetic's account-wide weekly credit allowance, so
 * it is the `weekly` window that, with `subscription`, bounds model usage. Its
 * `percentRemaining` is already a percentage, so it is published exactly as
 * reported rather than rounded or re-derived from the dollar strings. The
 * vendor regenerates that allowance incrementally, so `nextRegenAt` is the next
 * top-up moment and not a window turnover: it is published as `resetText`
 * worded as the next regeneration, and the window carries no `resetsAt`. A
 * synthesized reset would claim a turnover that never happens, and a
 * `resetsAt` that moves forward on every read is exactly the false reading this
 * tree refuses to publish.
 *
 * The request-count meters - `subscription`, `search.hourly`, and a positive
 * `freeToolCalls` limit - are named scopes of their own; only `subscription`,
 * which counts model requests, also enters the account-wide bound. A
 * `freeToolCalls` limit of zero is an established "no allowance of this kind",
 * so it publishes no window and is not treated as an exhausted account.
 *
 * Each counter's `renewsAt` refills a rolling bucket rather than turning a
 * cycle over - Synthetic restores a slice of the allowance continuously - so it
 * is carried as renewal text and the window has no `resetsAt`, for the same
 * reason as the weekly `nextRegenAt`: a rolling moment drawn as a reset moves
 * forward on every read and claims a turnover that never happens.
 */
export function normalizeSyntheticPayload(
  raw: unknown,
): NormalizedSyntheticPayload {
  const root = objectValue(raw);
  if (!root) throw new Error("invalid_payload");
  if (!Object.keys(root).some((key) => RECOGNIZED_ROOT_KEYS.has(key))) {
    throw new Error("missing_quota_fields");
  }

  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];

  const weeklyTokenLimit = objectValue(root.weeklyTokenLimit);
  const weekly = weeklyTokenWindow(weeklyTokenLimit);
  // The two account-wide bounds are the fields whose absence leaves model
  // headroom unstated, so a missing, unreadable, or zero-limit one is named
  // rather than silently dropped.
  if (weekly) windows.push(weekly);
  else untrustedWindowIds.push(WEEKLY_WINDOW_ID);

  const subscription = requestCountWindow(
    root.subscription,
    SUBSCRIPTION_WINDOW,
  );
  if (subscription.kind === "window") windows.push(subscription.window);
  else untrustedWindowIds.push(SUBSCRIPTION_WINDOW.id);

  const search = objectValue(root.search);
  if (root.search !== undefined && root.search !== null && !search) {
    untrustedWindowIds.push("search");
  } else if (search) {
    const hourly = requestCountWindow(search.hourly, SEARCH_HOURLY_WINDOW);
    if (hourly.kind === "window") windows.push(hourly.window);
    if (hourly.kind === "untrusted")
      untrustedWindowIds.push(SEARCH_HOURLY_WINDOW.id);
    for (const key of Object.keys(search)) {
      if (key === "hourly") continue;
      const unread = search[key];
      // As at the root, only an object-valued bucket can carry a limit.
      if (objectValue(unread) || Array.isArray(unread))
        untrustedWindowIds.push(`search.${key}`);
    }
  }

  const freeToolCalls = requestCountWindow(
    root.freeToolCalls,
    FREE_TOOL_CALLS_WINDOW,
  );
  if (freeToolCalls.kind === "window") windows.push(freeToolCalls.window);
  if (freeToolCalls.kind === "untrusted")
    untrustedWindowIds.push(FREE_TOOL_CALLS_WINDOW.id);

  const weeklyCredits = weeklyRemainingCredits(weeklyTokenLimit);

  for (const key of Object.keys(root)) {
    if (RECOGNIZED_ROOT_KEYS.has(key)) continue;
    // Only an object-valued field can carry a limit of its own; scalar
    // metadata such as a plan label is not a quota window.
    if (objectValue(root[key]) || Array.isArray(root[key])) {
      untrustedWindowIds.push(key);
    }
  }

  return {
    windows,
    ...(weeklyCredits !== undefined ? { credits: weeklyCredits } : {}),
    untrustedWindowIds: [...new Set(untrustedWindowIds)],
  };
}

/**
 * One `weekly` window from `weeklyTokenLimit`. The percentage is the vendor's
 * own field; the dollar strings are raw credit evidence and are never turned
 * into a percentage. `maxCredits` is published as the window's USD cap, and
 * the remaining amount travels as the provider's `credits.remaining`, so no
 * spend figure has to be derived.
 */
function weeklyTokenWindow(
  entry: Record<string, unknown> | undefined,
): QuotaWindow | undefined {
  if (!entry) return undefined;
  const remaining = percentValue(entry.percentRemaining);
  if (remaining === undefined) return undefined;
  const limitUsd = creditAmount(entry.maxCredits);
  const nextRegenAt = isoTimestamp(entry.nextRegenAt);
  return {
    id: WEEKLY_WINDOW_ID,
    label: "week",
    kind: "weekly",
    percentUsed: Math.min(100, Math.max(0, 100 - remaining)),
    percentRemaining: remaining,
    ...(nextRegenAt ? { resetText: `next regen ${nextRegenAt}` } : {}),
    ...(limitUsd !== undefined ? { limitUsd } : {}),
  };
}

/**
 * The vendor's own remaining-credit string, reported as a raw USD amount. It
 * is evidence, not an allowance to re-derive a percentage from: the window's
 * percentage comes from `percentRemaining` alone.
 */
function weeklyRemainingCredits(
  entry: Record<string, unknown> | undefined,
): ProviderQuota["credits"] | undefined {
  const remaining = entry ? creditAmount(entry.remainingCredits) : undefined;
  return remaining === undefined ? undefined : { remaining, unit: "usd" };
}

type RequestCountResolution =
  | { kind: "window"; window: QuotaWindow }
  | { kind: "absent" }
  | { kind: "no_allowance" }
  | { kind: "untrusted" };

/**
 * One request-count window from a `{ limit, requests, renewsAt }` triple. The
 * counter refills continuously, so `renewsAt` is the next refill, not a cycle
 * turnover: it is published as renewal text and never as `resetsAt`, which
 * would claim a reset on every read. `limit: 0` is an established absence of
 * that allowance rather than an exhausted meter.
 */
function requestCountWindow(
  value: unknown,
  spec: RequestCountWindow,
): RequestCountResolution {
  if (value === undefined || value === null) return { kind: "absent" };
  const entry = objectValue(value);
  if (!entry) return { kind: "untrusted" };
  const limit = nonnegativeNumber(entry.limit);
  const requests = nonnegativeNumber(entry.requests);
  if (limit === undefined || requests === undefined) {
    return { kind: "untrusted" };
  }
  if (limit === 0) {
    return requests === 0 ? { kind: "no_allowance" } : { kind: "untrusted" };
  }
  const percentUsed = Math.min(100, (requests / limit) * 100);
  const renewsAt = isoTimestamp(entry.renewsAt);
  return {
    kind: "window",
    window: {
      id: spec.id,
      label: spec.label,
      kind: "unknown",
      percentUsed,
      percentRemaining: Math.max(0, 100 - percentUsed),
      ...(spec.windowSeconds !== undefined
        ? { windowSeconds: spec.windowSeconds }
        : {}),
      ...(renewsAt ? { resetText: `next renewal ${renewsAt}` } : {}),
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function percentValue(value: unknown): number | undefined {
  const percent = nonnegativeNumber(value);
  return percent !== undefined && percent <= 100 ? percent : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** A vendor dollar amount such as `$10.50`, kept as a number for `limitUsd`. */
function creditAmount(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\$?\s*(\d[\d,]*(?:\.\d+)?)$/u.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(amount) ? amount : undefined;
}
