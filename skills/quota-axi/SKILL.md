---
name: quota-axi
description: "Report local Claude, Codex, Cursor, GitHub Copilot, Grok, Kimi, Z.AI, OpenCode Go, and Antigravity quota windows via the quota-axi CLI - remaining effective usable runway, percentages, reset times, cycle-average pace vs the reset clock, a per-scope selection signal, and provider status read from local auth sources, with no routing, no credential minting, and no default ordering preference. Use before deciding whether it is safe to keep spending a provider's quota, when the user asks about usage, rate limits, pace, or remaining quota, or when comparing local provider headroom."
user-invocable: false
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags:
      - quota
      - rate-limits
      - pace
      - claude
      - codex
      - cursor
      - copilot
      - grok
      - kimi
      - zai
      - opencode-go
      - agy
      - antigravity
      - cli
    category: observability
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

- `npx -y quota-axi` - default TOON report
- `npx -y quota-axi --help` - commands and flags
- `npx -y quota-axi --json` / `npx -y quota-axi --full` - current output shape and field semantics
