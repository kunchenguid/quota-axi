import type { ProviderId } from "./types.js";

// SourceMethod describes how quota facts are collected, not how work is routed.
// The order is a trust/fallback order: lower numbers are preferred.
export type SourceMethod =
  | "first-party-api"
  | "official-cli"
  | "local-store"
  | "browser-cdp"
  | "dom-scrape"
  | "interception";

export type SourceConfidence =
  | "authoritative"
  | "verified"
  | "fallback"
  | "diagnostic";

export type ProviderSourceDescriptor = {
  provider: ProviderId;
  method: SourceMethod;
  confidence: SourceConfidence;
  credentialSource: string;
  proofFixture: string;
  order: number;
};

const source = (
  provider: ProviderId,
  method: SourceMethod,
  confidence: SourceConfidence,
  credentialSource: string,
  proofFixture: string,
  order: number,
): ProviderSourceDescriptor => ({
  provider,
  method,
  confidence,
  credentialSource,
  proofFixture,
  order,
});

// This catalog is deliberately declarative. Adapters remain responsible for
// fetching data; this registry prevents a fallback source from becoming the
// implicit authority when a provider adds a better endpoint later.
export const SOURCE_CATALOG: Record<
  ProviderId,
  readonly ProviderSourceDescriptor[]
> = {
  claude: [
    source(
      "claude",
      "first-party-api",
      "authoritative",
      "OAuth/Keychain",
      "test/providers/claude.test.ts",
      10,
    ),
    source(
      "claude",
      "official-cli",
      "verified",
      "Claude CLI",
      "test/providers/claude.test.ts",
      20,
    ),
    source(
      "claude",
      "browser-cdp",
      "fallback",
      "browser session",
      "test/providers/claude.test.ts",
      30,
    ),
  ],
  codex: [
    source(
      "codex",
      "first-party-api",
      "authoritative",
      "OAuth auth.json",
      "test/providers/codex.test.ts",
      10,
    ),
    source(
      "codex",
      "official-cli",
      "verified",
      "Codex app-server",
      "test/providers/codex-built-cli-weekly.test.ts",
      20,
    ),
    source(
      "codex",
      "browser-cdp",
      "fallback",
      "browser session",
      "test/providers/codex.test.ts",
      30,
    ),
  ],
  cursor: [
    source(
      "cursor",
      "first-party-api",
      "authoritative",
      "Cursor local auth",
      "test/providers/cursor.test.ts",
      10,
    ),
    source(
      "cursor",
      "local-store",
      "verified",
      "Cursor state database",
      "test/providers/cursor-auth.test.ts",
      20,
    ),
    source(
      "cursor",
      "browser-cdp",
      "fallback",
      "browser session",
      "test/providers/cursor.test.ts",
      30,
    ),
  ],
  copilot: [
    source(
      "copilot",
      "first-party-api",
      "authoritative",
      "GitHub local auth",
      "test/providers/copilot.test.ts",
      10,
    ),
    source(
      "copilot",
      "local-store",
      "verified",
      "apps.json",
      "test/providers/copilot.test.ts",
      20,
    ),
  ],
  grok: [
    source(
      "grok",
      "first-party-api",
      "authoritative",
      "local session auth",
      "test/providers/grok.test.ts",
      10,
    ),
    source(
      "grok",
      "browser-cdp",
      "fallback",
      "browser session",
      "test/providers/grok.test.ts",
      20,
    ),
  ],
  kimi: [
    source(
      "kimi",
      "first-party-api",
      "authoritative",
      "Pi/Kimi local auth",
      "test/providers/kimi.test.ts",
      10,
    ),
    source(
      "kimi",
      "local-store",
      "verified",
      "Kimi CLI credentials",
      "test/providers/kimi-code-cli-credential.test.ts",
      20,
    ),
    source(
      "kimi",
      "browser-cdp",
      "fallback",
      "browser session",
      "test/providers/kimi.test.ts",
      30,
    ),
  ],
  tokenrouter: [
    source(
      "tokenrouter",
      "first-party-api",
      "authoritative",
      "bridge-secrets Keychain/env",
      "test/providers/tokenrouter.test.ts",
      10,
    ),
  ],
  openrouter: [
    source(
      "openrouter",
      "first-party-api",
      "authoritative",
      "OPENROUTER_API_KEY via env/Keychain",
      "test/providers/openrouter.test.ts",
      10,
    ),
  ],
  pioneer: [
    source(
      "pioneer",
      "first-party-api",
      "authoritative",
      "PIONEER_API_KEY via env/Keychain",
      "test/providers/pioneer.test.ts",
      10,
    ),
  ],
  commandcode: [
    source(
      "commandcode",
      "first-party-api",
      "authoritative",
      "COMMANDCODE_API_KEY via env/Keychain",
      "test/providers/commandcode.test.ts",
      10,
    ),
    source(
      "commandcode",
      "official-cli",
      "verified",
      "Command Code CLI",
      "test/providers/commandcode.test.ts",
      20,
    ),
  ],
};

export function preferredSources(
  provider: ProviderId,
): readonly ProviderSourceDescriptor[] {
  return [...SOURCE_CATALOG[provider]].sort((a, b) => a.order - b.order);
}
