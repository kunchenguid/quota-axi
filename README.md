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

quota-axi reports local Claude, Codex, Cursor, GitHub Copilot, Grok, and Kimi quota windows in one [AXI](https://axi.md)-shaped call.
It is data only: it never routes, recommends, proxies, intercepts, logs in, imports browser cookies, or mutates provider state.

- **Official sources** - quota-axi reads local provider auth sources and calls the first-party quota, usage, billing, or entitlement endpoints used by the local agents, with a read-only Codex app-server probe as fallback.
- **Local first** - quota and auth reports run on the machine that holds the credentials; their network calls go to first-party provider endpoints, never a third-party relay.
  The separate `update` command contacts npm only when the user runs it.
- **Token efficient** - default stdout is compact TOON so agents spend fewer tokens parsing quota state, with `--json` available when a caller needs the normalized model.

## Quick Start

**macOS + Claude note:** Claude Code keeps its live token in the macOS Keychain.
quota-axi pins that lookup to the same current-user Keychain item Claude Code selects and will not read its value unless the user grants permission, so Claude quota reads can stay stale when no usable on-disk access token is available.
Run `quota-axi --allow-keychain-prompt` once and approve Keychain access with "Always Allow".
After a successful Keychain read, future non-interactive quota reads use that profile-and-account-scoped grant and refresh live Claude data without requiring the flag.
Legacy markers created before account-pinned lookup are not reused, so an upgrade may require this one-time grant again.

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
  grok,unknown,web,fresh,"2026-03-15T16:42:00.000Z"
  kimi,unknown,api,fresh,"2026-03-15T16:42:00.000Z"
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
  copilot,chat,chat,84,"2026-04-01T00:00:00.000Z",fresh
  copilot,premium_interactions,premium interactions,53,"2026-04-01T00:00:00.000Z",fresh
  grok,credits,credits,67,"2026-04-01T00:00:00.000Z",fresh
  kimi,weekly,week,74,"2026-03-19T09:00:00.000Z",fresh
  kimi,five_hour,session,88,"2026-03-15T21:42:00.000Z",fresh
effective[9]{provider,scope,effectivePercentRemaining,boundedBy,limitingWindowIds,unresolvedWindowIds,relationshipStatus}:
  claude,all_models,64,"five_hour + seven_day",seven_day,none,known
  claude,"model:fable",64,"five_hour + seven_day + model:fable",seven_day,none,known
  claude,seven_day_opus,64,"five_hour + seven_day + seven_day_opus",seven_day,none,known
  codex,all_models,47,"five_hour + weekly",weekly,none,known
  codex,"model:gpt-5.1-codex",47,"five_hour + weekly + model:gpt-5.1-codex:5h",weekly,none,known
  cursor,unresolved,unknown,none,unknown,"included_usage + auto_usage + api_usage",unknown
  copilot,unresolved,unknown,none,unknown,"chat + premium_interactions",unknown
  grok,all_products,67,credits,credits,none,known
  kimi,all_models,74,"weekly + five_hour",weekly,none,known
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
          "id": "seven_day",
          "label": "week",
          "kind": "weekly",
          "percentUsed": 36,
          "percentRemaining": 64,
          "resetsAt": "2026-03-19T15:00:00.000Z"
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
      "quotaSemantics": {
        "status": "known",
        "description": "Claude account windows bound every model. A model-specific window is an additional bound, so that model's effective remaining percentage is the minimum across the named windows.",
        "effectiveAvailability": [
          {
            "scope": "all_models",
            "status": "known",
            "effectivePercentRemaining": 64,
            "boundedBy": ["five_hour", "seven_day"],
            "limitingWindowIds": ["seven_day"]
          },
          {
            "scope": "model:fable",
            "status": "known",
            "effectivePercentRemaining": 64,
            "boundedBy": ["five_hour", "seven_day", "model:fable"],
            "limitingWindowIds": ["seven_day"]
          }
        ]
      },
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
  copilot,apps-json,~/.config/github-copilot/apps.json,available,none
  grok,auth-json,~/.grok/auth.json,available,none
  kimi,pi:kimi-coding,none,available,none
  kimi,kimi-code-cli,none,available,none
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

| Flag                                               | Description                                            |
| -------------------------------------------------- | ------------------------------------------------------ |
| `--provider claude,codex,cursor,copilot,grok,kimi` | Scope providers                                        |
| `--json`                                           | Emit normalized JSON instead of TOON for quota or auth |
| `--full`                                           | Include quota account identity and source attempts     |
| `--allow-keychain-prompt`                          | Permit macOS Claude Keychain access that could prompt  |
| `-h`, `--help`                                     | Print terse [AXI](https://axi.md) help                 |
| `-v`, `-V`, `--version`                            | Print version                                          |

## Output Model

`--json` emits `schemaVersion: 2`.

### Quota report shape

| Object                        | Fields                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Quota report                  | `providers`                                                                                                  |
| Provider report               | `provider`, `label`, `source`, `windows`, `quotaSemantics`, `state`, optional `plan`, and optional `credits` |
| Provider report with `--full` | Optional `account` identity and per-source `attempts`                                                        |
| Account identity (`--full`)   | Optional `email`, `organization`, `accountId`, and `identityStatus`                                          |

Account identity and per-source `attempts` are omitted unless `--full` is passed.
Claude `identityStatus` is `verified` only when Anthropic returns an authoritative account identifier; `email` and `organization` are display-only and must not be used for duplicate detection.

### Provider `state`

| Field                | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `status`             | Provider status                                                          |
| `stale`              | Whether the provider report is stale                                     |
| `sourcesTried`       | Sources tried for the provider                                           |
| `refreshedAt`        | Optional refresh timestamp                                               |
| `error`              | Optional error                                                           |
| `retryAfter`         | Optional retry-after state                                               |
| `reason`             | Optional reason                                                          |
| `remedyCommand`      | Optional remedy command                                                  |
| `untrustedWindowIds` | Optional identifiers for limits that could not be parsed authoritatively |

When stale or unavailable quota is likely fixable by a one-time macOS Keychain grant, `state.reason` is `keychain_access_required`, `state.remedyCommand` is `quota-axi --allow-keychain-prompt`, and JSON includes an agent-directed `help` entry.
When Grok's local OIDC session still has a refreshable record but the access token's `expires_at` is past, `state.error` is `Grok access token expired`, `state.reason` is `credentials_expired`, `state.remedyCommand` is `grok`, and JSON includes an agent-directed `help` entry telling the user to open the Grok CLI once so Grok can refresh its local session token. Default JSON exposes that `reason` and `remedyCommand` without requiring `--full`; full output still includes `attempts[].error: credentials_expired`.
Default TOON output includes the same conditions in an `advice` block with `provider`, `reason`, and `remedyCommand`, plus the agent-directed help line.

Claude credential failures without a usable access token preserve the precise `credentials_missing` or `credentials_invalid` error. A usage response with HTTP 401/403 reports `Claude sign-in required`. These definitive failures return no windows and retire the Claude cache instead of masking current authentication state with stale quota.

### Quota windows

| Field set | Fields                                                              |
| --------- | ------------------------------------------------------------------- |
| Required  | `id`, `label`, `kind`                                               |
| Optional  | Percentages, reset fields, `windowSeconds`, and credit-spend fields |

Do not interpret a model window's percentage in isolation. `quotaSemantics.effectiveAvailability` reports the effective percentage for each understood scope, the complete `boundedBy` window set used to compute it, and the currently limiting window IDs. `all_models` applies to any model without a more specific scope; a matching `model:*` scope includes both account and model-specific bounds. Grok uses the analogous `all_products` and `product:*` scopes.

A model-specific `scope` names the model window or the shared model prefix when multiple period windows describe one Codex model.

`quotaSemantics.status` is `known` only when quota-axi understands the relationships needed for the reported scopes. A non-definitive availability entry omits `effectivePercentRemaining`. Unfamiliar vendor windows produce `partial` or `unknown` semantics and are named in `unresolvedWindowIds`; an empty provider report is `unknown` without inventing an unresolved window.

For every stale provider report, raw windows remain available for diagnostics but effective availability is always `unknown` and omits `effectivePercentRemaining` and `limitingWindowIds`. Routing agents must not treat a stale raw percentage as current headroom.

### Quota enums

| Name                             | Values                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Provider statuses                | `fresh`, `stale`, `unavailable`, `auth_required`, `rate_limited`, or `error` |
| Provider sources                 | `oauth`, `cli-rpc`, `api`, `web`, `cache`, or `unavailable`                  |
| Current provider adapter sources | `oauth`, `cli-rpc`, `api`, `web`, `cache`, and `unavailable`                 |
| Window kinds                     | `session`, `weekly`, `monthly`, `model`, `credits`, or `unknown`             |
| Quota relationship statuses      | `known`, `partial`, or `unknown`                                             |
| Source attempt statuses          | `success`, `failed`, or `skipped`                                            |

Source attempts can include `credentialPresent` when a non-secret probe confirms a credential item exists.

### Provider windows

| Provider               | Windows and capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                 | Can report `five_hour`, `seven_day`, optional `seven_day_opus`, and optional `extra_usage` windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Claude scoped `limits` | When the account's usage response includes a scoped `limits` list, quota-axi surfaces every active window it describes instead, including model-scoped ones (e.g. Fable) as a `model:<slug>` window.                                                                                                                                                                                                                                                                                                                                                                   |
| Codex                  | Identifies exact 18,000-second and 604,800-second periods as `five_hour` and `weekly`, regardless of source slot; periods without a duration retain their positional identity. Additional model- or feature-scoped limits use `model:<id>:5h` / `model:<id>:7d`, and code-review limits use `code_review_five_hour` / `code_review_weekly`. Unfamiliar durations remain honest `<hours>h` windows instead of being classified as known periods. Duplicate derived IDs are preserved with `_2`, `_3`, and later suffixes. Optional credit balance data can also appear. |
| Cursor                 | Can report `included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit` windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GitHub Copilot         | Can report quota snapshot windows such as `chat`, `completions`, and `premium_interactions`; when the first-party endpoint exposes entitlement but no numeric quota windows, quota-axi reports a fresh provider state with an empty `windows` list rather than inventing percentages.                                                                                                                                                                                                                                                                                  |
| Grok                   | Reports the shared `credits` window, optional product-scoped `product:<slug>` windows, the current-period reset, and optional prepaid credit balance from the consumer Usage-page operation.                                                                                                                                                                                                                                                                                                                                                                           |
| Grok proto3 zero       | For the exact consumer operation only, an omitted usage float is the official proto3 zero when a valid weekly or monthly current period proves the config is present; quota-axi reports `0` used and `100` remaining rather than deriving usage from money.                                                                                                                                                                                                                                                                                                            |
| Kimi                   | Reports the principal `weekly` subscription window plus every valid self-described limit in wire order. Only a limit whose normalized duration is exactly 18,000 seconds is identified as `five_hour`; future limits remain `limit:<index>` unknown windows.                                                                                                                                                                                                                                                                                                           |

### `auth --json` shape

| Object               | Fields                                                    |
| -------------------- | --------------------------------------------------------- |
| Auth report          | `generatedAt`, `schemaVersion: 1`, and `auth`             |
| Provider auth report | `provider` and `sources`                                  |
| Auth source entry    | `source`, optional `path`, `status`, and optional `error` |

Auth source entries can include `credentialPresent` when a non-secret probe confirms a credential item exists.

| Name                 | Values                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Auth source statuses | `available`, `missing`, `invalid`, `expired`, or `skipped`                                                                      |
| Auth source names    | `oauth-file`, `keychain`, `auth-json`, `auth-env`, `apps-json`, `state-vscdb`, `cli-rpc`, `pi:kimi-coding`, and `kimi-code-cli` |

## Security Posture

### Provider credential sources

| Provider       | Credential sources read                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude         | `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`; on macOS, the corresponding default or path-hashed Claude Code Keychain value pinned to Claude Code's validated current-user account, with `--allow-keychain-prompt` or, after a profile-and-account-scoped non-secret access marker exists, on plain calls |
| Codex          | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` before the read-only CLI fallback; `$QUOTA_AXI_CODEX_BINARY` can pin that fallback to an absolute executable path                                                                                                                                                                    |
| Cursor         | `$CURSOR_STATE_DB` when set or the platform Cursor state database path                                                                                                                                                                                                                                                               |
| GitHub Copilot | `$GITHUB_COPILOT_APPS_JSON` when set or the local Copilot apps auth file                                                                                                                                                                                                                                                             |
| Grok           | `$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json` / `~/.grok/auth.json`                                                                                                                                                                                                                           |
| Kimi           | Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) for a literal `kimi-coding` API key first, then a fresh official Kimi Code CLI access token from `$KIMI_CODE_HOME/credentials/kimi-code.json` (default `$HOME/.kimi-code/credentials/kimi-code.json`)                                                        |

### Provider notes

**Claude**

- quota-axi mirrors Claude Code's Keychain account selector: nonempty `USER`, otherwise the operating-system username, validated against Claude Code's safe account pattern with the same `claude-code-user` fallback. Both presence and value reads require that account plus the resolved service. There is no ambiguous service-only fallback.
- quota-axi records the non-secret access marker after any successful pinned Keychain value read.
- When that profile-and-account-scoped marker exists, plain calls read the pinned Keychain value again so an already-approved "Always Allow" grant keeps live Claude quota fresh. Legacy service-only markers remain untouched but do not authorize a value read.
- Without the flag or the current marker, quota-axi may perform a non-secret pinned Keychain item presence check so it only suggests Keychain access when the selected Claude credential item exists.
- In `--full` output, Claude usage attempts identify `oauth-file` or `keychain` as the credential discovery source. They never include the Keychain account.
- When an access token exists, local `expiresAt` metadata is advisory. quota-axi sends that token only to Anthropic's existing read-only usage request; success returns fresh quota, while HTTP 401/403 is the definitive authentication result.
- Missing or invalid credentials without a usable access token and usage HTTP 401/403 bypass and best-effort retire Claude cache. Timeout, network, rate-limit, server, and response-compatibility failures may use only a formerly fresh Claude snapshot less than seven days old. Reset-expired windows are removed; resetless session, monthly, and credit windows expire after five hours, resetless weekly and model windows expire after seven days, and resetless unknown windows are rejected.
- After a successful usage read, quota-axi queries Anthropic's first-party OAuth profile endpoint with the same credential. Its authoritative root `account.uuid` is exposed as `account.accountId` only in `--full` output; if that field is absent, `identityStatus` is `unverified` instead of deriving an identity from email, organization data, or cached account metadata.

**Codex**

- Codex `auth.json` support is OAuth-token only; API key values such as `OPENAI_API_KEY` are treated as invalid for quota usage calls and are not sent to ChatGPT usage endpoints.
- It may run `codex -s read-only -a untrusted app-server` for Codex JSON-RPC fallback.
- Set `QUOTA_AXI_CODEX_BINARY` to an absolute executable path when the fallback must use a specific Codex installation. Auth inspection and the app-server probe resolve the same path, and an invalid override fails closed instead of consulting `PATH`.

**Cursor**

- It uses `sqlite3 -readonly` to read `cursorAuth` values and calls Cursor's first-party dashboard usage endpoint.
- If `sqlite3` is unavailable, Cursor auth is reported as skipped with `sqlite3_unavailable`.

**GitHub Copilot**

- It calls GitHub's first-party Copilot user endpoint.
- It only sends tokens associated with public GitHub hosts to that public endpoint; host-specific GitHub Enterprise tokens are treated as unavailable there.

**Grok**

- It selects session-scoped auth instead of API-key entries and sends a read-only gRPC-web request to Grok's consumer `grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig` operation.
- Session-scoped Grok auth includes web/session scopes and OIDC records scoped to `auth.x.ai` with `auth_mode` or `authMode` set to `oidc`, including scope keys with `::<client id>` suffixes.
- The Grok CLI owns OIDC access-token refresh and rewrites `~/.grok/auth.json`. quota-axi only reads the resulting session: an expired access token with a remaining refreshable session reports `Grok access token expired` / `reason: credentials_expired` and advises opening the Grok CLI once; it does not refresh tokens itself. Missing or unusable session auth without a refreshable record, and live HTTP 401/403 or gRPC unauthenticated responses, still report `Grok sign-in required`.
- It does not send browser cookies, launch the Grok CLI, refresh credentials, perform OAuth, retain raw response bodies, or derive usage from monetary fields.
- Top-level `credits.remaining` is prepaid/on-demand balance and is distinct from the shared period `windows` credits percentage used for effective availability.

**Kimi**

- It opens Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) read-only with a strict 64 KiB cap and guaranteed descriptor cleanup. It accepts only the exact `kimi-coding` entry with `type: "api_key"` and a nonempty, control-byte-free literal string `key`; malformed or oversized files, unsafe shapes, and environment, template, or command references are unavailable without resolving or executing their values. Auth and quota inspection do not create, rewrite, or otherwise manage Pi provider state.
- If Pi has no supported credential, it reads the official Kimi Code CLI credential at `$KIMI_CODE_HOME/credentials/kimi-code.json`, defaulting to `$HOME/.kimi-code/credentials/kimi-code.json`. It accepts only a non-empty `access_token` whose Unix-seconds `expires_at` (a JSON number or numeric string) is more than 60 seconds in the future.
- The Pi source always has priority. Ambient API-key environment variables are not a credential source. Transport, decoding, timeout, cancellation, and server failures do not trigger credential switching.
- It sends one redirect-disabled `GET` to the fixed `https://api.kimi.com/coding/v1/usages` endpoint with a 15 second total deadline and a 262,144-byte decoded-body cap.
- It never uses `refresh_token`, accepts a custom Kimi origin, launches Pi or Kimi, makes a model request, refreshes or writes credentials, creates a device ID, imports cookies, sends device identity, retains raw responses, or exposes account, plan, token, or fingerprint data.
- Definitive credential absence or rejection retires Kimi cache data. Transient fallback drops reset-expired windows and applies five-hour or seven-day age bounds to windows without resets.

### Safety guarantees

- Quota and auth HTTP requests go only to first-party provider usage, quota, billing, or entitlement endpoints with the user's local credentials.
- The user-initiated `update` command is the only non-provider network surface, and it is not part of quota measurement.
- It sends credential values only to the first-party provider request they authenticate.
- It never prints, logs, or caches credential values.
- It never launches the Claude, Grok, Pi, or Kimi CLIs, so it cannot spend quota or mutate provider credentials while measuring them.

### Cache

| Item                                   | Behavior                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quota cache                            | Lives at `~/.cache/quota-axi/quotas.json` or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.                                                                                                                                                                                                                                                         |
| Quota cache permissions                | Uses `0600` file permissions.                                                                                                                                                                                                                                                                                                                                         |
| Quota cache contents                   | Stores normalized non-secret snapshots only.                                                                                                                                                                                                                                                                                                                          |
| Claude Keychain access marker          | Lives alongside the quota cache as `claude-keychain-access-granted[-<profile-hash>]-account-<account-hash>`; the profile hash is eight hexadecimal characters when applicable and the account hash is sixteen. It uses `0600` file permissions, contains no credential material or raw account name, and legacy service-only markers are ignored rather than deleted. |
| Cached reports                         | Only fresh provider snapshots with windows are cached.                                                                                                                                                                                                                                                                                                                |
| Fresh provider reports with no windows | Clear any cached snapshot for that provider, so entitlement-only reports do not leave stale quota windows behind.                                                                                                                                                                                                                                                     |
| Reports and details not cached         | Failed providers, stale providers, account identity, and source attempts are not cached.                                                                                                                                                                                                                                                                              |
| Claude cache fallback                  | Definitive missing/invalid credential and HTTP 401/403 failures retire the snapshot. Only transient failures may use a formerly fresh snapshot, with a seven-day provider bound plus reset and resetless-window pruning.                                                                                                                                              |
| Codex cache identities                 | Cached Codex windows are accepted only when ID, label, kind, duration, and duplicate suffix order agree; stale snapshots with mismatched identities are rejected.                                                                                                                                                                                                     |
| Grok cache provenance                  | Only snapshots produced by the current `web` consumer operation can be used as Grok stale fallback; legacy `api` billing-proxy snapshots are rejected.                                                                                                                                                                                                                |

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
