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

quota-axi reports local Claude, Codex, Cursor, GitHub Copilot, Grok, and Kimi quota windows by default, plus an explicit-only Antigravity view, in one [AXI](https://axi.md)-shaped call.
It is data only: it never routes, recommends a provider, model, harness, credential, or route, proxies, intercepts, logs in, imports browser cookies, or mutates provider state. Default output has no ordering preference. The opt-in `models --sort runway` surface applies only its documented deterministic comparator to quota evidence, preserves all evidence and explicit ties, and is not a recommendation.

- **Official sources** - quota-axi reads local provider auth sources and calls the first-party quota, usage, billing, or entitlement endpoints used by the local agents, with a read-only Codex app-server probe as fallback. Antigravity uses only the documented `agy -p "/usage" --output-format json` print surface from CLI 1.1.11+.
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
│ stale cache   │ ◀───  │ TOON/JSON/TUI│
└───────────────┘       └──────────────┘
```

- **Live first** - direct provider HTTP calls use 15 second request timeouts, Codex JSON-RPC reads use short per-call timeouts, and stale cache fallback is per provider.
- **No first-run Keychain prompt** - macOS Claude Keychain value reads are skipped on plain calls until `--allow-keychain-prompt` succeeds once, then future plain calls reuse that existing grant.
- **Partial success is success** - one provider can fail while another returns fresh or stale data, and the process still exits 0. Exit code 1 means every provider failed, and 2 means a usage error.
- **No token equivalence** - quota-axi does not claim that one provider percentage equals another provider percentage.

## CLI Reference

| Command          | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `quota-axi`      | Report supported local quota windows                 |
| `auth`           | Report local auth-source availability, no values     |
| `models`         | Join curated model buckets with local quota evidence |
| `update`         | Upgrade quota-axi to the latest published version    |
| `update --check` | Report current vs. latest without installing         |

### Flags

| Flag                                                           | Description                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `--provider claude,codex,cursor,copilot,grok,kimi,antigravity` | Scope providers; Antigravity is explicit-only                      |
| `--json`                                                       | Emit normalized JSON instead of TOON for quota, auth, or models    |
| `--full`                                                       | Include account, source attempts, and reserve details              |
| `--tui`                                                        | Render the live human terminal report instead of TOON (quota only) |
| `--refresh 30s\|5m\|1h`                                        | Live `--tui` refresh interval, default 5m (30s-24h)                |
| `--once`                                                       | Render one `--tui` frame and exit instead of staying live          |
| `--allow-keychain-prompt`                                      | Permit macOS Claude Keychain access that could prompt              |
| `--intelligence high\|medium\|low`                             | Filter `models` by editorial intelligence bucket                   |
| `--sort runway`                                                | Explicitly sort `models` by documented usable-runway evidence      |
| `-h`, `--help`                                                 | Print terse [AXI](https://axi.md) help                             |
| `-v`, `-V`, `--version`                                        | Print version                                                      |

### Human terminal report (`--tui`)

`quota-axi --tui` renders the same redacted report as a live human terminal view instead of TOON: a two-up provider card grid with thin headroom bars and a `┃` linear-pace marker whenever pace is known. It is presentation only and is not part of the machine-readable contract.

- On an interactive terminal the report stays up and refreshes every 5 minutes until you press `q` (or Ctrl+C), with a `Press q to quit` footer hint. `--refresh` sets the interval (30s-24h) and `--once` renders a single frame. A non-TTY stdout or stdin (pipes, CI, screenshots) always renders one frame and exits.
- Live frames paint on the alternate screen and repaint immediately on terminal resize; quitting restores the screen and prints the final frame so the last report stays in scrollback.
- Each live card leads with the `effective[]` rollup (min across bounding windows), colored by headroom: >=50% healthy, 20-50% tight, <20% critical. Per-window rows, including per-model breakouts, are the supporting detail.
- The bar fill is current headroom; the `┃` marker sits at `pace.timeRemainingPercent`, the fill position of exactly linear burn. Fill ending left of the marker means burning faster than the reset clock. The marker is omitted when pace is unknown.
- Pace is shown by the bar and marker alone, never as a numeric burn multiple. The runway verdict on the headline reads `on pace ✓` for `through_reset` and `empty in 7h 21m` for `projected_exhaustion`. Two-up rows keep both card bottoms aligned by padding the shorter card inside its border. The JSON and TOON surfaces keep the `through_reset` vocabulary and the full `pace` object.
- Signed-out and failed providers stay visible as dimmed cards and are excluded from the fleet totals in the header.
- Width comes from the terminal, clamped to 80-120 columns; below the two-up width the grid reflows to one column. Color honors `NO_COLOR`, `TERM=dumb`, and non-TTY stdout (the glyph skeleton is kept), re-enables with `FORCE_COLOR`, and uses truecolor when `COLORTERM` advertises it, falling back to 256-color then ANSI-16.
- `--tui` composes with `--provider` scoping and `--full` (account identity and source-attempt footers). It is mutually exclusive with `--json` and only supported by the `quota` command.

## Output Model

The `quota` command's `--json` emits `schemaVersion: 3`.

### Normalized schema contract

The package publishes TypeScript declarations from its package root, so consumers can use `import type { QuotaAxiResponse, ModelsResponse } from "quota-axi"`. The adapter contract is `ProviderAdapter` in and normalized `ProviderQuota` out: adapters report observed quota data, never rank, mutate provider state, or retain raw responses.

`schemaVersion` is command-specific. Additive optional fields do not bump it. A semantic or incompatible shape change does. The `quota` report is version 3, `auth` is version 1, and `models` is version 1.

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

A bounding window with no `resetsAt` at all has not been triggered yet (e.g. a Claude `five_hour` window before its first request this window) rather than being a data gap. When that untriggered window also reports zero usage (100% remaining, 0% used), it is treated as fully available and excluded from `unmeasurableWindowIds`, so it never forces `runway.status: unknown` by itself; the report's other bounding windows still determine the aggregate. Its 100% can still contribute to `effectivePercentRemaining` as a headroom bound. quota-axi never synthesizes a `resetsAt` or starts the countdown client-side. A missing `resetsAt` paired with any other usage shape (unknown usage, or nonzero usage without an active clock) is a real data gap, not "not yet triggered," and still fails closed into `unmeasurableWindowIds` - alongside stale data, missing usage percent, an expired or malformed `resetsAt` that is actually present, and a missing projection when usage is nonzero and the cycle is known.

### Quota enums

| Name                             | Values                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Provider statuses                | `fresh`, `stale`, `unavailable`, `auth_required`, `rate_limited`, or `error` |
| Provider sources                 | `oauth`, `cli-rpc`, `cli-print`, `api`, `web`, `cache`, or `unavailable`     |
| Current provider adapter sources | `oauth`, `cli-rpc`, `cli-print`, `api`, `web`, `cache`, and `unavailable`    |
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
| Antigravity            | Explicit-only `cli-print` usage windows from the documented `agy -p "/usage" --output-format json` surface. Observed `5h` and `weekly` periods receive cycle kinds/durations; unfamiliar periods remain `unknown` and diagnostic. Live groups may omit `id`, in which case their safe bucket IDs remain authoritative.                                                                                                                                                                                                                                                 |

### Model catalog and `models`

`quota-axi models [--intelligence high|medium|low] [--sort runway] [--provider ...] [--json|--full]` joins a reviewed catalog of native Claude, Codex, Grok, and Kimi models to the provider's effective quota evidence. It queries those four catalog-backed providers by default and accepts only those providers in an explicit models scope. Cursor and Copilot are excluded from this first catalog because their hosted model availability and quota relationships are plan-dependent and currently unknown.

Catalog buckets are coarse editorial classifications relative to the current frontier, not scores. They are curated from public provider material and public leaderboards, including [Artificial Analysis](https://artificialanalysis.ai/) as an informing source. quota-axi does not reproduce Artificial Analysis scores, has no runtime Artificial Analysis dependency, and never commits an Artificial Analysis key. `scripts/refresh-model-kb.ts` is a maintainer-only review aid: it may use a private `AA_API_KEY` to suggest changes, but it never writes the catalog.

Every models response includes `catalog.version` and `catalog.provenance`; callers must treat catalog freshness and unmapped `unmatchedWindowIds` as explicit uncertainty. A model row exposes the applicable effective quota scope and provider state. When no model-specific scope is known, the provider account scope remains the evidence rather than an invented model limit.

Default model order is deterministic and non-preferential: provider, then model ID. `--sort runway` is an explicit, evidence-preserving comparator only: finite `usableRunwaySeconds` descend, then `through_reset`, then `exhausted_now`, with unknown evidence last. Equal evidence appears in `sort.tieGroups`; no hidden score or model, provider, harness, credential, or route recommendation is implied. The comparator registry is intentionally extensible for a future separately sourced `cost` comparator, which is not shipped in v1.

### `auth --json` shape

| Object               | Fields                                                    |
| -------------------- | --------------------------------------------------------- |
| Auth report          | `generatedAt`, `schemaVersion: 1`, and `auth`             |
| Provider auth report | `provider` and `sources`                                  |
| Auth source entry    | `source`, optional `path`, `status`, and optional `error` |

Auth source entries can include `credentialPresent` when a non-secret probe confirms a credential item exists.

| Name                 | Values                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth source statuses | `available`, `missing`, `invalid`, `expired`, `skipped`, or `error`                                                                                    |
| Auth source names    | `oauth-file`, `keychain`, `auth-json`, `auth-env`, `apps-json`, `state-vscdb`, `cli-rpc`, `cli-print`, `pi:kimi-coding`, `pi:xai`, and `kimi-code-cli` |

## Security Posture

### Provider credential sources

| Provider       | Credential sources read                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude         | `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`; on macOS, the corresponding default or path-hashed Claude Code Keychain value pinned to Claude Code's validated current-user account, with `--allow-keychain-prompt` or, after a profile-and-account-scoped non-secret access marker exists, on plain calls |
| Codex          | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` before the read-only CLI fallback; `$QUOTA_AXI_CODEX_BINARY` can pin that fallback to an absolute executable path                                                                                                                                                                    |
| Cursor         | `$CURSOR_STATE_DB` when set or the platform Cursor state database path                                                                                                                                                                                                                                                               |
| GitHub Copilot | `$GITHUB_COPILOT_APPS_JSON` when set or the local Copilot apps auth file                                                                                                                                                                                                                                                             |
| Grok           | Grok CLI session auth from `$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json` / `~/.grok/auth.json`, plus Pi's independent `$PI_CODING_AGENT_DIR/auth.json` `xai` entry (default `~/.pi/agent/auth.json`) for OAuth or literal API-key model auth                                                  |
| Kimi           | Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) for a literal `kimi-coding` API key or unexpired OAuth access token first, then a fresh official Kimi Code CLI access token from `$KIMI_CODE_HOME/credentials/kimi-code.json` (default `$HOME/.kimi-code/credentials/kimi-code.json`)                        |
| Antigravity    | Executable discovery for `agy` (or `$QUOTA_AXI_AGY_BINARY`) only; the quota child uses the CLI's existing system-keyring session through the real home/current-user environment, while quota-axi never reads or copies Antigravity credentials, keyrings, or browser cookies                                                         |

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

