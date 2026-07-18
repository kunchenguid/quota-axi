import { DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "check quota/rate limits" intents.
export const SKILL_DESCRIPTION =
  "Report local Claude, Codex, Cursor, GitHub Copilot, and Grok quota windows via the quota-axi CLI - remaining " +
  "percentages, reset times, and provider status read from local auth sources, with no " +
  "routing, recommendation, or provider mutation. Use before deciding whether it is safe " +
  "to keep spending a provider's quota, when the user asks about usage, rate limits, or " +
  "remaining quota, or when comparing local provider headroom.";

export const SKILL_AUTHOR = "Kun Chen (kunchenguid)";

// Extended frontmatter read by Nous Research's Hermes Agent harness
// (https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).
// Harnesses that don't know these fields (e.g. Claude Code) ignore them.
export const HERMES_TAGS = [
  "quota",
  "rate-limits",
  "claude",
  "codex",
  "cursor",
  "copilot",
  "grok",
  "cli",
];
export const HERMES_CATEGORY = "observability";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the installable SKILL.md for the quota-axi skill. The body uses the
 * same shared CLI description and help text, then adds agent-facing workflow
 * guidance that prefers non-interactive `npx -y quota-axi ...` invocation so
 * the CLI comes along on demand.
 *
 * @returns full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown(): string {
  return `---
name: quota-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# quota-axi

${DESCRIPTION}

You do not need quota-axi installed globally - invoke it with \`npx -y quota-axi\`.

quota-axi is data only: it never routes, recommends, proxies, intercepts, logs in, imports
browser cookies, or mutates provider state. It reads local provider auth sources and calls
first-party provider quota, usage, billing, or entitlement endpoints; it never launches the
Claude CLI, so it cannot spend the quota it measures.

## When to use

Use quota-axi whenever you need local quota headroom before deciding whether it is safe to
keep working on a provider, when the user asks about usage, rate limits, or remaining quota,
or when comparing supported local provider headroom side by side.

## Workflow

1. Run \`npx -y quota-axi\` for compact TOON output covering supported providers' quota windows.
2. Scope to one provider with \`--provider claude\` or to a subset with \`--provider cursor,copilot,grok\`.
3. Pass \`--json\` for the normalized machine-readable model instead of TOON.
4. Pass \`--full\` to include account identity and per-source attempt details.
5. Run \`npx -y quota-axi auth\` to check local auth-source availability without printing
   secret values.
6. On macOS, Claude Keychain value reads are skipped by default until the user grants access once.
   If quota output reports \`reason: keychain_access_required\`, tell your user to run
   \`quota-axi --allow-keychain-prompt\` once and approve Keychain access ("Always Allow").
   After that successful grant, plain \`quota-axi\` calls reuse the existing Keychain access
   marker to refresh live Claude quota without requiring the flag.
7. For a managed Codex installation, set \`QUOTA_AXI_CODEX_BINARY\` to its absolute executable
   path. quota-axi uses that exact executable for auth inspection and the read-only app-server
   fallback, and fails closed if the override is invalid.

## Usage

\`\`\`
${TOP_HELP.trimEnd()}
\`\`\`

## Tips

- Output is TOON-encoded and token-efficient by default; pass \`--json\` only when you need
  the normalized schema.
- Exit code 0 means at least one provider returned data (fresh or stale); exit code 1 means
  every provider failed; exit code 2 means a usage error.
- Percentages are not comparable across providers - quota-axi never claims one provider's
  percentage equals another's.
- Claude \`--full\` output exposes the authoritative OAuth profile \`account.uuid\` as
  \`account.accountId\` when Anthropic returns one; otherwise the account identity is explicitly
  marked unverified rather than inferred.
- The quota cache at \`~/.cache/quota-axi/quotas.json\` only ever holds normalized
  non-secret snapshots.
  Fresh provider reports with no windows clear stale provider snapshots instead of caching
  empty quota.
  The Claude Keychain access marker lives alongside it and contains no credential values.
`;
}
