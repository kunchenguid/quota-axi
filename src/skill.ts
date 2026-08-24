// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "check quota/rate limits" intents.
export const SKILL_DESCRIPTION =
  "Report local Claude, Codex, Cursor, GitHub Copilot, Grok, Kimi, Z.AI, OpenCode Go, and Antigravity quota windows via the quota-axi CLI - remaining " +
  "effective usable runway, percentages, reset times, cycle-average pace vs the reset clock, a per-scope selection signal, and provider status read from local auth sources, " +
  "with no routing, no credential minting, and no default ordering preference. Use before deciding whether it is safe " +
  "to keep spending a provider's quota, when the user asks about usage, rate limits, pace, or " +
  "remaining quota, or when comparing local provider headroom.";

export const SKILL_AUTHOR = "Kun Chen (kunchenguid)";

// Extended frontmatter read by Nous Research's Hermes Agent harness
// (https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).
// Harnesses that don't know these fields (e.g. Claude Code) ignore them.
export const HERMES_TAGS = [
  "quota",
  "rate-limits",
  "pace",
  "claude",
  "codex",
  "cursor",
  "copilot",
  "grok",
  "kimi",
  "zai",
  "opencode-go",
  "agy",
  "antigravity",
  "cli",
];
export const HERMES_CATEGORY = "observability";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

function yamlStringList(values: string[], indent: string): string {
  return values.map((value) => `${indent}- ${value}`).join("\n");
}

/**
 * Render the installable SKILL.md as a minimal stub. Frontmatter stays the
 * discovery surface; the body only names what quota-axi is, when to reach for
 * it, and pointers to the live CLI. quota-axi CLI output is the single source
 * of truth - never bake help text, output schema, or field semantics here.
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
    tags:
${yamlStringList(HERMES_TAGS, "      ")}
    category: ${HERMES_CATEGORY}
---

# quota-axi

Report local Claude, Codex, Cursor, GitHub Copilot, Grok, Kimi, Z.AI, OpenCode Go, and Antigravity quota windows.
quota-axi is data only: it never routes, recommends, ranks, or mints credentials. When the same stored
access token is expired, refreshable, and definitively rejected, it delegates renewal to the vendor's
own CLI and re-reads the result.

Use it when you need local quota headroom before deciding whether it is safe to keep spending a
provider, when the user asks about usage, rate limits, pace, or remaining quota, or when comparing
local provider headroom.

For current instructions, output shape, and field semantics, run the CLI (no global install required):

- \`npx -y quota-axi\` - default TOON report
- \`npx -y quota-axi --help\` - commands and flags
- \`npx -y quota-axi --json\` / \`npx -y quota-axi --full\` - current output shape and field semantics
`;
}
