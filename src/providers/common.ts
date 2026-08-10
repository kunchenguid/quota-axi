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

/** Attribution marker for flights flown on a credential-override token. */
export const OVERRIDE_SOURCE = "override" as const satisfies ProviderSource;

/** Truthful result when the provider rejects an override token (401/403). */
export const OVERRIDE_REJECTED_ERROR = "override_rejected";

export type OverrideFlightQuota = {
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
};

/**
 * How an adapter classifies a failed override flight. `rejected` is a
 * definitive 401/403-style refusal of the override token itself; other kinds
 * keep the provider's truthful transient failure and never retry locally.
 */
export type OverrideErrorVerdict =
  | { kind: "rejected" }
  | { kind: "rate_limited"; error: string; retryAfter?: string }
  | {
      kind: "other";
      error: string;
      status?: ProviderStatus;
      retryAfter?: string;
    };

/**
 * Fly one provider request using ONLY the supplied override credential. The
 * contract (docs/credential-override.md): no local credential source is
 * consulted, no stale-cache answer is served, nothing is written to the quota
 * cache, attribution is `source: "override"`, and a definitive provider
 * refusal surfaces as `auth_required` with `override_rejected`.
 */
export async function runOverrideFlight(args: {
  provider: ProviderQuota["provider"];
  label: string;
  token: string;
  fetchWithToken: (token: string) => Promise<OverrideFlightQuota>;
  classifyError: (error: unknown) => OverrideErrorVerdict;
}): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [
    { source: OVERRIDE_SOURCE, status: "failed" },
  ];
  try {
    const quota = await args.fetchWithToken(args.token);
    attempts[0] = { source: OVERRIDE_SOURCE, status: "success" };
    return successProvider({
      provider: args.provider,
      label: args.label,
      source: OVERRIDE_SOURCE,
      plan: quota.plan,
      account: quota.account,
      windows: quota.windows,
      credits: quota.credits,
      refreshedAt: quota.refreshedAt,
      sourcesTried: [OVERRIDE_SOURCE],
      attempts,
    });
  } catch (error) {
    const verdict = args.classifyError(error);
    if (verdict.kind === "rejected") {
      attempts[0] = {
        source: OVERRIDE_SOURCE,
        status: "failed",
        error: OVERRIDE_REJECTED_ERROR,
      };
      return failedProvider({
        provider: args.provider,
        label: args.label,
        status: "auth_required",
        error: OVERRIDE_REJECTED_ERROR,
        sourcesTried: [OVERRIDE_SOURCE],
        attempts,
      });
    }
    attempts[0] = {
      source: OVERRIDE_SOURCE,
      status: "failed",
      error: verdict.error,
    };
    return failedProvider({
      provider: args.provider,
      label: args.label,
      status:
        verdict.kind === "rate_limited"
          ? "rate_limited"
          : (verdict.status ?? statusFromError(verdict.error)),
      error: verdict.error,
      retryAfter: verdict.retryAfter,
      sourcesTried: [OVERRIDE_SOURCE],
      attempts,
    });
  }
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

export function sourceNames(attempts: SourceAttempt[]): string[] {
  return attempts.map((attempt) => attempt.source);
}
