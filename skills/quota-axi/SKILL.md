---
name: quota-axi
description: "Report local Claude and Codex quota windows via the quota-axi CLI - remaining percentages, reset times, and provider status read from local auth files, with no routing, recommendation, or provider mutation. Use before deciding whether it is safe to keep spending a provider's quota, when the user asks about usage, rate limits, or remaining quota, or when comparing Claude and Codex headroom."
user-invocable: false
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [quota, rate-limits, claude, codex, cli]
    category: observability
---

# quota-axi

Report local agent-provider quota windows for routing-aware agents.

You do not need quota-axi installed globally - invoke it with `npx -y quota-axi`.

quota-axi is data only: it never routes, recommends, proxies, intercepts, logs in, imports
browser cookies, or mutates provider state. It reads local Claude and Codex auth files and
calls first-party provider usage endpoints; it never launches the Claude CLI, so it cannot
spend the quota it measures.

## When to use

Use quota-axi whenever you need local quota headroom before deciding whether it is safe to
keep working on a provider, when the user asks about usage, rate limits, or remaining quota,
or when comparing Claude and Codex headroom side by side.

## Workflow

1. Run `npx -y quota-axi` for compact TOON output covering both providers' quota windows.
2. Scope to one provider with `--provider claude` or `--provider codex`.
3. Pass `--json` for the normalized machine-readable model instead of TOON.
4. Pass `--full` to include account identity and per-source attempt details.
5. Run `npx -y quota-axi auth` to check local auth-source availability without printing
   secret values.
6. On macOS, Claude Keychain value reads are skipped by default until the user grants access once.
   If quota output reports `reason: keychain_access_required`, tell your user to run
   `quota-axi --allow-keychain-prompt` once and approve Keychain access ("Always Allow").
   After that successful grant, plain `quota-axi` calls reuse the existing Keychain access
   marker to refresh live Claude quota without requiring the flag.

## Usage

```
usage: quota-axi [auth] [flags]
commands[2]:
  (none)=quota, auth
flags[6]:
  --provider <claude,codex>, --json, --full, --allow-keychain-prompt, --help, -v/--version
examples:
  quota-axi
  quota-axi --provider claude
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
- The quota cache at `~/.cache/quota-axi/quotas.json` only ever holds normalized
  non-secret snapshots.
  The Claude Keychain access marker lives alongside it and contains no credential values.
