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

quota-axi reports local Claude, Codex, Cursor, GitHub Copilot, Grok, and Antigravity (`agy`) quota windows in one [AXI](https://axi.md)-shaped call.
It is data only: it never routes, recommends, proxies, intercepts, logs in, imports browser cookies, or mutates provider state.

- **Official sources** - quota-axi reads local provider auth sources and calls the first-party quota, usage, billing, entitlement, or local loopback endpoints used by the local agents, with a read-only Codex app-server probe as fallback.
- **Local first** - everything runs on the machine that holds the credentials; the only network calls are to first-party provider endpoints, never a third-party relay.
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
  copilot,individual,api,fresh,"2026-03-15T16:42:00.000Z"
  grok,supergrok,api,fresh,"2026-03-15T16:42:00.000Z"
  agy,Pro,cli-rpc,fresh,"2026-03-15T16:42:00.000Z"
windows[17]{provider,id,label,percentRemaining,resetsAt,state}:
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
  copilot,chat,chat,84,"2026-04-01T00:00:00.000Z",fresh
  copilot,premium_interactions,premium interactions,53,"2026-04-01T00:00:00.000Z",fresh
  grok,credits,credits,67,"2026-04-01T00:00:00.000Z",fresh
  agy,gemini_5h,Gemini 5-hour,100,"2026-03-15T21:42:00.000Z",fresh
  agy,gemini_weekly,Gemini weekly,98,"2026-03-18T21:30:30.000Z",fresh
  agy,claude_gpt_5h,Claude/GPT 5-hour,100,"2026-03-15T21:42:00.000Z",fresh
  agy,claude_gpt_weekly,Claude/GPT weekly,99,"2026-03-19T00:39:50.000Z",fresh
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
        "sourcesTried": ["oauth"],
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
auth[8]{provider,source,path,status,error}:
  claude,oauth-file,~/.claude/.credentials.json,available,none
  claude,keychain,none,skipped,keychain_prompt_required
  codex,auth-json,~/.codex/auth.json,available,none
  codex,cli-rpc,none,available,none
  cursor,state-vscdb,~/Library/Application Support/Cursor/User/globalStorage/state.vscdb,available,none
  copilot,apps-json,~/.config/github-copilot/apps.json,available,none
  grok,auth-json,~/.grok/auth.json,available,none
  agy,loopback,none,available,none
help[1]:
  Run `quota-axi --allow-keychain-prompt auth` to permit macOS Keychain access
```

## Install

quota-axi requires Node.js 20 or newer.

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
│ codex-only    │ ───▶  │ normalized   │
│ CLI fallback  │       │ quota model  │
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

| Command     | Description                                      |
| ----------- | ------------------------------------------------ |
| `quota-axi` | Report supported local quota windows             |
| `auth`      | Report local auth-source availability, no values |

### Flags

| Flag                                              | Description                                            |
| ------------------------------------------------- | ------------------------------------------------------ |
| `--provider claude,codex,cursor,copilot,grok,agy` | Scope providers                                        |
| `--json`                                          | Emit normalized JSON instead of TOON for quota or auth |
| `--full`                                          | Include quota account identity and source attempts     |
| `--allow-keychain-prompt`                         | Permit macOS Claude Keychain access that could prompt  |
| `-h`, `--help`                                    | Print terse [AXI](https://axi.md) help                 |
| `-v`, `-V`, `--version`                           | Print version                                          |

## Output Model

`--json` emits `schemaVersion: 2`.

### Quota report shape

| Object                        | Fields                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Quota report                  | `providers`                                                                                |
| Provider report               | `provider`, `label`, `source`, `windows`, `state`, optional `plan`, and optional `credits` |
| Provider report with `--full` | Optional `account` identity and per-source `attempts`                                      |

Account identity and per-source `attempts` are omitted unless `--full` is passed.

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
| Current provider adapter sources | `oauth`, `cli-rpc`, `api`, `cache`, and `unavailable`                        |
| Window kinds                     | `session`, `weekly`, `monthly`, `model`, `credits`, or `unknown`             |
| Source attempt statuses          | `success`, `failed`, or `skipped`                                            |

Source attempts can include `credentialPresent` when a non-secret probe confirms a credential item exists.

### Provider windows

| Provider                 | Windows and capabilities                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                   | Can report `five_hour`, `seven_day`, optional `seven_day_opus`, and optional `extra_usage` windows.                                                                                                                                                                                             |
| Claude scoped `limits`   | When the account's usage response includes a scoped `limits` list, quota-axi surfaces every active window it describes instead, including model-scoped ones (e.g. Fable) as a `model:<slug>` window.                                                                                            |
| Codex                    | Can report `five_hour` and `weekly` windows plus optional credit balance data, plus any additional model- or feature-scoped rate limits the account has as `model:<id>:5h` / `model:<id>:7d` windows, and an optional code-review rate limit as `code_review_five_hour` / `code_review_weekly`. |
| Cursor                   | Can report `included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit` windows.                                                                                                                                                                                                     |
| GitHub Copilot           | Can report quota snapshot windows such as `chat`, `completions`, and `premium_interactions`; when the first-party endpoint exposes entitlement but no numeric quota windows, quota-axi reports a fresh provider state with an empty `windows` list rather than inventing percentages.           |
| Grok                     | Can report `credits`, optional `on_demand`, and optional product-scoped `product:<slug>` windows.                                                                                                                                                                                               |
| Grok current period only | If Grok's billing response only exposes the current billing period and prepaid balance, quota-axi reports a fresh `credits` window with `resetsAt` and `credits.remaining` but no usage percentage.                                                                                             |
| Antigravity (`agy`)      | Can report `gemini_5h`, `gemini_weekly`, `claude_gpt_5h`, and `claude_gpt_weekly` from an already-running Antigravity app or `agy` loopback quota summary. If only model config quota is exposed, quota-axi reports model-scoped `model:<slug>` windows instead of inventing grouped windows.   |

### `auth --json` shape

| Object               | Fields                                                    |
| -------------------- | --------------------------------------------------------- |
| Auth report          | `generatedAt`, `schemaVersion: 1`, and `auth`             |
| Provider auth report | `provider` and `sources`                                  |
| Auth source entry    | `source`, optional `path`, `status`, and optional `error` |

Auth source entries can include `credentialPresent` when a non-secret probe confirms a credential item exists.

| Name                 | Values                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Auth source statuses | `available`, `missing`, `invalid`, `expired`, or `skipped`                                               |
| Auth source names    | `oauth-file`, `keychain`, `auth-json`, `auth-env`, `apps-json`, `state-vscdb`, `cli-rpc`, and `loopback` |

## Security Posture

### Provider credential sources

| Provider       | Credential sources read                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude         | `~/.claude/.credentials.json`; on macOS, the `Claude Code-credentials` Keychain value with `--allow-keychain-prompt` or, after a non-secret access marker exists, on plain calls |
| Codex          | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` before the read-only CLI fallback                                                                                                |
| Cursor         | `$CURSOR_STATE_DB` when set or the platform Cursor state database path                                                                                                           |
| GitHub Copilot | `$GITHUB_COPILOT_APPS_JSON` when set or the local Copilot apps auth file                                                                                                         |
| Grok           | `$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json` / `~/.grok/auth.json`                                                                       |
| Antigravity    | No credential files; discovers already-running Antigravity or `agy` processes and reads only their 127.0.0.1 loopback quota endpoints                                            |

### Provider notes

**Claude**

- quota-axi records the non-secret access marker after any successful Keychain value read.
- When that marker exists, plain calls read the Keychain value again so an already-approved "Always Allow" grant keeps live Claude quota fresh.
- Without the flag or marker, quota-axi may perform a non-secret Keychain item presence check so it only suggests Keychain access when a Claude credential item exists.

**Codex**

- Codex `auth.json` support is OAuth-token only; API key values such as `OPENAI_API_KEY` are treated as invalid for quota usage calls and are not sent to ChatGPT usage endpoints.
- It may run `codex -s read-only -a untrusted app-server` for Codex JSON-RPC fallback.

**Cursor**

- It uses `sqlite3 -readonly` to read `cursorAuth` values and calls Cursor's first-party dashboard usage endpoint.
- If `sqlite3` is unavailable, Cursor auth is reported as skipped with `sqlite3_unavailable`.

**GitHub Copilot**

- It calls GitHub's first-party Copilot user endpoint.
- It only sends tokens associated with public GitHub hosts to that public endpoint; host-specific GitHub Enterprise tokens are treated as unavailable there.

**Grok**

- It selects session-scoped auth instead of API-key entries and calls Grok's first-party billing endpoint.
- Session-scoped Grok auth includes web/session scopes and OIDC records scoped to `auth.x.ai` with `auth_mode` or `authMode` set to `oidc`, including scope keys with `::<client id>` suffixes.
- It may read `$GROK_HOME/version.json` or package metadata near a local `grok` executable to send an `x-grok-client-version` header, but it does not launch the Grok CLI.

**Antigravity**

- It never launches, restarts, signs in to, or mutates Antigravity or `agy`.
- It runs process and listening-port discovery, then POSTs `{}` to documented local read endpoints on `127.0.0.1`.
- It prefers `RetrieveUserQuotaSummary`, uses `GetUserStatus` for account plan identity behind `--full`, and can fall back to model quota data from `GetUserStatus` / `GetCommandModelConfigs` when grouped quota summary is unavailable.
- Burn rate is not reported for Antigravity v1 because the local payload exposes point-in-time quota snapshots, not enough history to compute a rate honestly.

### Safety guarantees

- Direct HTTP requests go only to first-party provider usage, quota, billing, or entitlement endpoints with the user's local credentials.
- It sends credential values only to the first-party provider request they authenticate.
- It never prints, logs, or caches credential values.
- It never launches the Claude CLI or Antigravity/`agy`, so it cannot accidentally spend the quota it measures.

### Cache

| Item                                   | Behavior                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Quota cache                            | Lives at `~/.cache/quota-axi/quotas.json` or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.                           |
| Quota cache permissions                | Uses `0600` file permissions.                                                                                                           |
| Quota cache contents                   | Stores normalized non-secret snapshots only.                                                                                            |
| Claude Keychain access marker          | Lives alongside the quota cache as `claude-keychain-access-granted`, uses `0600` file permissions, and contains no credential material. |
| Cached reports                         | Only fresh provider snapshots with windows are cached.                                                                                  |
| Fresh provider reports with no windows | Clear any cached snapshot for that provider, so entitlement-only reports do not leave stale quota windows behind.                       |
| Reports and details not cached         | Failed providers, stale providers, account identity, and source attempts are not cached.                                                |

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
