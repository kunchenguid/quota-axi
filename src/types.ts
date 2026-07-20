export type ProviderId = "claude" | "codex" | "cursor" | "copilot" | "grok";

export const PROVIDER_IDS = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "grok",
] as const satisfies readonly ProviderId[];

export type ProviderSource =
  | "oauth"
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

export type ProviderStateReason = "keychain_access_required";

export type QuotaWindow = {
  id: string;
  label: string;
  kind: "session" | "weekly" | "monthly" | "model" | "credits" | "unknown";
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: string;
  resetText?: string;
  windowSeconds?: number;
  spentUsd?: number;
  limitUsd?: number;
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
  /** Stable, non-secret Claude config label; present only in multi-seat output. */
  seat?: string;
  source: ProviderSource;
  plan?: string;
  account?: {
    email?: string;
    organization?: string;
    accountId?: string;
    identityStatus?: "verified" | "unverified";
  };
  windows: QuotaWindow[];
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
    reason?: ProviderStateReason;
    remedyCommand?: string;
    sourcesTried: string[];
  };
  attempts?: SourceAttempt[];
};

/**
 * Aggregate availability across every selected provider row (each Claude seat
 * counts as one row). Lets an agent read the fleet verdict without scanning
 * every provider: `ok` = all rows usable, `partial` = some usable, `unavailable`
 * = none usable. A single seat's 429 therefore cannot read as all-Claude-down.
 */
export type AggregateAvailability = "ok" | "partial" | "unavailable";

export type QuotaSummary = {
  availability: AggregateAvailability;
  /** Rows that returned usable data (status fresh or stale). */
  ok: number;
  /** Rows that failed (auth_required, rate_limited, unavailable, error). */
  unavailable: number;
  total: number;
};

export type QuotaAxiResponse = {
  generatedAt: string;
  schemaVersion: 2;
  summary: QuotaSummary;
  providers: ProviderQuota[];
  help?: string[];
};

export type ProviderOptions = {
  allowKeychainPrompt: boolean;
  /** Resolved Claude config directory. Other provider adapters ignore it. */
  claudeConfigDir?: string;
  /** Literal normalized profile identity used by Claude Code's Keychain item. */
  claudeKeychainIdentity?: string;
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
  status: "available" | "missing" | "invalid" | "expired" | "skipped";
  error?: string;
  credentialPresent?: boolean;
};

export type AuthProviderReport = {
  provider: ProviderId;
  /** Stable, non-secret Claude config label; present only in multi-seat output. */
  seat?: string;
  sources: AuthSourceReport[];
};
