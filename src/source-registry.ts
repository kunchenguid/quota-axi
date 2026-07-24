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
      "authoritative",
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
      "authoritative",
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
  runpod: [
    source(
      "runpod",
      "first-party-api",
      "authoritative",
      "RUNPOD_API_KEY via env/Keychain",
      "test/providers/runpod.test.ts",
      10,
    ),
  ],
  fireworks: [
    source(
      "fireworks",
      "first-party-api",
      "authoritative",
      "FIREWORKS_API_KEY via env/Keychain",
      "test/providers/fireworks.test.ts",
      10,
    ),
  ],
  daytona: [
    source(
      "daytona",
      "first-party-api",
      "authoritative",
      "DAYTONA_API_TOKEN via env/Keychain",
      "test/providers/daytona.test.ts",
      10,
    ),
  ],
  "inference.net": [
    source(
      "inference.net",
      "official-cli",
      "authoritative",
      "inf CLI auth",
      "test/providers/inference.test.ts",
      10,
    ),
  ],
  nvidia: [
    source(
      "nvidia",
      "local-store",
      "authoritative",
      "local 40 RPM limiter",
      "test/providers/nvidia.test.ts",
      10,
    ),
  ],
  antigravity: [
    source(
      "antigravity",
      "official-cli",
      "authoritative",
      "agy CLI via bounded tmux /usage probe",
      "test/providers/antigravity.test.ts",
      10,
    ),
  ],
};

export function preferredSources(
  provider: ProviderId,
): readonly ProviderSourceDescriptor[] {
  return [...SOURCE_CATALOG[provider]].sort((a, b) => a.order - b.order);
}