- It opens Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) read-only with a strict 64 KiB cap and guaranteed descriptor cleanup. It accepts only the exact `kimi-coding` entry, either `type: "api_key"` with a nonempty, control-byte-free literal string `key`, or `type: "oauth"` with such an `access` token whose optional `expires` is still in the future; any other type is unsupported, an expired OAuth record is reported as expired (with whether a refresh token exists) and never refreshed, and malformed or oversized files, unsafe shapes, and environment, template, or command references are unavailable without resolving or executing their values. Auth and quota inspection do not create, rewrite, or otherwise manage Pi provider state.
- If Pi has no supported credential, it reads the official Kimi Code CLI credential at `$KIMI_CODE_HOME/credentials/kimi-code.json`, defaulting to `$HOME/.kimi-code/credentials/kimi-code.json`. It accepts only a non-empty `access_token` whose Unix-seconds `expires_at` (a JSON number or numeric string) is more than 60 seconds in the future.
- The Pi source always has priority. Ambient API-key environment variables are not a credential source. Transport, decoding, timeout, cancellation, and server failures do not trigger credential switching.
- It sends one redirect-disabled `GET` to the fixed `https://api.kimi.com/coding/v1/usages` endpoint with a 15 second total deadline and a 262,144-byte decoded-body cap.
- It never uses `refresh_token`, accepts a custom Kimi origin, launches Pi or Kimi, makes a model request, refreshes or writes credentials, creates a device ID, imports cookies, sends device identity, retains raw responses, or exposes account, plan, token, or fingerprint data.
- Definitive credential absence or rejection retires Kimi cache data. Transient fallback drops reset-expired windows and applies five-hour or seven-day age bounds to windows without resets.

