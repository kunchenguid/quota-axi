export type BillingMode =
  | "subscription"
  | "metered-api"
  | "hybrid"
  | "unsupported"
  | "unknown-unproven";

export type ProviderCoverage = {
  provider: string;
  source: string;
  billingMode: BillingMode;
  coverage: "supported" | "unsupported";
  allowance: "available" | "unavailable";
  command?: string;
  reason: string;
  requires?: string;
};

export const PROVIDER_COVERAGE: readonly ProviderCoverage[] = [
  {
    provider: "claude",
    source: "claude-code-oauth",
    billingMode: "subscription",
    coverage: "supported",
    allowance: "available",
    command: "quota-axi --provider claude",
    reason:
      "Claude Code subscription usage is available from a read-only OAuth usage endpoint.",
  },
  {
    provider: "codex",
    source: "openai-codex-oauth",
    billingMode: "subscription",
    coverage: "supported",
    allowance: "available",
    command: "quota-axi --provider codex",
    reason:
      "ChatGPT-backed Codex limits are available from read-only OAuth usage or app-server sources.",
  },
  {
    provider: "cursor",
    source: "cursor-session",
    billingMode: "hybrid",
    coverage: "supported",
    allowance: "available",
    command: "quota-axi --provider cursor",
    reason:
      "Cursor can expose included plan usage and an optional usage-based spend limit.",
  },
  {
    provider: "copilot",
    source: "github-copilot-session",
    billingMode: "hybrid",
    coverage: "supported",
    allowance: "available",
    command: "quota-axi --provider copilot",
    reason:
      "Copilot exposes plan allowances and can permit separately budgeted paid premium requests.",
  },
  {
    provider: "grok",
    source: "grok-consumer-session",
    billingMode: "hybrid",
    coverage: "supported",
    allowance: "available",
    command: "quota-axi --provider grok",
    reason:
      "Grok consumer usage can combine recurring product limits with prepaid credits.",
  },
  {
    provider: "kimi",
    source: "pi:kimi-coding",
    billingMode: "subscription",
    coverage: "supported",
    allowance: "available",
    command: "quota-axi --provider kimi",
    reason:
      "The Kimi Coding credential accesses membership usage limits, not Moonshot token billing.",
  },
  {
    provider: "kimi",
    source: "kimi-code-cli",
    billingMode: "subscription",
    coverage: "supported",
    allowance: "available",
    command: "quota-axi --provider kimi",
    reason:
      "The existing Kimi Code CLI session accesses the same membership usage limits.",
  },
  {
    provider: "openai",
    source: "api-key",
    billingMode: "metered-api",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "OpenAI Platform API usage is metered; quota-axi never makes metered API or billing calls.",
    requires:
      "A separately authorized read-only organization billing API and an explicit metered-source policy.",
  },
  {
    provider: "deepseek",
    source: "api-key",
    billingMode: "metered-api",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "DeepSeek API usage is metered; a configured API key is not a subscription allowance.",
    requires:
      "An explicit metered-source policy before using the first-party balance API.",
  },
  {
    provider: "moonshotai",
    source: "api-key",
    billingMode: "metered-api",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "Moonshot platform API usage is token-metered and is distinct from Kimi Coding membership.",
    requires:
      "An explicit metered-source policy and a first-party read-only balance API.",
  },
  {
    provider: "zai",
    source: "coding-plan-api-key",
    billingMode: "subscription",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "The configured Z.AI coding endpoint is subscription-backed, but quota-axi has no adapter for its limits.",
    requires:
      "A documented read-only Coding Plan usage API and fixture-backed adapter.",
  },
  {
    provider: "xai",
    source: "oauth",
    billingMode: "subscription",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "The Pi xAI OAuth source is subscription-backed but is not inspected by the current Grok adapter.",
    requires: "Read-only support for the configured Pi xAI OAuth source.",
  },
  {
    provider: "xai",
    source: "api-key",
    billingMode: "metered-api",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "xAI API billing is separate from Grok subscriptions and is metered.",
    requires:
      "An explicit metered-source policy before using a first-party billing API.",
  },
  {
    provider: "opencode-go",
    source: "api-key",
    billingMode: "subscription",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "OpenCode Go is subscription-backed, but no supported read-only usage endpoint is available.",
    requires:
      "An official read-only usage endpoint authenticated by the existing Go credential.",
  },
  {
    provider: "antigravity",
    source: "local-rpc",
    billingMode: "unknown-unproven",
    coverage: "unsupported",
    allowance: "unavailable",
    reason:
      "The local quota payload does not prove which billing entitlement backs each model bucket.",
    requires:
      "Authoritative billing-mode evidence and an official read-only JSON or already-running local API.",
  },
];
