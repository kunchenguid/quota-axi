import { DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "check quota/rate limits" intents.
export const SKILL_DESCRIPTION =
  "Report local Claude, Codex, Cursor, GitHub Copilot, Grok, and Kimi quota windows via the quota-axi CLI - remaining " +
  "percentages, reset times, cycle-average pace vs the reset clock, and provider status read from local auth sources, " +
  "with no routing, recommendation, or provider mutation. Use before deciding whether it is safe " +
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
Claude, Grok, Pi, or Kimi CLIs, so it cannot spend the quota it measures.

## When to use

Use quota-axi whenever you need local quota headroom before deciding whether it is safe to
keep working on a provider, when the user asks about usage, rate limits, or remaining quota,
or when comparing supported local provider headroom side by side.

## Workflow

1. Run \`npx -y quota-axi\` for compact TOON output covering supported providers' quota windows.
2. Scope to one provider with \`--provider claude\` or to a subset with \`--provider cursor,copilot,grok,kimi\`.
3. Pass \`--json\` for the normalized machine-readable model instead of TOON. Read
   \`quotaSemantics.effectiveAvailability\` rather than treating a model window in isolation:
   account windows can bound every model, and \`boundedBy\` names every window included in the
   effective percentage. Read each window's \`pace\` (and the effective scope's pace summary) to
   distinguish raw remaining capacity from whether usage is ahead of or behind the reset clock:
   negative \`reservePercentPoints\` means ahead/conserve. Default TOON already shows \`pace\` and
   signed \`reserve\` on window rows. If relationship status is \`partial\` or \`unknown\`, do not
   infer one. Stale reports keep raw windows for diagnostics, but effective availability and pace
   are always unknown; never route from a stale raw percentage as though it were current headroom.
   quota-axi never recommends a provider, model, or route.
4. Pass \`--full\` to include account identity and per-source attempt details.
5. Run \`npx -y quota-axi auth\` to check local auth-source availability without printing
   secret values.
6. On macOS, Claude Keychain value reads are pinned to the same validated current-user account
   Claude Code selects and are skipped by default until the user grants access once.
   If quota output reports \`reason: keychain_access_required\`, tell your user to run
   \`quota-axi --allow-keychain-prompt\` once and approve Keychain access ("Always Allow").
   After that successful grant, plain \`quota-axi\` calls reuse the existing Keychain access
   marker, scoped to both profile and account, to refresh live Claude quota without requiring
   the flag. Legacy markers are not reused, so an upgrade may require this one-time grant again.
7. For Grok, read \`state.authStatus\` before any logout wording. \`expired_refreshable\` means a
   local session still looks signed in but short-lived access expired. Only when quota-axi also
   emits \`reason: credentials_expired\` / \`remedyCommand: grok\` should you tell your user to
   open the Grok CLI once; Pi-only expiry has no Grok remedy because Grok cannot refresh Pi-owned
   credentials. Do not treat soft expiry as full sign-out, and do not ask quota-axi to refresh
   credentials - it never launches Grok or Pi or writes auth files. \`authStatus: usable\` with
   empty windows means model auth is present (Grok CLI and/or Pi \`xai\`) while consumer credit
   windows are unknown - not logged out. Reserve true sign-in recovery for
   \`authStatus: unusable\` / \`Grok sign-in required\`.
8. Codex checks its native OAuth file first, then Pi's \`openai-codex\` subscription OAuth
   entry in \`$PI_CODING_AGENT_DIR/auth.json\` (default \`~/.pi/agent/auth.json\`), then the
   read-only app-server fallback. quota-axi only reads Pi's unexpired token and account ID; it
   never refreshes or writes Pi credentials. For a managed Codex installation, set
   \`QUOTA_AXI_CODEX_BINARY\` to its absolute executable path. quota-axi uses that exact
   executable for auth inspection and the fallback, and fails closed if the override is invalid.
   Native Codex OAuth availability follows the access token, not id_token expiry alone.
9. For Kimi, quota-axi prefers a literal Pi-managed \`kimi-coding\` API key from
   \`$PI_CODING_AGENT_DIR/auth.json\` (default \`~/.pi/agent/auth.json\`). If it is
   unavailable, quota-axi may reuse a fresh official Kimi Code CLI access token from
   \`$KIMI_CODE_HOME/credentials/kimi-code.json\` (default
   \`$HOME/.kimi-code/credentials/kimi-code.json\`) without refreshing or writing credentials.
   Grok also reads that same Pi auth file for an independent \`xai\` OAuth or literal API-key
   entry and treats Grok as usable when either the Grok CLI session or Pi \`xai\` credential is
   valid.

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
  Claude local expiry metadata is advisory when an access token exists: the existing read-only
  usage request decides validity. Missing or invalid credentials without a usable token and HTTP
  401/403 retire Claude cache; only transient failures may use bounded, reset-pruned stale data.
  The Claude Keychain access marker lives alongside it, is scoped by hashed profile and
  account hashes, and contains no credential values or raw account name.
`;
}
