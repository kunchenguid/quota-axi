# Live Grok exact-source parity

Verified on 2026-07-20 without `--full`. No account identity, credential, raw response body, or provider diagnostic is included.

## quota-axi end-user output

Command:

```sh
pnpm dev -- --provider grok
```

Output:

```text
$ tsx bin/quota-axi.ts -- --provider grok
bin: ~/.no-mistakes/worktrees/6eca570dbcdb/01KY0PTFWVRTR7BFBQRETAPPWR/bin/quota-axi.ts
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2026-07-20T21:38:20.922Z"
providers[1]{provider,plan,source,status,refreshedAt}:
  grok,unknown,web,fresh,"2026-07-20T21:38:20.922Z"
windows[1]{provider,id,label,percentRemaining,resetsAt,state}:
  grok,credits,credits,100,"2026-07-27T19:59:29.000Z",fresh
```

The corresponding normalized JSON fields were:

```json
{
  "provider": "grok",
  "source": "web",
  "windowId": "credits",
  "percentUsed": 0,
  "percentRemaining": 100,
  "resetsAt": "2026-07-27T19:59:29.000Z",
  "prepaidRemaining": 0,
  "status": "fresh"
}
```

## Baby Menu public exact-source result

Baby Menu's public Grok E2E contract identifies its independent source as `grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig`. A read-only, field-limited query of the installed widget's current normalized snapshot returned:

```json
{
  "schemaVersion": 2,
  "source": "grok-credits-grpc-web",
  "operation": "grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig",
  "windowId": "credits",
  "percentUsed": 0,
  "percentRemaining": 100,
  "prepaidRemaining": 0,
  "refreshedAt": "2026-07-20T20:56:01Z"
}
```

Result: both implementations report the same exact consumer operation result for the current weekly window: 0% used, 100% remaining, and 0 prepaid credits. quota-axi additionally decoded the current reset timestamp from its fresh response.
