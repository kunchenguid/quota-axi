export type ProviderId =
  | "claude"
  | "codex"
  | "cursor"
  | "copilot"
  | "grok"
  | "kimi";

export const PROVIDER_IDS = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "grok",
  "kimi",
] as const satisfies readonly ProviderId[];

export type ProviderSource =
  | "oauth"
  | "pi:openai-codex"
  | "cli-rpc"
  | "api"
  | "web"
  | "cache"
  | "unavailable";

export type ProviderStatus =
  | "fresh"
  | "stale"
  | "unavailable"
  | "auth_required"
  | "rate_limited"
  | "error";

/**
 * Machine-readable local auth usability, distinct from quota freshness.
 * Callers must not infer logout from provider status alone when this is set.
 */
export type ProviderAuthStatus = "usable" | "expired_refreshable" | "unusable";

export type ProviderStateReason =
  | "keychain_access_required"
  | "credentials_expired";

export type QuotaPaceStatus = "ahead" | "on_pace" | "behind" | "unknown";

export type QuotaPaceReason =
  | "stale"
  | "missing_usage"
  | "missing_cycle"
  | "invalid_cycle"
  | "future_cycle_start"
  | "expired_reset"
  | "unsupported_period";

export type QuotaPace = {
  status: QuotaPaceStatus;
  /** Present only when status is unknown. */
  reason?: QuotaPaceReason;
  /** 100 * (resetsAt - generatedAt) / cycleDuration. */
  timeRemainingPercent?: number;
  /** 100 * (generatedAt - cycleStart) / cycleDuration. */
  elapsedPercent?: number;
  /**
   * percentRemaining - timeRemainingPercent.
   * Negative means usage is ahead of the reset clock (burning faster than linear).
   * Positive means usage is behind the reset clock.
   */
  reservePercentPoints?: number;
  /** percentUsed / elapsedPercent when elapsedPercent > 0. */
  burnMultiple?: number;
  /** Linear cycle-average exhaustion timestamp when defined. */
  projectedExhaustedAt?: string;
  projectionConfidence?: "early" | "established";
  /** Currently cycle-average; reserved for future bases. */
  projectionBasis?: "cycle_average";
  cycleBasis?: "starts_at_resets_at" | "window_seconds";
  cycleSeconds?: number;
};

export type EffectivePaceSummary = {
  /**
   * Aggregate across every bounding window for this scope.
   * `worstReservePercentPoints` is the most negative (most ahead) signed reserve
   * among windows with known pace; it is not a routing score.
   */
  status: "ahead" | "on_pace" | "behind" | "mixed" | "unknown";
  aheadWindowIds?: string[];
  behindWindowIds?: string[];
  onPaceWindowIds?: string[];
  unknownWindowIds?: string[];
  worstReservePercentPoints?: number;
  worstReserveWindowId?: string;
};

export type QuotaWindow = {
  id: string;
  label: string;
  kind: "session" | "weekly" | "monthly" | "model" | "credits" | "unknown";
  percentUsed?: number;
  percentRemaining?: number;
  startsAt?: string;
  resetsAt?: string;
  resetText?: string;
  windowSeconds?: number;
  spentUsd?: number;
  limitUsd?: number;
  /** Cycle-average pace relative to generatedAt. Not cached. */
  pace?: QuotaPace;
};

export type EffectiveAvailability = {
  scope: string;
  status: "known" | "unknown";
  effectivePercentRemaining?: number;
  boundedBy: string[];
  limitingWindowIds?: string[];
  /** Compact pace over every bounding window, not only the current limiter. */
  pace?: EffectivePaceSummary;
};

export type QuotaSemantics = {
  status: "known" | "partial" | "unknown";
  description: string;
  effectiveAvailability: EffectiveAvailability[];
  unresolvedWindowIds?: string[];
};

export type SourceAttempt = {
  source: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  credentialPresent?: boolean;
};

export type ProviderQuota = {
  provider: ProviderId;
  label: string;
  source: ProviderSource;
  plan?: string;
  account?: {
    email?: string;
    organization?: string;
    accountId?: string;
    identityStatus?: "verified" | "unverified";
  };
  windows: QuotaWindow[];
  quotaSemantics?: QuotaSemantics;
  credits?: {
    remaining?: number;
    unlimited?: boolean;
    unit?: "usd" | "credits";
  };
  state: {
    status: ProviderStatus;
    stale: boolean;
    refreshedAt?: string;
    error?: string;
    retryAfter?: string;
    /**
     * Local credential usability independent of quota windows.
     * `expired_refreshable` is soft expiry (not sign-out); `usable` may still
     * have unknown consumer quota (for example Pi xAI model auth only).
     */
    authStatus?: ProviderAuthStatus;
    reason?: ProviderStateReason;
    remedyCommand?: string;
    untrustedWindowIds?: string[];
    sourcesTried: string[];
  };
  attempts?: SourceAttempt[];
};

export type QuotaAxiResponse = {
  generatedAt: string;
  schemaVersion: 3;
  providers: ProviderQuota[];
  help?: string[];
};

export type ProviderOptions = {
  allowKeychainPrompt: boolean;
};

export type ProviderAdapter = {
  id: ProviderId;
  label: string;
  fetchQuota(options: ProviderOptions): Promise<ProviderQuota>;
  inspectAuth(options: ProviderOptions): Promise<AuthProviderReport>;
};

export type AuthSourceReport = {
  source: string;
  path?: string;
  status: "available" | "missing" | "invalid" | "expired" | "skipped" | "error";
  error?: string;
  credentialPresent?: boolean;
};

export type AuthProviderReport = {
  provider: ProviderId;
  sources: AuthSourceReport[];
};
