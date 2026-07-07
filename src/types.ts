export type ProviderId = "claude" | "codex";

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
  source: ProviderSource;
  plan?: string;
  account?: {
    email?: string;
    organization?: string;
    accountId?: string;
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

export type QuotaAxiResponse = {
  generatedAt: string;
  schemaVersion: 2;
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
  status: "available" | "missing" | "invalid" | "expired" | "skipped";
  error?: string;
  credentialPresent?: boolean;
};

export type AuthProviderReport = {
  provider: ProviderId;
  sources: AuthSourceReport[];
};
