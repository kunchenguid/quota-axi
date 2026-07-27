---
name: quota-axi
description: "Report local Claude, Codex, Cursor, GitHub Copilot, Grok, and Kimi quota windows via the quota-axi CLI - remaining percentages, reset times, and provider status read from local auth sources, with no routing, recommendation, or provider mutation. Use before deciding whether it is safe to keep spending a provider's quota, when the user asks about usage, rate limits, or remaining quota, or when comparing local provider headroom."
user-invocable: false
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [quota, rate-limits, claude, codex, cursor, copilot, grok, kimi, cli]
    category: observability
---

# quota-axi

Report local agent-provider quota windows for routing-aware agents.

You do not need quota-axi installed globally - invoke it with `npx -y quota-axi`.

quota-axi is data only: it never routes, recommends, proxies, intercepts, logs in, imports
browser cookies, or mutates provider state. It reads local provider auth sources and calls
first-party provider quota, usage, billing, or entitlement endpoints; it never launches the
Claude, Grok, Pi, or Kimi CLIs, so it cannot spend the quota it measures.

## When to use

Use quota-axi whenever you need local quota headroom before deciding whether it is safe to
keep working on a provider, when the user asks about usage, rate limits, or remaining quota,
or when comparing supported local provider headroom side by side.

## Workflow

1. Run `npx -y quota-axi` for compact TOON output covering supported providers' quota windows.
2. Scope to one provider with `--provider claude` or to a subset with `--provider cursor,copilot,grok,kimi`.
3. Pass `--json` for the normalized machine-readable model instead of TOON. Read
   `quotaSemantics.effectiveAvailability` rather than treating a model window in isolation:
   account windows can bound every model, and `boundedBy` names every window included in the
   effective percentage. If relationship status is `partial` or `unknown`, do not infer one.
   Stale reports keep raw windows for diagnostics, but effective availability is always unknown;
   never route from a stale raw percentage as though it were current headroom.
4. Pass `--full` to include account identity and per-source attempt details.
5. Run `npx -y quota-axi auth` to check local auth-source availability without printing
   secret values.
6. On macOS, Claude Keychain value reads are pinned to the same validated current-user account
   Claude Code selects and are skipped by default until the user grants access once.
   If quota output reports `reason: keychain_access_required`, tell your user to run
   `quota-axi --allow-keychain-prompt` once and approve Keychain access ("Always Allow").
   After that successful grant, plain `quota-axi` calls reuse the existing Keychain access
   marker, scoped to both profile and account, to refresh live Claude quota without requiring
   the flag. Legacy markers are not reused, so an upgrade may require this one-time grant again.
7. If Grok reports `reason: credentials_expired` (or `error: Grok access token expired`), the
   local session is still signed in but the short-lived access token expired. Tell your user to
   open the Grok CLI (`grok`) once so Grok can refresh its local session token. Do not treat that
   as a full sign-out, and do not ask quota-axi to refresh credentials - it never launches Grok or
   writes auth files. Reserve true sign-in recovery for `Grok sign-in required`.
8. For a managed Codex installation, set `QUOTA_AXI_CODEX_BINARY` to its absolute executable
   path. quota-axi uses that exact executable for auth inspection and the read-only app-server
   fallback, and fails closed if the override is invalid.
9. For Kimi, quota-axi prefers a literal Pi-managed `kimi-coding` API key from
   `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`). If it is
   unavailable, quota-axi may reuse a fresh official Kimi Code CLI access token from
   `$KIMI_CODE_HOME/credentials/kimi-code.json` (default
   `$HOME/.kimi-code/credentials/kimi-code.json`) without refreshing or writing credentials.

## Usage

```
usage: quota-axi [auth] [flags]
commands[2]:
  (none)=quota, auth
flags[6]:
  --provider <claude,codex,cursor,copilot,grok,kimi>, --json, --full, --allow-keychain-prompt, --help, -v/--version
examples:
  quota-axi
  quota-axi --provider claude
  quota-axi --provider cursor,copilot,grok,kimi
  quota-axi --json
  quota-axi --full
  quota-axi auth
```

## Tips

- Output is TOON-encoded and token-efficient by default; pass `--json` only when you need
  the normalized schema.
- Exit code 0 means at least one provider returned data (fresh or stale); exit code 1 means
  every provider failed; exit code 2 means a usage error.
- Percentages are not comparable across providers - quota-axi never claims one provider's
  percentage equals another's.
- Claude `--full` output exposes the authoritative OAuth profile `account.uuid` as
  `account.accountId` when Anthropic returns one; otherwise the account identity is explicitly
  marked unverified rather than inferred.
- The quota cache at `~/.cache/quota-axi/quotas.json` only ever holds normalized
  non-secret snapshots.
  Fresh provider reports with no windows clear stale provider snapshots instead of caching
  empty quota.
  Claude local expiry metadata is advisory when an access token exists: the existing read-only
  usage request decides validity. Missing or invalid credentials without a usable token and HTTP
  401/403 retire Claude cache; only transient failures may use bounded, reset-pruned stale data.
  The Claude Keychain access marker lives alongside it, is scoped by hashed profile and
  account hashes, and contains no credential values or raw account name.
