---
name: quota-axi
description: "Report local Claude, Codex, Cursor, GitHub Copilot, and Grok quota windows via the quota-axi CLI - remaining percentages, reset times, and provider status read from local auth sources, with no routing, recommendation, or provider mutation. Use before deciding whether it is safe to keep spending a provider's quota, when the user asks about usage, rate limits, or remaining quota, or when comparing local provider headroom."
user-invocable: false
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [quota, rate-limits, claude, codex, cursor, copilot, grok, cli]
    category: observability
---

# quota-axi

Report local agent-provider quota windows for routing-aware agents.

You do not need quota-axi installed globally - invoke it with `npx -y quota-axi`.

quota-axi is data only: it never routes, recommends, proxies, intercepts, logs in, imports
browser cookies, or mutates provider state. It reads local provider auth sources and calls
first-party provider quota, usage, billing, or entitlement endpoints; it never launches the
Claude CLI, so it cannot spend the quota it measures.

## When to use

Use quota-axi whenever you need local quota headroom before deciding whether it is safe to
keep working on a provider, when the user asks about usage, rate limits, or remaining quota,
or when comparing supported local provider headroom side by side.

## Workflow

1. Run `npx -y quota-axi` for compact TOON output covering supported providers' quota windows.
2. Scope to one provider with `--provider claude` or to a subset with `--provider cursor,copilot,grok`.
3. For multiple Claude subscriptions, repeat `--claude-config-dir <path>` or set the quoted,
   platform-delimited `CLAUDE_CONFIG_DIRS` environment variable. Every selected seat is read only
   and appears under a non-secret basename label.
4. Pass `--json` for the normalized machine-readable model instead of TOON.
5. Pass `--full` to include account identity and per-source attempt details.
6. Run `npx -y quota-axi auth` to check local auth-source availability without printing
   secret values.
7. On macOS, Claude Keychain value reads are skipped by default until the user grants access once.
   If quota output reports `reason: keychain_access_required`, tell your user to run
   `quota-axi --allow-keychain-prompt` once and approve Keychain access ("Always Allow").
   After that successful grant, plain `quota-axi` calls reuse the existing Keychain access
   marker to refresh live Claude quota without requiring the flag.
8. For a managed Codex installation, set `QUOTA_AXI_CODEX_BINARY` to its absolute executable
   path. quota-axi uses that exact executable for auth inspection and the read-only app-server
   fallback, and fails closed if the override is invalid.

## Usage

```
usage: quota-axi [auth] [flags]
commands[2]:
  (none)=quota, auth
flags[7]:
  --provider <claude,codex,cursor,copilot,grok>, --claude-config-dir <path> (repeatable), --json, --full, --allow-keychain-prompt, --help, -v/--version
examples:
  quota-axi
  quota-axi --provider claude
  quota-axi --provider claude,codex --claude-config-dir ~/.claude-work --claude-config-dir ~/.claude-personal
  quota-axi --provider cursor,copilot,grok
  quota-axi --json
  quota-axi --full
  quota-axi auth
```

## Tips

- Output is TOON-encoded and token-efficient by default; pass `--json` only when you need
  the normalized schema.
- Every quota report carries a top-level `summary` - `availability` is `ok` (every row usable),
  `partial` (some usable), or `unavailable` (none usable), alongside `ok`, `unavailable`, and
  `total` row counts. Read it to get the aggregate verdict without scanning every provider or
  Claude seat; a single seat's 429 never reads as all-Claude-down.
- Exit code 0 covers full and partial availability (at least one provider or seat returned fresh
  or stale data); exit code 1 means every row failed (`summary.availability` is `unavailable`);
  exit code 2 means a usage error.
- Repeated Claude config flags take precedence over `CLAUDE_CONFIG_DIRS`, then the existing
  singular `CLAUDE_CONFIG_DIR`, then the default. Normalized duplicates keep their first position.
- Percentages are not comparable across providers - quota-axi never claims one provider's
  percentage equals another's.
- Claude `--full` output exposes the authoritative OAuth profile `account.uuid` as
  `account.accountId` when Anthropic returns one; otherwise the account identity is explicitly
  marked unverified rather than inferred.
- The quota cache at `~/.cache/quota-axi/quotas.json` only ever holds normalized
  non-secret snapshots. The Claude Keychain access marker lives alongside it and contains no
  credential values; see the README Security Posture for detailed cache behavior.
