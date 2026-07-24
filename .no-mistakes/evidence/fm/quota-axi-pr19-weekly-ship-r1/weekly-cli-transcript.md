# Codex weekly window CLI evidence

This uses the adjacent deterministic app-server fixture as
`QUOTA_AXI_CODEX_BINARY`. The fixture exposes one primary Codex quota window
whose duration is exactly 10,080 minutes (seven days), with 37% used. It exposes
no secondary window.

## Default TOON output

```console
$ node dist/bin/quota-axi.js --provider codex
bin: /Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KY8RF53AC1FTF9HSY4QFZD2E/dist/bin/quota-axi.js
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2026-07-24T00:38:26.686Z"
providers[1]{provider,plan,source,status,refreshedAt}:
  codex,unknown,cli-rpc,fresh,"2026-07-24T00:38:26.685Z"
windows[1]{provider,id,label,percentRemaining,resetsAt,state}:
  codex,weekly,week,63,unknown,fresh
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
```

## JSON output

```console
$ node dist/bin/quota-axi.js --provider codex --json
{
  "generatedAt": "2026-07-24T00:38:26.754Z",
  "schemaVersion": 2,
  "providers": [
    {
      "provider": "codex",
      "label": "Codex",
      "source": "cli-rpc",
      "windows": [
        {
          "id": "weekly",
          "label": "week",
          "kind": "weekly",
          "percentUsed": 37,
          "windowSeconds": 604800,
          "percentRemaining": 63
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false,
        "refreshedAt": "2026-07-24T00:38:26.753Z",
        "sourcesTried": [
          "oauth",
          "cli-rpc"
        ]
      }
    }
  ]
}
```

The observed CLI surface derives the weekly identity from the exact duration,
even though the provider placed the seven-day window in the primary slot and
omitted the secondary slot.
