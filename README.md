<h1 align="center">quota-axi</h1>

<h3 align="center">Your agent needs to be aware of your quota</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/quota-axi"><img alt="npm" src="https://img.shields.io/npm/v/quota-axi?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/quota-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/quota-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://x.com/kunchenguid"><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square" /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord" /></a>
</p>

Quota CLI for agents - designed with [AXI](https://axi.md) (Agent eXperience Interface).

Agents need quota state before they choose where work can safely run.
Vendor dashboards are not shaped for shell automation, and local CLIs expose different windows, resets, and auth sources.

quota-axi reports local Claude, Codex, Cursor, TokenRouter, OpenRouter, Pioneer, Command Code, RunPod, Fireworks, and Daytona quota/account state in one [AXI](https://axi.md)-shaped call.
It is data only: it never routes, recommends, proxies, intercepts, logs in, imports browser cookies, or mutates provider state.

- **Official sources** - quota-axi reads local provider auth sources and calls the first-party quota, usage, billing, or entitlement endpoints used by the local agents, with a read-only Codex app-server probe as fallback.
- **Local first** - quota and auth reports run on the machine that holds the credentials; their network calls go to first-party provider endpoints, never a third-party relay.
  The separate `update` command contacts npm only when the user runs it.
- **Token efficient** - default stdout is compact TOON so agents spend fewer tokens parsing quota state, with `--json` available when a caller needs the normalized model.

## Quick Start

**macOS + Claude note:** Claude Code keeps its live token in the macOS Keychain.
quota-axi will not read that token unless the user grants permission, so Claude quota reads can stay stale until the user grants access after on-disk credentials expire.
Run `quota-axi --allow-keychain-prompt` once and approve Keychain access with "Always Allow".
After a successful Keychain read, future non-interactive quota reads use that existing grant and refresh live Claude data without requiring the flag.

```sh
$ npx -y quota-axi
bin: ~/.npm/_npx/.../quota-axi
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2026-03-15T16:42:00.000Z"
providers[6]{provider,plan,source,status,refreshedAt}:
  claude,pro,oauth,fresh,"2026-03-15T16:41:55.000Z"
  codex,plus,cli-rpc,fresh,"2026-03-15T16:41:58.000Z"
  cursor,pro,api,fresh,"2026-03-15T16:41:59.000Z"
  tokenrouter,managed,api,fresh,"2026-03-15T16:42:00.000Z"
  openrouter,credits,api,fresh,"2026-03-15T16:42:00.000Z"
  pioneer,credits,api,fresh,"2026-03-15T16:42:00.000Z"
windows[15]{provider,id,label,percentRemaining,resetsAt,state}:
  claude,five_hour,session,82,"2026-03-15T21:15:00.000Z",fresh
  claude,seven_day,week,64,"2026-03-19T15:00:00.000Z",fresh
  claude,seven_day_opus,opus week,93,"2026-03-20T09:30:00.000Z",fresh
  claude,"model:fable",Fable week,71,"2026-03-20T09:30:00.000Z",fresh
  codex,five_hour,session,58,"2026-03-15T20:45:00.000Z",fresh
  codex,weekly,week,47,"2026-03-19T09:00:00.000Z",fresh
  codex,"model:gpt-5.1-codex:5h",GPT-5.1-Codex session,100,"2026-03-16T01:41:58.000Z",fresh
  cursor,included_usage,included usage,72,"2026-04-01T00:00:00.000Z",fresh
  cursor,auto_usage,auto usage,91,"2026-04-01T00:00:00.000Z",fresh
  cursor,api_usage,API usage,100,"2026-04-01T00:00:00.000Z",fresh
  tokenrouter,credit_pool,credit pool,40,"2026-04-01T00:00:00.000Z",fresh
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
```

`--json` emits the same normalized model as structured JSON instead of TOON:

```sh
$ quota-axi --provider claude --json
{
  "generatedAt": "2026-03-15T16:42:03.000Z",
  "schemaVersion": 2,
  "providers": [
    {
      "provider": "claude",
      "label": "Claude",
      "source": "oauth",
      "plan": "pro",
      "windows": [
        {
          "id": "five_hour",
          "label": "session",
          "kind": "session",
          "percentUsed": 18,
          "percentRemaining": 82,
          "resetsAt": "2026-03-15T21:15:00.000Z"
        },
        {
          "id": "model:fable",
          "label": "Fable week",
          "kind": "model",
          "percentUsed": 29,
          "percentRemaining": 71,
          "resetsAt": "2026-03-20T09:30:00.000Z"
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false,
        "sourcesTried": ["oauth", "oauth-profile"],
        "refreshedAt": "2026-03-15T16:41:55.000Z"
      }
    }
  ]
}
```

```sh
$ quota-axi auth
bin: ~/.npm/_npx/.../quota-axi
description: Inspect local quota auth sources without printing secret values
auth[9]{provider,source,path,status,error}:
  claude,oauth-file,~/.claude/.credentials.json,available,none
  claude,keychain,none,skipped,keychain_prompt_required
  codex,auth-json,~/.codex/auth.json,available,none
  codex,cli-rpc,~/.local/bin/codex,available,none
  cursor,state-vscdb,~/Library/Application Support/Cursor/User/globalStorage/state.vscdb,available,none
  tokenrouter,env,none,available,none
help[1]:
  Run `quota-axi --allow-keychain-prompt auth` to permit macOS Keychain access
```

## Install

quota-axi requires Node.js 22.19 or newer.

**Agent skill (recommended)**

Install the skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/quota-axi --skill quota-axi -g
```

The skill teaches your agent to run quota-axi through `npx -y quota-axi` on demand, so nothing needs to be installed ahead of time.
`-g` installs the skill for all projects (e.g. `~/.claude/skills/`); drop it to install for the current project only (`.claude/skills/`).

**Direct use**

```sh
npx -y quota-axi
```

**npm**

```sh
npm install -g quota-axi
```

**From source**

```sh
git clone https://github.com/kunchenguid/quota-axi.git
cd quota-axi
pnpm install
pnpm run build
pnpm run dev
```

## Agent Skill

The npm package includes `skills/quota-axi/SKILL.md`, the same installable skill recommended above.
It is generated from `src/skill.ts`; update it with `pnpm run build:skill` and verify it with `pnpm run build:skill -- --check`.

## How It Works

```
┌────────────┐
│ quota-axi  │
└─────┬──────┘
      ▼
┌───────────────┐
│ provider      │
│ adapters      │
└─────┬─────────┘
      ▼
┌───────────────┐       ┌──────────────┐
│ local auth    │ ───▶  │ first-party  │
│ sources       │       │ provider APIs│
└─────┬─────────┘       └──────┬───────┘
      ▼                        ▼
┌───────────────┐       ┌──────────────┐
│ read-only     │ ───▶  │ normalized   │
│ fallbacks     │       │ quota model  │
└─────┬─────────┘       └──────┬───────┘
      ▼                        ▼
┌───────────────┐       ┌──────────────┐
│ stale cache   │ ◀───  │ TOON or JSON │
└───────────────┘       └──────────────┘
```

- **Live first** - direct provider HTTP calls use 15 second request timeouts, Codex JSON-RPC reads use short per-call timeouts, and stale cache fallback is per provider.
- **No first-run Keychain prompt** - macOS Claude Keychain value reads are skipped on plain calls until `--allow-keychain-prompt` succeeds once, then future plain calls reuse that existing grant.
- **Partial success is success** - one provider can fail while another returns fresh or stale data, and the process still exits 0. Exit code 1 means every provider failed, and 2 means a usage error.
- **No token equivalence** - quota-axi does not claim that one provider percentage equals another provider percentage.

## CLI Reference

| Command          | Description                                       |
| ---------------- | ------------------------------------------------- |
| `quota-axi`      | Report supported local quota windows              |
| `auth`           | Report local auth-source availability, no values  |
| `update`         | Upgrade quota-axi to the latest published version |
| `update --check` | Report current vs. latest without installing      |

### Flags

| Flag                                                                                                 | Description                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `--provider claude,codex,cursor,tokenrouter,openrouter,pioneer,commandcode,runpod,fireworks,daytona` | Scope providers                                        |
| `--json`                                                                                             | Emit normalized JSON instead of TOON for quota or auth |
| `--full`                                                                                             | Include quota account identity and source attempts     |
| `--allow-keychain-prompt`                                                                            | Permit macOS Claude Keychain access that could prompt  |
| `-h`, `--help`                                                                                       | Print terse [AXI](https://axi.md) help                 |
| `-v`, `-V`, `--version`                                                                              | Print version                                          |

## Output Model

`--json` emits `schemaVersion: 2`.

### Quota report shape

| Object                        | Fields                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Quota report                  | `providers`                                                                                |
| Provider report               | `provider`, `label`, `source`, `windows`, `state`, optional `plan`, and optional `credits` |
| Provider report with `--full` | Optional `account` identity and per-source `attempts`                                      |
| Account identity (`--full`)   | Optional `email`, `organization`, `accountId`, and `identityStatus`                        |

Account identity and per-source `attempts` are omitted unless `--full` is passed.
Claude `identityStatus` is `verified` only when Anthropic returns an authoritative account identifier; `email` and `organization` are display-only and must not be used for duplicate detection.

### Provider `state`

| Field           | Description                          |
| --------------- | ------------------------------------ |
| `status`        | Provider status                      |
| `stale`         | Whether the provider report is stale |
| `sourcesTried`  | Sources tried for the provider       |
| `refreshedAt`   | Optional refresh timestamp           |
| `error`         | Optional error                       |
| `retryAfter`    | Optional retry-after state           |
| `reason`        | Optional reason                      |
| `remedyCommand` | Optional remedy command              |

When stale or unavailable quota is likely fixable by a one-time macOS Keychain grant, `state.reason` is `keychain_access_required`, `state.remedyCommand` is `quota-axi --allow-keychain-prompt`, and JSON includes an agent-directed `help` entry.
Default TOON output includes the same condition in an `advice` block with `provider`, `reason`, and `remedyCommand`, plus the agent-directed help line.

### Quota windows

| Field set | Fields                                                              |
| --------- | ------------------------------------------------------------------- |
| Required  | `id`, `label`, `kind`                                               |
| Optional  | Percentages, reset fields, `windowSeconds`, and credit-spend fields |

### Quota enums

| Name                             | Values                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Provider statuses                | `fresh`, `stale`, `unavailable`, `auth_required`, `rate_limited`, or `error` |
| Provider sources                 | `oauth`, `cli-rpc`, `api`, `web`, `cache`, or `unavailable`                  |
| Current provider adapter sources | `oauth`, `cli-rpc`, `api`, `web`, `cache`, and `unavailable`                 |
| Window kinds                     | `session`, `weekly`, `monthly`, `model`, `credits`, or `unknown`             |
| Source attempt statuses          | `success`, `failed`, or `skipped`                                            |

Source attempts can include `credentialPresent` when a non-secret probe confirms a credential item exists.

### Provider windows

| Provider               | Windows and capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                 | Can report `five_hour`, `seven_day`, optional `seven_day_opus`, and optional `extra_usage` windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Claude scoped `limits` | When the account's usage response includes a scoped `limits` list, quota-axi surfaces every active window it describes instead, including model-scoped ones (e.g. Fable) as a `model:<slug>` window.                                                                                                                                                                                                                                                                                                                                                                   |
| Codex                  | Identifies exact 18,000-second and 604,800-second periods as `five_hour` and `weekly`, regardless of source slot; periods without a duration retain their positional identity. Additional model- or feature-scoped limits use `model:<id>:5h` / `model:<id>:7d`, and code-review limits use `code_review_five_hour` / `code_review_weekly`. Unfamiliar durations remain honest `<hours>h` windows instead of being classified as known periods. Duplicate derived IDs are preserved with `_2`, `_3`, and later suffixes. Optional credit balance data can also appear. |
| Cursor                 | Can report `included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit` windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| TokenRouter            | Reads the management wallet from `TOKENROUTER_MGMT_KEY` and reports USD balance plus a `credit_pool` usage window from the read-only management endpoint.                                                                                                                                                                                                                                                                                                                                                                                                              |
| OpenRouter             | Reads the read-only credits endpoint and reports the current USD balance and usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Pioneer                | Reads the read-only billing endpoint and reports the current credit pool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Command Code           | Reads the read-only billing credits endpoint and reports the current credit pool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| RunPod                 | Reads the first-party GraphQL account endpoint and reports current wallet balance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Fireworks              | Reads first-party billing usage and reports observed token spend; no unsupported limit is invented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Daytona                | Verifies the first-party sandbox endpoint; billing limits are not exposed by this adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### `auth --json` shape

| Object               | Fields                                                    |
| -------------------- | --------------------------------------------------------- |
| Auth report          | `generatedAt`, `schemaVersion: 1`, and `auth`             |
| Provider auth report | `provider` and `sources`                                  |
| Auth source entry    | `source`, optional `path`, `status`, and optional `error` |

Auth source entries can include `credentialPresent` when a non-secret probe confirms a credential item exists.

| Name                 | Values                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Auth source statuses | `available`, `missing`, `invalid`, `expired`, or `skipped`                                        |
| Auth source names    | `oauth-file`, `keychain`, `auth-json`, `auth-env`, `state-vscdb`, `cli-rpc`, and `management-api` |

## Security Posture

### Provider credential sources

| Provider     | Credential sources read                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude       | `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`; on macOS, the corresponding default or path-hashed Claude Code Keychain value with `--allow-keychain-prompt` or, after a profile-scoped non-secret access marker exists, on plain calls |
| Codex        | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` before the read-only CLI fallback; `$QUOTA_AXI_CODEX_BINARY` can pin that fallback to an absolute executable path                                                                                                |
| Cursor       | `$CURSOR_STATE_DB` when set or the platform Cursor state database path                                                                                                                                                                                           |
| TokenRouter  | `TOKENROUTER_MGMT_KEY` or the approved local Keychain entry                                                                                                                                                                                                      |
| OpenRouter   | `OPENROUTER_API_KEY` or the approved local Keychain entry                                                                                                                                                                                                        |
| Pioneer      | `PIONEER_API_KEY` or the approved local Keychain entry                                                                                                                                                                                                           |
| Command Code | `COMMANDCODE_API_KEY` or the approved local Keychain entry                                                                                                                                                                                                       |

### Provider notes

**Claude**

- quota-axi records the non-secret access marker after any successful Keychain value read.
- When that marker exists, plain calls read the Keychain value again so an already-approved "Always Allow" grant keeps live Claude quota fresh.
- Without the flag or marker, quota-axi may perform a non-secret Keychain item presence check so it only suggests Keychain access when a Claude credential item exists.
- After a successful usage read, quota-axi queries Anthropic's first-party OAuth profile endpoint with the same credential. Its authoritative root `account.uuid` is exposed as `account.accountId` only in `--full` output; if that field is absent, `identityStatus` is `unverified` instead of deriving an identity from email, organization data, or cached account metadata.

**Codex**

- Codex `auth.json` support is OAuth-token only; API key values such as `OPENAI_API_KEY` are treated as invalid for quota usage calls and are not sent to ChatGPT usage endpoints.
- It may run `codex -s read-only -a untrusted app-server` for Codex JSON-RPC fallback.
- Set `QUOTA_AXI_CODEX_BINARY` to an absolute executable path when the fallback must use a specific Codex installation. Auth inspection and the app-server probe resolve the same path, and an invalid override fails closed instead of consulting `PATH`.

**Cursor**

- It uses `sqlite3 -readonly` to read `cursorAuth` values and calls Cursor's first-party dashboard usage endpoint.
- If `sqlite3` is unavailable, Cursor auth is reported as skipped with `sqlite3_unavailable`.

### Safety guarantees

- Quota and auth HTTP requests go only to first-party provider usage, quota, billing, or entitlement endpoints with the user's local credentials.
- The user-initiated `update` command is the only non-provider network surface, and it is not part of quota measurement.
- It sends credential values only to the first-party provider request they authenticate.
- It never prints, logs, or caches credential values.
- It never launches provider CLIs, so it cannot spend quota or mutate provider credentials while measuring them.

### Cache

| Item                                   | Behavior                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quota cache                            | Lives at `~/.cache/quota-axi/quotas.json` or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.                                                                                                                                 |
| Quota cache permissions                | Uses `0600` file permissions.                                                                                                                                                                                                                 |
| Quota cache contents                   | Stores normalized non-secret snapshots only.                                                                                                                                                                                                  |
| Claude Keychain access marker          | Lives alongside the quota cache as `claude-keychain-access-granted` for the default profile or with an eight-character path-hash suffix for a `$CLAUDE_CONFIG_DIR` profile; uses `0600` file permissions and contains no credential material. |
| Cached reports                         | Only fresh provider snapshots with windows are cached.                                                                                                                                                                                        |
| Fresh provider reports with no windows | Clear any cached snapshot for that provider, so entitlement-only reports do not leave stale quota windows behind.                                                                                                                             |
| Reports and details not cached         | Failed providers, stale providers, account identity, and source attempts are not cached.                                                                                                                                                      |
| Codex cache identities                 | Cached Codex windows are accepted only when ID, label, kind, duration, and duplicate suffix order agree; stale snapshots with mismatched identities are rejected.                                                                             |

## Development

```sh
pnpm install                    # Install dependencies
pnpm run build                  # Compile TypeScript to dist/
pnpm run lint                   # Run ESLint
pnpm run format:check           # Check Prettier formatting
pnpm test                       # Run fixture parser and CLI tests
pnpm run build:skill -- --check # Verify the generated skill is current
pnpm run dev                    # Run the CLI with tsx
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the no-mistakes PR workflow, generated-file rules, and release-please conventions.

## License

MIT
