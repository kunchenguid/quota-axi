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

export function staleFromCache(
  cached: ProviderQuota,
  error: string,
  sourcesTried: string[],
  attempts: SourceAttempt[],
  /**
   * Retry hint from the live attempt that forced the fallback. Serving stale
   * data must not silently drop an authoritative `Retry-After`: the row still
   * needs to say when a fresh read becomes possible again.
   */
  retryAfter?: string,
): ProviderQuota {
  return {
    ...cached,
    source: "cache",
    state: {
      ...cached.state,
      status: "stale",
      stale: true,
      error,
      ...(retryAfter ? { retryAfter } : {}),
      sourcesTried: [...new Set([...sourcesTried, "cache"])],
    },
    attempts,
  };
}

export function statusFromError(error: string): ProviderStatus {
  if (
    error === "keychain_prompt_required" ||
    /sign-in|required|reauth/i.test(error)
  )
    return "auth_required";
  if (/rate.?limit/i.test(error)) return "rate_limited";
  return "error";
}

export function sourceNames(attempts: SourceAttempt[]): string[] {
  return attempts.map((attempt) => attempt.source);
}
