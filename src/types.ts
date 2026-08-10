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
  | "cli-rpc"
  | "api"
  | "web"
  | "cache"
  | "override"
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

export type EffectiveRunway = {
  /**
   * `through_reset` means every authoritative bounding window's current-cycle
   * observation reaches its own reset before exhaustion. It is not a finite
   * exhaustion deadline. `unknown` preserves uncertainty rather than deriving
   * a synthetic scope reset from windows with different cycles.
   */
  status:
    | "exhausted_now"
    | "projected_exhaustion"
    | "through_reset"
    | "unknown";
  /** Present for `exhausted_now` and `projected_exhaustion`, never negative. */
  usableRunwaySeconds?: number;
  /** Present for a finite exhaustion result when the snapshot clock is valid. */
  projectedExhaustedAt?: string;
  /** The authoritative bound responsible for a finite effective result. */
  limitingWindowId?: string;
  /** Present for cycle-average projected results, including `through_reset`. */
  projectionConfidence?: "early" | "established";
  /** Present when the conclusion follows the current cycle-average observation. */
  projectionBasis?: "cycle_average";
  /** Bounds that prevent a sound aggregate conclusion when status is `unknown`. */
  unmeasurableWindowIds?: string[];
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
  /**
   * Effective usable runway across every authoritative bounding window, derived
   * from this report's single generatedAt clock. Not cached.
   */
  runway?: EffectiveRunway;
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

/**
 * A single per-flight credential supplied through the uniform credential
 * override contract (see docs/credential-override.md). The token value is
 * never logged, printed, cached, placed in argv, or exported to the
 * environment of any child process quota-axi spawns.
 */
export type CredentialOverride = {
  kind: "bearer";
  token: string;
};

/** Provider-keyed overrides for one flight; absence means local sources. */
export type CredentialOverrideMap = Partial<
  Record<ProviderId, CredentialOverride>
>;

export type ProviderOptions = {
  allowKeychainPrompt: boolean;
  /**
   * Parsed credential-override envelope for this invocation. When an entry
   * exists for a provider, that provider's adapter uses ONLY that credential:
   * no local-source fallback and no stale-cache answer.
   */
  credentialOverrides?: CredentialOverrideMap;
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

/**
 * Feature advertisement in the `auth --json` report so consumers can
 * feature-detect contract support instead of trusting a version string.
 */
export type AuthCapabilities = {
  credentialOverride: {
    /** Envelope schema this build accepts (`{"schema": 1, ...}`). */
    schema: 1;
    /** Credential-override transports this build accepts. */
    transports: ("stdin" | "file")[];
  };
};

/** A coarse editorial classification relative to the current model frontier. */
export type IntelligenceBucket = "high" | "medium" | "low";

/** Native-provider model knowledge used by the `models` evidence join. */
export type ModelCatalogEntry = {
  provider: "claude" | "codex" | "grok" | "kimi";
  id: string;
  label: string;
  intelligence: IntelligenceBucket;
  /** Known model-scoped quota window IDs, without period suffixes. */
  windowIds?: string[];
  /** Human-facing or provider naming aliases, never launch identifiers. */
  aliases?: string[];
  notes?: string;
};

export type ModelCatalog = {
  /** ISO calendar date for this reviewed catalog snapshot. */
  version: string;
  provenance: string;
  entries: ModelCatalogEntry[];
};

export type ProviderStateSummary = Pick<
  ProviderQuota["state"],
  "status" | "stale" | "authStatus" | "reason" | "remedyCommand"
>;

export type ModelQuotaRecord = {
  provider: ModelCatalogEntry["provider"];
  id: string;
  label: string;
  intelligence: IntelligenceBucket;
  /** The effective availability scope used as evidence for this row. */
  quotaScopes: string[];
  /** Omitted when quota relationships are unavailable or unknown. */
  effective?: EffectiveAvailability;
  state: ProviderStateSummary;
};

export type ModelReference = Pick<ModelQuotaRecord, "provider" | "id">;

/** Opt-in ordering keys. Future keys require their own evidence and docs. */
export type ModelSortKey = "runway";

export type ModelSortResult = {
  key: ModelSortKey;
  /** Groups with equal comparator evidence, never hidden behind array order. */
  tieGroups: ModelReference[][];
};

export type ModelsResponse = {
  generatedAt: string;
  schemaVersion: 1;
  catalog: Pick<ModelCatalog, "version" | "provenance">;
  models: ModelQuotaRecord[];
  /** Provider/model window scopes with no corresponding catalog entry. */
  unmatchedWindowIds?: string[];
  /** Present only when an explicit comparator was requested. */
  sort?: ModelSortResult;
};
