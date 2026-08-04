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
It is data only: it never routes, recommends, proxies, intercepts, logs in, or imports browser cookies.
The one exception to its no-mutation boundary is renewing an expired Claude access token in place from a locally present refresh token - a credential renewal, never a login - described under [Security Posture](#security-posture).

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
providers[6]{provider,plan,source,status,authStatus,refreshedAt}:
  claude,pro,oauth,fresh,unknown,"2026-03-15T16:41:55.000Z"
  codex,plus,cli-rpc,fresh,unknown,"2026-03-15T16:41:58.000Z"
  cursor,pro,api,fresh,unknown,"2026-03-15T16:41:59.000Z"
  copilot,individual,api,fresh,unknown,"2026-03-15T16:42:00.000Z"
  grok,unknown,web,fresh,usable,"2026-03-15T16:42:00.000Z"
  kimi,unknown,api,fresh,unknown,"2026-03-15T16:42:00.000Z"
windows[15]{provider,id,label,percentRemaining,resetsAt,pace,state}:
  claude,five_hour,session,82,"2026-03-15T20:10:48.000Z",behind,fresh
  claude,seven_day,week,64,"2026-03-20T17:59:45.600Z",ahead,fresh
  claude,seven_day_opus,opus week,93,"2026-03-20T17:29:31.200Z",behind,fresh
  claude,"model:fable",Fable week,71,"2026-03-20T08:25:12.000Z",behind,fresh
  codex,five_hour,session,58,"2026-03-15T19:36:54.000Z",on_pace,fresh
  codex,weekly,week,47,"2026-03-19T09:54:28.800Z",ahead,fresh
  codex,"model:gpt-5.1-codex:5h",GPT-5.1-Codex session,100,"2026-03-15T20:48:00.000Z",behind,fresh
  cursor,included_usage,included usage,72,"2026-04-01T00:00:00.000Z",unknown,fresh
  cursor,auto_usage,auto usage,91,"2026-04-01T00:00:00.000Z",unknown,fresh
  cursor,api_usage,API usage,100,"2026-04-01T00:00:00.000Z",unknown,fresh
  copilot,chat,chat,84,"2026-04-01T00:00:00.000Z",unknown,fresh
  copilot,premium_interactions,premium interactions,53,"2026-04-01T00:00:00.000Z",unknown,fresh
  grok,credits,credits,67,"2026-04-01T00:00:00.000Z",behind,fresh
  kimi,weekly,week,74,"2026-03-20T12:17:02.400Z",behind,fresh
  kimi,five_hour,session,88,"2026-03-15T20:45:00.000Z",behind,fresh
effective[9]{provider,scope,effectivePercentRemaining,boundedBy,limitingWindowIds,runway,usableRunwaySeconds,projectedExhaustedAt,limitingWindowId,projectionConfidence,projectionBasis,unmeasurableWindowIds,unresolvedWindowIds,relationshipStatus}:
  claude,all_models,64,"five_hour + seven_day",seven_day,projected_exhaustion,298906,"2026-03-19T03:43:45.600Z",seven_day,established,cycle_average,none,none,known
  claude,"model:fable",64,"five_hour + seven_day + model:fable",seven_day,projected_exhaustion,298906,"2026-03-19T03:43:45.600Z",seven_day,established,cycle_average,none,none,known
  claude,seven_day_opus,64,"five_hour + seven_day + seven_day_opus",seven_day,projected_exhaustion,298906,"2026-03-19T03:43:45.600Z",seven_day,established,cycle_average,none,none,known
  codex,all_models,47,"five_hour + weekly",weekly,through_reset,unknown,unknown,unknown,established,cycle_average,none,none,known
  codex,"model:gpt-5.1-codex",47,"five_hour + weekly + model:gpt-5.1-codex:5h",weekly,through_reset,unknown,unknown,unknown,established,cycle_average,none,none,known
  cursor,unresolved,unknown,none,unknown,unknown,unknown,unknown,unknown,unknown,unknown,none,"included_usage + auto_usage + api_usage",unknown
  copilot,unresolved,unknown,none,unknown,unknown,unknown,unknown,unknown,unknown,unknown,none,"chat + premium_interactions",unknown
  grok,all_products,67,credits,credits,through_reset,unknown,unknown,unknown,established,cycle_average,none,none,known
  kimi,all_models,74,"weekly + five_hour",weekly,through_reset,unknown,unknown,unknown,established,cycle_average,none,none,known
help[4]:
  Default TOON reports effective headroom and usable runway; use --json or --full for reserve diagnostics
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account, source-attempt, and reserve details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
```

`--json` emits the same normalized model as structured JSON instead of TOON:

```sh
$ quota-axi --provider claude --json
{
  "generatedAt": "2026-03-15T16:42:00.000Z",
  "schemaVersion": 3,
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
          "resetsAt": "2026-03-15T20:10:48.000Z",
          "windowSeconds": 18000,
          "pace": {
            "status": "behind",
            "timeRemainingPercent": 69.6,
            "elapsedPercent": 30.4,
            "reservePercentPoints": 12.4,
            "burnMultiple": 0.5921,
            "projectedExhaustedAt": "2026-03-15T23:37:28.000Z",
            "projectionConfidence": "established",
            "projectionBasis": "cycle_average",
            "cycleBasis": "window_seconds",
            "cycleSeconds": 18000
          }
        },
        {
          "id": "seven_day",
          "label": "week",
          "kind": "weekly",
          "percentUsed": 36,
          "percentRemaining": 64,
          "resetsAt": "2026-03-20T17:59:45.600Z",
          "windowSeconds": 604800,
          "pace": {
            "status": "ahead",
            "timeRemainingPercent": 72.2,
            "elapsedPercent": 27.8,
            "reservePercentPoints": -8.2,
            "burnMultiple": 1.295,
            "projectedExhaustedAt": "2026-03-19T03:43:45.600Z",
            "projectionConfidence": "established",
            "projectionBasis": "cycle_average",
            "cycleBasis": "window_seconds",
            "cycleSeconds": 604800
          }
        },
        {
          "id": "model:fable",
          "label": "Fable week",
          "kind": "model",
          "percentUsed": 29,
          "percentRemaining": 71,
          "resetsAt": "2026-03-20T08:25:12.000Z",
          "windowSeconds": 604800,
          "pace": {
            "status": "behind",
            "timeRemainingPercent": 66.5,
            "elapsedPercent": 33.5,
            "reservePercentPoints": 4.5,
            "burnMultiple": 0.8657,
            "projectedExhaustedAt": "2026-03-21T10:29:20.275Z",
            "projectionConfidence": "established",
            "projectionBasis": "cycle_average",
            "cycleBasis": "window_seconds",
            "cycleSeconds": 604800
          }
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
            "limitingWindowIds": ["seven_day"],
            "pace": {
              "status": "mixed",
              "aheadWindowIds": ["seven_day"],
              "behindWindowIds": ["five_hour"],
              "worstReservePercentPoints": -8.2,
              "worstReserveWindowId": "seven_day"
            },
            "runway": {
              "status": "projected_exhaustion",
              "usableRunwaySeconds": 298906,
              "projectedExhaustedAt": "2026-03-19T03:43:45.600Z",
              "limitingWindowId": "seven_day",
              "projectionConfidence": "established",
              "projectionBasis": "cycle_average"
            }
          },
          {
            "scope": "model:fable",
            "status": "known",
            "effectivePercentRemaining": 64,
            "boundedBy": ["five_hour", "seven_day", "model:fable"],
            "limitingWindowIds": ["seven_day"],
            "pace": {
              "status": "mixed",
              "aheadWindowIds": ["seven_day"],
              "behindWindowIds": ["five_hour", "model:fable"],
              "worstReservePercentPoints": -8.2,
              "worstReserveWindowId": "seven_day"
            },
            "runway": {
              "status": "projected_exhaustion",
              "usableRunwaySeconds": 298906,
              "projectedExhaustedAt": "2026-03-19T03:43:45.600Z",
              "limitingWindowId": "seven_day",
              "projectionConfidence": "established",
              "projectionBasis": "cycle_average"
            }
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

- **Live first** - direct provider HTTP calls use 15 second request timeouts, the at-most-once Claude OAuth token renewal uses a 30 second bound, Codex JSON-RPC reads use short per-call timeouts, and stale cache fallback is per provider.
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
| `--full`                                           | Include account, source attempts, and reserve details  |
| `--allow-keychain-prompt`                          | Permit macOS Claude Keychain access that could prompt  |
| `-h`, `--help`                                     | Print terse [AXI](https://axi.md) help                 |
| `-v`, `-V`, `--version`                            | Print version                                          |

## Output Model

`--json` emits `schemaVersion: 3`.

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

| Field                | Description                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`             | Provider status                                                                                                                                             |
| `stale`              | Whether the provider report is stale                                                                                                                        |
| `sourcesTried`       | Sources tried for the provider                                                                                                                              |
| `refreshedAt`        | Optional refresh timestamp                                                                                                                                  |
| `error`              | Optional error                                                                                                                                              |
| `retryAfter`         | Optional retry-after state                                                                                                                                  |
| `reason`             | Optional reason                                                                                                                                             |
| `remedyCommand`      | Optional remedy command                                                                                                                                     |
| `untrustedWindowIds` | Optional identifiers for limits that could not be parsed authoritatively                                                                                    |
| `authStatus`         | Optional machine-readable local auth usability: `usable`, `expired_refreshable`, or `unusable`. Distinct from quota freshness and from human `error` prose. |

When stale or unavailable quota is likely fixable by a one-time macOS Keychain grant, `state.reason` is `keychain_access_required`, `state.remedyCommand` is `quota-axi --allow-keychain-prompt`, and JSON includes an agent-directed `help` entry.
When every applicable Grok auth source is missing a usable access token but at least one still has a valid literal refresh token, `state.authStatus` is `expired_refreshable` and `state.status` is `unavailable` (not `auth_required`). If Grok CLI OIDC is refreshable, `state.error` is `Grok access token expired`, `state.reason` is `credentials_expired`, `state.remedyCommand` is `grok`, and JSON includes an agent-directed `help` entry telling the user to open the Grok CLI once. If only Pi `xai` OAuth is refreshable, `state.error` is `Pi xAI access token expired` and no Grok CLI remedy is emitted because Grok cannot refresh Pi-owned credentials. Default JSON and compact TOON expose `authStatus`; source-appropriate advice is included only when a remedy exists. Full output includes `attempts[].error: credentials_expired`.
True Grok sign-out or definitive remote rejection uses `state.authStatus: unusable` with `state.status: auth_required` and `state.error: Grok sign-in required` (no `credentials_expired` reason). `authStatus: unusable` by itself only means that no source established usability; for example, a Pi credential-resolution failure instead has `state.status: error`. Callers must branch on `authStatus`, `status`, and `reason`, not on human error prose alone, and must not treat `expired_refreshable` as logged out.
When Pi's `xai` credential (or a still-valid Grok CLI session) establishes model usability but consumer credit windows cannot be read, `state.authStatus` is `usable`, windows stay empty, and `state.error` is `Grok consumer quota unavailable` rather than sign-in required.

Claude credential failures without a usable access token preserve the precise `credentials_missing` or `credentials_invalid` error. A usage response with HTTP 401/403 reports `Claude sign-in required`. These definitive failures return no windows and retire the Claude cache instead of masking current authentication state with stale quota.

### Quota windows

| Field set | Fields                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------- |
| Required  | `id`, `label`, `kind`                                                                           |
| Optional  | Percentages, `startsAt`, reset fields, `windowSeconds`, credit-spend fields, and derived `pace` |

Do not interpret a model window's percentage in isolation. `quotaSemantics.effectiveAvailability` reports the effective percentage for each understood scope, the complete `boundedBy` window set used to compute it, the currently limiting window IDs, and an effective `runway` aggregate. `all_models` applies to any model without a more specific scope; a matching `model:*` scope includes both account and model-specific bounds. Grok uses the analogous `all_products` and `product:*` scopes.

A model-specific `scope` names the model window or the shared model prefix when multiple period windows describe one Codex model.

`quotaSemantics.status` is `known` only when quota-axi understands the relationships needed for the reported scopes. A non-definitive availability entry omits `effectivePercentRemaining`. Unfamiliar vendor windows produce `partial` or `unknown` semantics and are named in `unresolvedWindowIds`; an empty provider report is `unknown` without inventing an unresolved window.

For every stale provider report, raw windows remain available for diagnostics but effective availability is always `unknown` and omits `effectivePercentRemaining` and `limitingWindowIds`. Window pace is `unknown` with reason `stale`, and each effective pace summary and effective `runway` is also `unknown` with its unmeasurable bounds named. Routing agents must not treat a stale raw percentage as current headroom.

### Pace signals

Each window may include a derived `pace` object that compares cumulative usage to elapsed cycle time using the response `generatedAt` clock:

```text
timeRemainingPercent = 100 * (resetsAt - generatedAt) / cycleDuration
reservePercentPoints = percentRemaining - timeRemainingPercent
```

| `reservePercentPoints` | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| Negative               | Usage is **ahead** of the reset clock (burning faster than linear); conserve |
| Positive               | Usage is **behind** the reset clock                                          |
| Within ±1.0            | `on_pace` deadband for API rounding noise                                    |

| Pace field                                | Meaning                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                  | `ahead`, `on_pace`, `behind`, or `unknown`                                                                                                    |
| `reason`                                  | Why pace is unknown (`stale`, `missing_usage`, `missing_cycle`, `invalid_cycle`, `future_cycle_start`, `expired_reset`, `unsupported_period`) |
| `timeRemainingPercent` / `elapsedPercent` | Cycle progress from `generatedAt`                                                                                                             |
| `reservePercentPoints`                    | Signed residual capacity vs the linear clock                                                                                                  |
| `burnMultiple`                            | `percentUsed / elapsedPercent` when elapsed > 0                                                                                               |
| `projectedExhaustedAt`                    | Linear cycle-average exhaustion timestamp when defined                                                                                        |
| `projectionConfidence`                    | `early` when elapsed < 10% of the cycle; otherwise `established`                                                                              |
| `projectionBasis`                         | Currently always `cycle_average`                                                                                                              |
| `cycleBasis`                              | `starts_at_resets_at` when both boundaries are trusted; otherwise `window_seconds` with `resetsAt`                                            |
| `cycleSeconds`                            | Trusted cycle duration used for the math                                                                                                      |

Pace is calculated only from trusted cycle evidence:

- Prefer provider-reported `startsAt` + `resetsAt` (Grok current period).
- Otherwise use provider-owned `windowSeconds` with `resetsAt` (Codex durations; Claude fixed 5h/7d; Kimi fixed 5h/weekly).
- Do not infer monthly, rolling, or unlabeled periods.

Default TOON keeps token cost low: window rows expose `pace` status, while effective rows make effective headroom and usable runway primary. It intentionally omits raw numeric reserve columns. `--full` adds reserve and per-window projection diagnostics to TOON, and `--json` always retains them. Pace is recomputed on every report from `generatedAt` and is not written to the quota cache.

Each `effectiveAvailability` entry also carries a compact `pace` summary over **every** bounding window for that scope (not only the current lowest-remaining limiter): per-status window lists, including `aheadWindowIds` and `unknownWindowIds`, plus `worstReservePercentPoints` / `worstReserveWindowId` (most negative signed reserve among known-pace windows). Different windows keep their own reset horizons; quota-axi does not invent one synthetic reset for a scope. This is factual inspectable data, never a provider/model routing recommendation.

### Effective usable runway

`effectiveAvailability[].runway` is an optional, additive `schemaVersion: 3` field derived from every authoritative `boundedBy` window using the report's single `generatedAt` clock. It is completion-risk evidence, not a score or recommendation.

| `runway.status`        | Meaning                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exhausted_now`        | A bounding window reports zero remaining now. `usableRunwaySeconds` is `0`; `limitingWindowId` names that bound.                                                                                                                                 |
| `projected_exhaustion` | Every bound is measurable and one or more cycle-average projections exhaust before their own resets. The earliest one supplies `usableRunwaySeconds`, `projectedExhaustedAt`, `limitingWindowId`, `projectionConfidence`, and `projectionBasis`. |
| `through_reset`        | Every measurable bound reaches its own current-cycle reset before projected exhaustion. There is deliberately no synthetic finite deadline or combined reset timestamp.                                                                          |
| `unknown`              | A stale, missing, malformed, or otherwise unmeasurable authoritative bound prevents a sound aggregate conclusion. `unmeasurableWindowIds` names the blockers.                                                                                    |

`usableRunwaySeconds` is nonnegative and is present only for finite results. `projectionConfidence` is `early` or `established`; `projectionBasis` is currently `cycle_average`. Zero observed usage with a valid current cycle proves `through_reset` under that same cycle-average basis. Named model or product windows are additional bounds only for their applicable scopes, so they can become the effective limiting window without changing other scopes.

### Quota enums

| Name                             | Values                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Provider statuses                | `fresh`, `stale`, `unavailable`, `auth_required`, `rate_limited`, or `error` |
| Provider sources                 | `oauth`, `cli-rpc`, `api`, `web`, `cache`, or `unavailable`                  |
| Current provider adapter sources | `oauth`, `cli-rpc`, `api`, `web`, `cache`, and `unavailable`                 |
| Window kinds                     | `session`, `weekly`, `monthly`, `model`, `credits`, or `unknown`             |
| Window pace statuses             | `ahead`, `on_pace`, `behind`, or `unknown`                                   |
| Effective pace statuses          | `ahead`, `on_pace`, `behind`, `mixed`, or `unknown`                          |
| Effective runway statuses        | `exhausted_now`, `projected_exhaustion`, `through_reset`, or `unknown`       |
| Pace projection confidence       | `early` or `established`                                                     |
| Pace cycle basis                 | `starts_at_resets_at` or `window_seconds`                                    |
| Quota relationship statuses      | `known`, `partial`, or `unknown`                                             |
| Source attempt statuses          | `success`, `failed`, or `skipped`                                            |

Source attempts can include `credentialPresent` when a non-secret probe confirms a credential item exists.

### Provider windows

| Provider               | Windows and capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                 | Can report `five_hour`, `seven_day`, optional `seven_day_opus`, and optional `extra_usage` windows. Trusted session/weekly/model windows emit fixed `windowSeconds` (18,000 or 604,800) for pace; `extra_usage` does not invent a monthly duration.                                                                                                                                                                                                                                                                                                                    |
| Claude scoped `limits` | When the account's usage response includes a scoped `limits` list, quota-axi surfaces every active window it describes instead, including model-scoped ones (e.g. Fable) as a `model:<slug>` window with the same trusted weekly duration.                                                                                                                                                                                                                                                                                                                             |
| Codex                  | Identifies exact 18,000-second and 604,800-second periods as `five_hour` and `weekly`, regardless of source slot; periods without a duration retain their positional identity. Additional model- or feature-scoped limits use `model:<id>:5h` / `model:<id>:7d`, and code-review limits use `code_review_five_hour` / `code_review_weekly`. Unfamiliar durations remain honest `<hours>h` windows instead of being classified as known periods. Duplicate derived IDs are preserved with `_2`, `_3`, and later suffixes. Optional credit balance data can also appear. |
| Cursor                 | Can report `included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit` windows. Monthly labels alone are not trusted cycle evidence, so pace stays `unknown` unless a future provider duration appears.                                                                                                                                                                                                                                                                                                                                                    |
| GitHub Copilot         | Can report quota snapshot windows such as `chat`, `completions`, and `premium_interactions`; when the first-party endpoint exposes entitlement but no numeric quota windows, quota-axi reports a fresh provider state with an empty `windows` list rather than inventing percentages. Pace stays `unknown` without trusted cycle boundaries.                                                                                                                                                                                                                           |
| Grok                   | With a usable Grok CLI session bearer, can report the shared `credits` window, optional product-scoped `product:<slug>` windows, the current-period `startsAt` and reset, and optional prepaid credit balance from the consumer Usage-page operation. Pi `xai` auth alone establishes usability but cannot provide these consumer windows. Top-level `credits.remaining` is prepaid/on-demand balance, distinct from the shared period `windows` credits percentage used for effective availability. Pace prefers the startsAt/resetsAt pair.                          |
| Grok proto3 zero       | For the exact consumer operation only, an omitted usage float is the official proto3 zero when a valid weekly or monthly current period proves the config is present; quota-axi reports `0` used and `100` remaining rather than deriving usage from money.                                                                                                                                                                                                                                                                                                            |
| Kimi                   | Reports the principal `weekly` subscription window (with trusted 604,800s duration) plus every valid self-described limit in wire order. Only a limit whose normalized duration is exactly 18,000 seconds is identified as `five_hour`; future limits remain `limit:<index>` unknown windows.                                                                                                                                                                                                                                                                          |

### `auth --json` shape

| Object               | Fields                                                    |
| -------------------- | --------------------------------------------------------- |
| Auth report          | `generatedAt`, `schemaVersion: 1`, and `auth`             |
| Provider auth report | `provider` and `sources`                                  |
| Auth source entry    | `source`, optional `path`, `status`, and optional `error` |

Auth source entries can include `credentialPresent` when a non-secret probe confirms a credential item exists.

| Name                 | Values                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Auth source statuses | `available`, `missing`, `invalid`, `expired`, `skipped`, or `error`                                                                       |
| Auth source names    | `oauth-file`, `keychain`, `auth-json`, `auth-env`, `apps-json`, `state-vscdb`, `cli-rpc`, `pi:kimi-coding`, `pi:xai`, and `kimi-code-cli` |

## Security Posture

### Provider credential sources

| Provider       | Credential sources read                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude         | `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`; on macOS, the corresponding default or path-hashed Claude Code Keychain value pinned to Claude Code's validated current-user account, with `--allow-keychain-prompt` or, after a profile-and-account-scoped non-secret access marker exists, on plain calls |
| Codex          | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` before the read-only CLI fallback; `$QUOTA_AXI_CODEX_BINARY` can pin that fallback to an absolute executable path                                                                                                                                                                    |
| Cursor         | `$CURSOR_STATE_DB` when set or the platform Cursor state database path                                                                                                                                                                                                                                                               |
| GitHub Copilot | `$GITHUB_COPILOT_APPS_JSON` when set or the local Copilot apps auth file                                                                                                                                                                                                                                                             |
| Grok           | Grok CLI session auth from `$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json` / `~/.grok/auth.json`, plus Pi's independent `$PI_CODING_AGENT_DIR/auth.json` `xai` entry (default `~/.pi/agent/auth.json`) for OAuth or literal API-key model auth                                                  |
| Kimi           | Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) for a literal `kimi-coding` API key first, then a fresh official Kimi Code CLI access token from `$KIMI_CODE_HOME/credentials/kimi-code.json` (default `$HOME/.kimi-code/credentials/kimi-code.json`)                                                        |

### Provider notes

**Claude**

- quota-axi mirrors Claude Code's Keychain account selector: nonempty `USER`, otherwise the operating-system username, validated against Claude Code's safe account pattern with the same `claude-code-user` fallback. Both presence and value reads require that account plus the resolved service. There is no ambiguous service-only fallback.
- quota-axi records the non-secret access marker after any successful pinned Keychain value read.
- When that profile-and-account-scoped marker exists, plain calls read the pinned Keychain value again so an already-approved "Always Allow" grant keeps live Claude quota fresh. Legacy service-only markers remain untouched but do not authorize a value read.
- Without the flag or the current marker, quota-axi may perform a non-secret pinned Keychain item presence check so it only suggests Keychain access when the selected Claude credential item exists.
- In `--full` output, Claude usage attempts identify `oauth-file` or `keychain` as the credential discovery source. They never include the Keychain account.
- When an access token exists, local `expiresAt` metadata is advisory. quota-axi sends that token only to Anthropic's existing read-only usage request; success returns fresh quota, while HTTP 401/403 is the definitive authentication result.
- When the usage request is rejected with HTTP 401/403 and the stored credential carries a refresh token, quota-axi performs at most one OAuth token renewal against Anthropic's first-party token endpoint using Claude Code's public OAuth client id — the same short-lived-credential renewal the Claude CLI performs on use — then retries the usage request at most once. This renews a credential; it is never an interactive login (no browser, authorization-code exchange, or new consent). The renewed short-lived credential is written back atomically to the exact same source and credential context it was read from — the `0600` credential file, or the pinned macOS Keychain item scoped to its own account and service — preserving refresh-token rotation and never discarding a still-valid refresh token. The refresh runs once per quota read regardless of how many credential sources are expired.
- A refresh token is treated as rejected — the definitive end of session, reported as `Claude sign-in required` — only on HTTP 401/403 or an RFC 6749 `invalid_grant` error code. Any other token-endpoint 4xx (`invalid_client`, `invalid_scope`, `invalid_request`, `unsupported_grant_type`), plus network, timeout, rate-limit, malformed-response, and concurrent-credential-change failures, preserve the valid session and the stored credential unchanged and stay stale-cache eligible. Once a refresh fails transiently in a read, the session's renewability is unproven, so no later rejection of an expired access token in that same read is reported as a definitive sign-in or retires the cache.
- On a concurrent rotation, quota-axi adopts the newer stored credential rather than overwriting it. When the provider rotates the refresh token, the replacement is written back even if the rest of the response is unusable, so the stored credential is not left behind the server. Write-back is best-effort and bounded: the Keychain compare-and-swap re-read plus update share one short budget, and a write-back that could not complete is surfaced as an `oauth-refresh-write-back` attempt (`success`, `skipped` when superseded, or `failed` with an opaque code). A hard write denial after a provider-side rotation can still leave the stored credential behind the server, which then requires a real Claude sign-in; that risk is inherent to a denied credential write and is why the failure is reported rather than swallowed.
- Access tokens, refresh tokens, authorization headers, and raw token-endpoint responses are never logged, cached, embedded in errors, hashed, or written to any file other than the credential's own source; `--full` attempts surface only `oauth-refresh` and `oauth-refresh-write-back` sources with opaque status codes. One bounded exposure is inherent to macOS Keychain write-back: `security add-generic-password -U` takes the renewed credential as a command-line argument, which other processes running as the same user can read for the lifetime of that single short-lived call. `security` offers no stdin path for this update, so the exposure is kept to that one narrowest invocation and no broader.
- Missing or invalid credentials without a usable access token and usage HTTP 401/403 that cannot be renewed bypass and best-effort retire Claude cache. Timeout, network, rate-limit, server, and response-compatibility failures may use only a formerly fresh Claude snapshot less than seven days old. Reset-expired windows are removed; resetless session, monthly, and credit windows expire after five hours, resetless weekly and model windows expire after seven days, and resetless unknown windows are rejected.
- After a successful usage read, quota-axi queries Anthropic's first-party OAuth profile endpoint with the same credential. Its authoritative root `account.uuid` is exposed as `account.accountId` only in `--full` output; if that field is absent, `identityStatus` is `unverified` instead of deriving an identity from email, organization data, or cached account metadata.

**Codex**

- Codex `auth.json` support is OAuth-token only; API key values such as `OPENAI_API_KEY` are treated as invalid for quota usage calls and are not sent to ChatGPT usage endpoints.
- Access-token JWT usability is authoritative for the OAuth bearer probe. An expired `id_token` alone does not mark `auth-json` expired or skip OAuth; identity-token expiry is diagnostic metadata only. A missing or expired `access_token` still skips OAuth and preserves the read-only CLI fallback.
- It may run `codex -s read-only -a untrusted app-server` for Codex JSON-RPC fallback.
- Set `QUOTA_AXI_CODEX_BINARY` to an absolute executable path when the fallback must use a specific Codex installation. Auth inspection and the app-server probe resolve the same path, and an invalid override fails closed instead of consulting `PATH`.

**Cursor**

- It uses `sqlite3 -readonly` to read `cursorAuth` values and calls Cursor's first-party dashboard usage endpoint.
- If `sqlite3` is unavailable, Cursor auth is reported as skipped with `sqlite3_unavailable`.

**GitHub Copilot**

- It calls GitHub's first-party Copilot user endpoint.
- It only sends tokens associated with public GitHub hosts to that public endpoint; host-specific GitHub Enterprise tokens are treated as unavailable there.

**Grok**

- It checks two independent usability sources: Grok CLI session auth and Pi's `xai` credential in `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`). Grok is locally usable when either source is usable, including asymmetric cases where the other source is absent, malformed, stale, or expired. True sign-out requires every applicable source to be unavailable or definitively rejected; `authStatus: unusable` can also accompany an indeterminate local credential-resolution failure, but that failure remains `state.status: error` rather than `auth_required`.
- Grok CLI session-scoped auth is preferred for the consumer credits probe. It selects session-scoped entries instead of API-key entries and sends a read-only gRPC-web request to Grok's consumer `grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig` operation. Observed Grok CLI OIDC access tokens are short-lived (about six hours on current CLI sessions) while a refresh token remains present for CLI-owned recovery.
- Session-scoped Grok auth includes web/session scopes and OIDC records scoped to `auth.x.ai` with `auth_mode` or `authMode` set to `oidc`, including scope keys with `::<client id>` suffixes.
- Pi `xai` auth follows Pi's auth-file contract: `type: "oauth"` with literal `access` / optional `refresh` / `expires`, or `type: "api_key"` with a literal `key`. Environment, template, and command references are not resolved. Ambient `XAI_API_KEY` is not a quota-axi credential source. A locally usable Pi credential establishes model usability even when it cannot expose consumer quota windows; that case is `authStatus: usable` with empty windows, not logged out. Because quota-axi makes no Pi model request, this local classification does not assert that the credential was accepted remotely.
- The Grok CLI owns OIDC access-token refresh and rewrites `~/.grok/auth.json`; Pi owns refresh of its own `auth.json` OAuth entries. quota-axi only reads the resulting sessions and never refreshes tokens, launches Grok or Pi, or writes either auth file. Expired-session classification and recovery fields are documented under [Provider `state`](#provider-state).
- Source availability is distinct from remote validity: local expiry gates which bearer is offered to the consumer probe, while HTTP 401/403 and auth-class gRPC codes are definitive rejection. Transient network/rate-limit failures stay non-auth and remain stale-cache eligible for same-source web snapshots.
- It does not send browser cookies, launch the Grok CLI, refresh credentials, perform OAuth, retain raw response bodies, or derive usage from monetary fields.

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
- It sends credential values only to the first-party provider request they authenticate, or, for Claude short-lived-credential renewal, to Anthropic's first-party OAuth token endpoint.
- It never prints, logs, or caches credential values.
- It never launches the Claude, Grok, Pi, or Kimi CLIs, so it cannot spend quota while measuring it. The one credential mutation it performs is Claude short-lived-credential renewal: when a Claude access token is expired but its refresh token is present, quota-axi renews the access token and rewrites only that short-lived credential in place, in its original source and context (see [Provider notes](#provider-notes)). It performs no other credential mutation, never rotates or revokes a session it did not itself renew, and never writes any other provider's credentials.

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