**Antigravity**

- Antigravity is explicit-selection-only: bare/default `quota` and `auth` keep the six-provider default and never launch `agy`.
- With `--provider antigravity`, quota-axi requires the documented Antigravity CLI 1.1.11+ print surface and runs only `agy -p "/usage" --output-format json` directly, with no shell, credential copy, refresh, private RPC, model turn, or second version/recovery command.
- The child retains the real `HOME` and minimal current-user/session variables so `agy` can use its own existing system-keyring authentication. It receives a private temporary cwd plus `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME`, all removed after success or failure; the temporary cwd avoids repository-local `.agents`/MCP discovery. Output is normalized to `cli-print` windows; raw JSON and stderr are never returned or cached.
- `auth` checks only whether the configured executable is discoverable. The quota command is authoritative for session usability. With an existing session, the documented `/usage` path reports zero turns and tokens; without one, the vendor CLI is observed to fall back to browser sign-in. That explicit-only browser behavior is disclosed for maintainer policy rather than represented as a fail-closed guarantee, and quota-axi never completes or remedies login.
- Antigravity buckets are diagnostic until the payload proves relationships. Effective remaining, model identity, account identity, and plan are not inferred from labels or additive groups. Only normalized fresh windows are cacheable; transient process failures may use normalized stale cache, while malformed/auth/unsupported results retire it.

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
| Antigravity cache provenance           | Only normalized fresh `cli-print` windows are cached; raw print output, stderr, identity, attempts, and derived pace are never persisted.                                                                                                                                                                                                                             |

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
