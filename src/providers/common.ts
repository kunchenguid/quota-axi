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
  untrustedWindowIds?: string[];
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
      ...(args.untrustedWindowIds && args.untrustedWindowIds.length > 0
        ? { untrustedWindowIds: args.untrustedWindowIds }
        : {}),
    },
    attempts: args.attempts,
  };
}

export function staleFromCache(
  cached: ProviderQuota,
  error: string,
  sourcesTried: string[],
  attempts: SourceAttempt[],
): ProviderQuota {
  return {
    ...cached,
    source: "cache",
    state: {
      ...cached.state,
      status: "stale",
      stale: true,
      error,
      sourcesTried: [...new Set([...sourcesTried, "cache"])],
    },
    attempts,
  };
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
