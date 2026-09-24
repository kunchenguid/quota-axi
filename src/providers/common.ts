import type {
  ProviderQuota,
  ProviderSource,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { percentRemaining } from "../lib/time.js";

export function withRemaining(
  window: Omit<QuotaWindow, "percentRemaining">,
): QuotaWindow {
  return {
    ...window,
    percentRemaining: percentRemaining(window.percentUsed),
  };
}

export function successProvider(
  provider: Omit<ProviderQuota, "state"> & {
    refreshedAt: string;
    sourcesTried: string[];
  },
): ProviderQuota {
  const { refreshedAt, sourcesTried, ...rest } = provider;
  return {
    ...rest,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt,
      sourcesTried,
    },
  };
}

export function failedProvider(args: {
  provider: ProviderQuota["provider"];
  label: string;
  status: ProviderStatus;
  error: string;
  sourcesTried: string[];
  source?: ProviderSource;
  retryAfter?: string;
  attempts?: SourceAttempt[];
}): ProviderQuota {
  return {
    provider: args.provider,
    label: args.label,
    source: args.source ?? "unavailable",
    windows: [],
    state: {
      status: args.status,
      stale: false,
      error: args.error,
      retryAfter: args.retryAfter,
      sourcesTried: args.sourcesTried,
    },
    attempts: args.attempts,
  };
}

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
/** The shortest calendar month, so no monthly cycle can end sooner. */
const SHORTEST_MONTH_SECONDS = 28 * 24 * 60 * 60;

/**
 * Whether a resetless cached window is served at all. `age_bound` applies
 * {@link resetlessStaleMaxAgeSeconds}; `never` is for a provider whose window
 * kind does not fix a cycle length it could be aged against.
 */
export type ResetlessStalePolicy = "age_bound" | "never";

/**
 * The cached windows a stale fallback may still present at `now`.
 *
 * A window whose own reported reset is at or before `now` belongs to a cycle
 * the vendor has already ended, so its figures have stopped being true and it
 * is dropped. A window without a usable reset is kept only while the snapshot
 * is younger than the shortest cycle its duration or kind admits: after that
 * long a reset has certainly happened, even though the vendor never said when.
 * A resetless window with no known cycle length (credits balances, model or
 * unknown windows without `windowSeconds`) has no age at which that holds, so
 * it is dropped rather than given an invented shelf life, and so is every
 * resetless window when the snapshot's `refreshedAt` cannot be read. A
 * `refreshedAt` after `now` means the clock moved backwards since the write,
 * so the snapshot's age is unknowable and nothing is served.
 */
export function servableStaleWindows(
  cached: ProviderQuota,
  now: number,
  resetless: ResetlessStalePolicy = "age_bound",
): QuotaWindow[] {
  const refreshedAt = cached.state.refreshedAt
    ? Date.parse(cached.state.refreshedAt)
    : Number.NaN;
  if (refreshedAt > now) return [];
  const ageMilliseconds = now - refreshedAt;
  return cached.windows.filter((window) => {
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (Number.isFinite(resetsAt)) return resetsAt > now;
    if (resetless === "never" || !Number.isFinite(refreshedAt)) return false;
    const maxAgeSeconds = resetlessStaleMaxAgeSeconds(window);
    return maxAgeSeconds > 0 && ageMilliseconds < maxAgeSeconds * 1_000;
  });
}

/**
 * The cached `untrustedWindowIds` a stale report built from `windows` may
 * still carry: an id naming a cached window the stale filter dropped goes with
 * it, while an id that never named a cached window (such as Kimi's
 * `usages:<key>` marker for a declared entry with no usable ratio) stays,
 * because it still keeps the account bound partial.
 */
export function servableUntrustedWindowIds(
  cached: ProviderQuota,
  windows: QuotaWindow[],
): string[] | undefined {
  const served = new Set(windows.map(({ id }) => id));
  const dropped = new Set(
    cached.windows.map(({ id }) => id).filter((id) => !served.has(id)),
  );
  const ids = cached.state.untrustedWindowIds?.filter((id) => !dropped.has(id));
  return ids && ids.length > 0 ? ids : undefined;
}

/**
 * The longest a resetless window can be served from cache: its own declared
 * duration, else the shortest cycle its kind admits, else zero (never).
 */
export function resetlessStaleMaxAgeSeconds(window: QuotaWindow): number {
  if (window.windowSeconds !== undefined && window.windowSeconds > 0) {
    return window.windowSeconds;
  }
  switch (window.kind) {
    case "session":
      return FIVE_HOURS_SECONDS;
    case "weekly":
      return WEEK_SECONDS;
    case "monthly":
      return SHORTEST_MONTH_SECONDS;
    default:
      return 0;
  }
}

/**
 * Serve a cached snapshot as a stale reading of the current failure, keeping
 * only the windows {@link servableStaleWindows} still allows. Returns
 * `undefined` when none survive, so the caller reports the failed read exactly
 * as it would with no cache at all.
 */
export function staleFromCache(
  cached: ProviderQuota,
  error: string,
  sourcesTried: string[],
  attempts: SourceAttempt[],
  now: number = Date.now(),
): ProviderQuota | undefined {
  const windows = servableStaleWindows(cached, now);
  if (windows.length === 0) return undefined;
  const state: ProviderQuota["state"] = {
    ...cached.state,
    status: "stale",
    stale: true,
    error,
    sourcesTried: [...new Set([...sourcesTried, "cache"])],
  };
  const untrustedWindowIds = servableUntrustedWindowIds(cached, windows);
  if (untrustedWindowIds) state.untrustedWindowIds = untrustedWindowIds;
  else delete state.untrustedWindowIds;
  return { ...cached, source: "cache", windows, state, attempts };
}

export function statusFromError(error: string): ProviderStatus {
  if (
    error === "keychain_prompt_required" ||
    error === "credentials_expired" ||
    /sign-in|required|reauth|access token expired/i.test(error)
  )
    return "auth_required";
  if (/rate.?limit/i.test(error)) return "rate_limited";
  return "error";
}

/**
 * Attempt order, deduplicated: a source can be attempted twice in one run (a
 * credential store re-read after a delegated refresh), and `sourcesTried`
 * names which sources were tried, not how many times.
 */
export function sourceNames(attempts: SourceAttempt[]): string[] {
  return [...new Set(attempts.map((attempt) => attempt.source))];
}
