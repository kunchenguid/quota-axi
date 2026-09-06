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

quota-axi reports local Claude, Codex, Cursor, GitHub Copilot, Grok, Kimi, Z.AI, Alibaba, OpenCode Go, and Antigravity (`agy`) quota windows in one [AXI](https://axi.md)-shaped call.
It is data only: it never routes, recommends a provider, model, harness, credential, or route, proxies, intercepts, logs in, imports browser cookies, or mints or rotates a credential. When the same stored access token is expired, carries a refresh token, and is definitively rejected, quota-axi may delegate renewal to that vendor's own non-interactive CLI command and re-read the result ([Delegated credential refresh](#delegated-credential-refresh)). Default output has no ordering preference. The opt-in `models --sort runway` surface applies only its documented deterministic comparator to quota evidence, preserves all evidence and explicit ties, and is not a recommendation. It publishes one derived per-scope comparative selection signal, [`selection`](#per-scope-selection-signal), as data computed from figures it already reports; the consumer, not quota-axi, does any routing or ranking with it.

- **Official sources** - quota-axi reads local provider auth sources and calls first-party quota, usage, billing, entitlement, local loopback, or read-only credential-liveness endpoints used by the local agents, with read-only CLI probes for Alibaba and Codex where applicable. The only other vendor commands it runs are the declared credential-refresh delegates.
- **Local first** - quota and auth reports run on the machine that holds the credentials; their network calls go to first-party provider endpoints, never a third-party relay.
  The separate `update` command contacts npm only when the user runs it.
- **Token efficient** - default stdout is compact TOON so agents spend fewer tokens parsing quota state, with `--json` available when a caller needs the normalized model.

## Quick Start

**Credential-source note:** Claude Code and the Cursor CLI (`cursor-agent`) keep live tokens in the macOS Keychain; Linux `cursor-agent` stores its access token in `~/.config/cursor/auth.json` (or the XDG/`$CURSOR_CLI_CONFIG` override).
quota-axi does not read macOS Keychain values until the user grants permission, so Claude quota can stay stale and CLI-only Cursor auth can appear unavailable when no other usable credential exists. On Linux it reads only the auth file's `accessToken` and never its refresh token.
Run `quota-axi --allow-keychain-prompt` once and approve Keychain access with "Always Allow".
After a successful read, future non-interactive quota calls reuse the corresponding account-scoped grant without requiring the flag. Claude grants are also profile-scoped; legacy Claude markers created before account-pinned lookup are not reused.

```sh
$ npx -y quota-axi
bin: ~/.npm/_npx/.../quota-axi
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2026-03-15T16:42:00.000Z"
quota[10]{provider,scope,effectivePercentRemaining,spendPriority,runway,confidence,limitedBy,resetsAt}:
  claude,all_models,64,-0.3798,projected_exhaustion,established,seven_day,"2026-03-20T17:59:45.600Z"
  claude,seven_day_opus,64,0.3218,projected_exhaustion,established,seven_day,"2026-03-20T17:59:45.600Z"
  claude,"model:fable",64,-0.0932,projected_exhaustion,established,seven_day,"2026-03-20T17:59:45.600Z"
  codex,all_models,47,-0.2383,projected_exhaustion,established,weekly,"2026-03-19T09:54:28.800Z"
  codex,"model:gpt-5.1-codex",47,-0.1973,projected_exhaustion,established,weekly,"2026-03-19T09:54:28.800Z"
  cursor,all_models,72,1.4067,through_reset,established,included_usage,"2026-04-01T00:00:00.000Z"
  grok,all_products,67,0.5778,through_reset,established,credits,"2026-04-01T00:00:00.000Z"
  kimi,all_models,74,0.2484,through_reset,established,weekly,"2026-03-20T12:17:02.400Z"
  zai,all_models,50,-1.0046,projected_exhaustion,established,weekly,"2026-03-20T16:42:00.000Z"
  zai,tools,100,unknown,unknown,unknown,mcp_month,"2026-04-01T00:00:00.000Z"
exhaustion[6]{provider,scope,usableRunwaySeconds,projectedExhaustedAt,limitingWindowId}:
  claude,all_models,298906,"2026-03-19T03:43:45.600Z",seven_day
  claude,seven_day_opus,298906,"2026-03-19T03:43:45.600Z",seven_day
  claude,"model:fable",298906,"2026-03-19T03:43:45.600Z",seven_day
  codex,all_models,10365,"2026-03-15T19:34:45.428Z",five_hour
  codex,"model:gpt-5.1-codex",10365,"2026-03-15T19:34:45.428Z",five_hour
  zai,all_models,172800,"2026-03-17T16:42:00.000Z",weekly
attention[3]{provider,scope,kind,detail,remedy}:
  copilot,all,unresolved_windows,chat + premium_interactions,none
  zai,tools,unmeasurable,"mcp_month blocks runway + spendPriority",none
  agy,all,unresolved_windows,gemini_5h + gemini_weekly + claude_gpt_5h + claude_gpt_weekly,none
help[1]:
  Run `quota-axi --full` for windows, pace, reserve, and account evidence
```

Default TOON is decision-shaped: `quota[]` carries one fully populated row per measurable scope, and the sparse `exhaustion[]` and `attention[]` blocks carry the finite-runway and non-nominal facts. See [Default report blocks](#default-report-blocks).

`--json` emits the normalized model instead. Derivation inputs are demoted to `--full`; see [Output tiers](#output-tiers).

```sh
$ quota-axi --provider claude --json
{
  "generatedAt": "2026-03-15T16:42:00.000Z",
  "schemaVersion": 5,
  "providers": [
    {
      "provider": "claude",
      "plan": "pro",
      "windows": [
        {
          "id": "five_hour",
          "label": "session",
          "kind": "session",
          "percentRemaining": 82,
          "resetsAt": "2026-03-15T20:10:48.000Z",
          "pace": {
            "status": "behind",
            "reservePercentPoints": 12.4,
            "burnMultiple": 0.5921
          }
        },
        {
          "id": "seven_day",
          "label": "week",
          "kind": "weekly",
          "percentRemaining": 64,
          "resetsAt": "2026-03-20T17:59:45.600Z",
          "pace": {
            "status": "ahead",
            "reservePercentPoints": -8.2,
            "burnMultiple": 1.295
          }
        },
        {
          "id": "model:fable",
          "label": "Fable week",
          "kind": "model",
          "percentRemaining": 71,
          "resetsAt": "2026-03-20T08:25:12.000Z",
          "pace": {
            "status": "behind",
            "reservePercentPoints": 4.5,
            "burnMultiple": 0.8657
          }
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false
      },
      "quotaSemantics": {
        "status": "known",
        "effectiveAvailability": [
          {
            "scope": "all_models",
            "status": "known",
            "effectivePercentRemaining": 64,
            "boundedBy": [
              "five_hour",
              "seven_day"
            ],
            "limitingWindowIds": [
              "seven_day"
            ],
            "pace": {
              "status": "mixed",
              "aheadWindowIds": [
                "seven_day"
              ],
              "worstReservePercentPoints": -8.2,
              "worstReserveWindowId": "seven_day"
            },
            "runway": {
              "status": "projected_exhaustion",
              "usableRunwaySeconds": 298906,
              "projectedExhaustedAt": "2026-03-19T03:43:45.600Z",
              "limitingWindowId": "seven_day",
              "projectionConfidence": "established"
            },
            "selection": {
              "status": "known",
              "spendPriority": -0.3798
            }
          },
          {
            "scope": "model:fable",
            "status": "known",
            "effectivePercentRemaining": 64,
            "boundedBy": [
              "five_hour",
              "seven_day",
              "model:fable"
            ],
            "limitingWindowIds": [
              "seven_day"
            ],
            "pace": {
              "status": "mixed",
              "aheadWindowIds": [
                "seven_day"
              ],
              "worstReservePercentPoints": -8.2,
              "worstReserveWindowId": "seven_day"
            },
            "runway": {
              "status": "projected_exhaustion",
              "usableRunwaySeconds": 298906,
              "projectedExhaustedAt": "2026-03-19T03:43:45.600Z",
              "limitingWindowId": "seven_day",
              "projectionConfidence": "established"
            },
            "selection": {
              "status": "known",
              "spendPriority": -0.0932
            }
          }
        ]
      }
    }
  ]
}
```

```sh
$ quota-axi auth
bin: ~/.npm/_npx/.../quota-axi
description: Inspect local quota auth sources without printing secret values
auth[15]{provider,source,path,status,error}:
  claude,oauth-file,~/.claude/.credentials.json,available,none
  claude,keychain,none,skipped,keychain_prompt_required
  codex,auth-json,~/.codex/auth.json,available,none
  codex,pi:openai-codex,~/.pi/agent/auth.json,available,none
  codex,cli-rpc,~/.local/bin/codex,available,none
  cursor,state-vscdb,~/Library/Application Support/Cursor/User/globalStorage/state.vscdb,available,none
  cursor,cli-keychain,~/.cursor/cli-config.json,skipped,keychain_prompt_required
  copilot,apps-json,~/.config/github-copilot/apps.json,available,none
  grok,auth-json,~/.grok/auth.json,available,none
  kimi,pi:kimi-coding,none,available,none
  kimi,kimi-code-cli,none,available,none
  zai,opencode:auth.json,~/.local/share/opencode/auth.json,available,none
  agy,loopback,none,available,none
  alibaba,bl-cli,none,available,none
  opencode-go,opencode:auth.json,~/.local/share/opencode/auth.json,available,none
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

The minimal skill points your agent to quota-axi's live CLI guidance through `npx -y quota-axi`, so nothing needs to be installed ahead of time and installed skill copies do not duplicate changing CLI instructions.
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
│ local auth or │ ───▶  │ first-party  │
│ runtime       │       │ APIs/loopback│
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

- **Live first** - provider HTTP calls use 15 second request timeouts, Codex JSON-RPC and Antigravity loopback reads use shorter per-call timeouts, and stale cache fallback is per provider.
- **Host network policy** - Claude, Codex, Copilot, Cursor, and Grok's outbound HTTP calls honor standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables (including lowercase forms). This only follows the user's configured egress path; quota-axi does not expose a proxy service or print proxy URLs.
- **No first-run Keychain prompt** - macOS Claude and Cursor CLI Keychain value reads are skipped on plain calls until `--allow-keychain-prompt` succeeds once for that source, then future plain calls reuse the corresponding grant.
- **Delegated refresh, never minted** - when the same stored access token is expired, carries a refresh token, and is definitively rejected, quota-axi may run that vendor CLI's own smallest non-interactive refresh command and re-read the store the CLI rewrote. quota-axi never performs a refresh-token exchange itself. See [Delegated credential refresh](#delegated-credential-refresh).
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

| Flag                                                                           | Description                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `--provider claude,codex,cursor,copilot,grok,kimi,zai,agy,alibaba,opencode-go` | Scope providers                                                    |
| `--json`                                                                       | Emit normalized JSON instead of TOON for quota, auth, or models    |
| `--full`                                                                       | Include audit and derivation details                               |
| `--tui`                                                                        | Render the live human terminal report instead of TOON (quota only) |
| `--refresh 30s\|5m\|1h`                                                        | Live `--tui` refresh interval, default 5m (30s-24h)                |
| `--once`                                                                       | Render one `--tui` frame and exit instead of staying live          |
| `--allow-keychain-prompt`                                                      | Permit macOS provider Keychain access that could prompt            |
| `--no-credential-refresh`                                                      | Never run a vendor CLI's own non-interactive credential refresh    |
| `--intelligence high\|medium\|low`                                             | Filter `models` by editorial intelligence bucket                   |
| `--sort runway`                                                                | Explicitly sort `models` by documented usable-runway evidence      |
| `-h`, `--help`                                                                 | Print terse [AXI](https://axi.md) help                             |
| `-v`, `-V`, `--version`                                                        | Print version                                                      |

### Human terminal report (`--tui`)

`quota-axi --tui` renders the same redacted report as a live human terminal view instead of TOON: a two-up provider card grid with thin headroom bars and a `┃` linear-pace marker whenever pace is known. It is presentation only and is not part of the machine-readable contract.

- On an interactive terminal the report stays up and refreshes every 5 minutes until you press `q` (or Ctrl+C), with a `Press q to quit` footer hint. `--refresh` sets the interval (30s-24h) and `--once` renders a single frame. A non-TTY stdout or stdin (pipes, CI, screenshots) always renders one frame and exits.
- Every refresh re-runs the same quota read as a bare `quota-axi`, including [delegated credential refresh](#delegated-credential-refresh) when a stored session has expired in the meantime. Run `quota-axi --tui --no-credential-refresh` to keep the live report strictly read-only.
- Live frames paint on the alternate screen and repaint immediately on terminal resize; quitting restores the screen and prints the final frame so the last report stays in scrollback.
- Height comes from the terminal too. When the report is taller than the terminal, the live view windows it instead of letting the alternate screen (which has no scrollback) push the header and first cards out of reach. The viewport accounts for physical rows after terminal-width wrapping: a full-width visible line can consume its own row without wrapping the optional scroll affordance, which is omitted when it cannot fit. At five or more rows the header stays pinned; when there is room, the last row carries a scroll affordance naming how many report lines are above and below. Below five rows the header scrolls with the other report content, and at one row the scroll affordance is omitted so content still remains visible. Use `j`/`k`, the arrow keys, `PgUp`/`PgDn`, `Space`/`b`, or `g`/`G` to move the window. Scrolling clamps at both ends, survives a refresh, and re-clamps on resize; growing the terminal back past the report's height restores the whole frame and the ordinary `Press q to quit` footer. `--once`, non-TTY output, the final frame echoed on quit, and the TOON and JSON surfaces are all unaffected by terminal height.
- Each live card with a combinable bound leads with the effective-availability rollup (min across bounding windows), colored by headroom: >=50% healthy, 20-50% tight, <20% critical. Per-window rows, including per-model breakouts, are the supporting detail.
- The headline is labeled with the window it actually is: the minimum across bounding windows always equals at least one named window, so the label names the `limitingWindowIds` window (`week`, `session`, `credits`) and changes per provider and over time. Tied limiting windows read `credits + grok build`, compacting to `credits +2` when the names do not fit; a model- or product-scoped headline appends its scope, and any unresolved limiter falls back to the scope wording (`all models`).
- The bar fill is current headroom; the `┃` marker sits at the binding window's `pace.timeRemainingPercent`, the fill position of exactly linear burn. The headline marker therefore matches the corresponding `limitingWindowIds` sub-bar even when another window supplies the finite-runway `empty in` verdict. Fill ending left of the marker means burning faster than the reset clock. The marker is omitted when that window's pace is unknown.
- Pace is shown by the bar and marker alone, never as a numeric burn multiple. The runway verdict on the headline reads `on pace ✓` for `through_reset` and `empty in 7h 21m` for `projected_exhaustion`. Two-up rows keep both card bottoms aligned by padding the shorter card inside its border. The TUI does not display the per-scope selection signal; that signal remains on the JSON and TOON machine surfaces. Those surfaces also keep the `through_reset` vocabulary, while `--full --json` exposes the complete `pace` object. The TUI renders from the complete in-memory model, so `--json` tiering never removes anything it draws.
- A provider whose window relationships are wholly unknown (Copilot, OpenCode Go, or Antigravity, with every window unresolved) has no combined effective percentage, pace, or runway to show, so its card replaces the headline block with a single `per-window usage · no combined bound` line and leads straight into its real per-window rows. Partially understood providers keep the effective-unknown headline. No combined headroom, pace, or runway number is invented.
- Signed-out and failed providers stay visible as dimmed cards and are excluded from the fleet totals in the header.
- Width comes from the terminal, clamped to 80-120 columns; below the two-up width the grid reflows to one column. Color honors `NO_COLOR`, `TERM=dumb`, and non-TTY stdout (the glyph skeleton is kept), re-enables with `FORCE_COLOR`, and uses truecolor when `COLORTERM` advertises it, falling back to 256-color then ANSI-16.
- `--tui` composes with `--provider` scoping and `--full` (account identity and source-attempt footers). It is mutually exclusive with `--json` and only supported by the `quota` command.

## Output Model

The `quota` command's `--json` emits `schemaVersion: 5`.

### Normalized schema contract

The package publishes TypeScript declarations from its package root, so consumers can use `import type { QuotaAxiResponse, ModelsResponse } from "quota-axi"`. The adapter contract is `ProviderAdapter` in and normalized `ProviderQuota` out: adapters report observed quota data, never rank, mint credentials, or retain raw responses. The narrowly bounded vendor-owned renewal path is documented under [Delegated credential refresh](#delegated-credential-refresh).

`schemaVersion` is command-specific. Additive optional fields do not bump it. A semantic or incompatible shape change does. The `quota` report is version 5, `auth` is version 1, and `models` is version 1.

### Default report blocks

Default TOON is organized by the reading agent's decision rather than by quota-axi's data structures:

| Block          | Rows                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quota[]`      | One row per **measurable** scope: `provider`, `scope`, `effectivePercentRemaining`, `spendPriority`, `runway`, `confidence`, `limitedBy`, `resetsAt`. Every column is populated on every row. `limitedBy` is the scope's `limitingWindowIds`, and `resetsAt` is that binding window's own reset. |
| `exhaustion[]` | **Sparse.** One row per scope with a finite exhaustion point: `usableRunwaySeconds`, `projectedExhaustedAt`, `limitingWindowId`. `exhaustion[0]:` means nothing is projected to run out.                                                                                                         |
| `attention[]`  | **Sparse.** Every non-nominal fact: `provider`, `scope`, `kind`, `detail`, `remedy`.                                                                                                                                                                                                             |

A `quota[]` row whose `runway` is `projected_exhaustion` or `exhausted_now` has exactly one matching `exhaustion[]` row, joined on `provider` + `scope`. A row with `through_reset` or `unknown` has none, by definition: `through_reset` deliberately has no deadline and `unknown` has none to state.

`attention[]` kinds:

| `kind`                                                  | `scope` | Meaning                                                                                                                                                                                   |
| ------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale`                                                 | `all`   | The report is stale diagnostic data. `detail` names the last refresh, `fetch failed` plus `state.error` when a usage fetch failed, and any `state.reason`; no scope gets a `quota[]` row. |
| `auth_required`, `rate_limited`, `unavailable`, `error` | `all`   | The provider state status. `detail` is `state.error`, any `state.reason`, plus the retry-after instant for a rate limit.                                                                  |
| `no_quota`                                              | `all`   | The provider reported no measurable scope. Emitted when nothing else names it or when needed to preserve `state.authStatus`.                                                              |
| `unresolved_windows`                                    | `all`   | `quotaSemantics.unresolvedWindowIds`: unfamiliar vendor windows not folded into any bound.                                                                                                |
| `untrusted_windows`                                     | `all`   | `state.untrustedWindowIds`: limits that could not be parsed authoritatively.                                                                                                              |
| `headroom_unknown`                                      | scope   | The scope reports no effective percentage. `detail` names the windows that block it and any finite runway verdict with its limiting window.                                               |
| `unmeasurable`                                          | scope   | Headroom is known but a bound blocks `runway`, `spendPriority`, or both. `detail` names which.                                                                                            |
| `degraded_source`                                       | `all`   | A credential source was superseded: it was broken or unreadable while a sibling source answered. `detail` is `<source> · <error>`. One row per source, only on a fresh reading.           |

`remedy` carries `state.remedyCommand` when one exists, and situational agent-directed advice is still prepended to `help`.

Two invariants hold for every report:

- **Every requested provider appears at least once**, in `quota[]` or `attention[]` or both. A provider is never silently absent, and a provider with no `quota[]` row always states its `state.authStatus` - including a positive `usable` - as `(auth <status>)` in its `attention[]` detail.
- **`quota[]` rows stay in provider-declaration order**, never sorted by any metric. A compact table with a `spendPriority` column must never read as a published ranking.

An unknown or stale scope deliberately gets **no** `quota[]` row: the absence of a number is the correct encoding of "no number", and the scope is named in `attention[]` instead.

### Output tiers

`--full` adds; it never subtracts. Default TOON carries the three decision blocks; `--full` TOON adds the `providers[]`, `windows[]`, `scopeAudit[]`, `accounts[]`, and `attempts[]` audit blocks. Default `--json` carries the normalized model with derivation inputs demoted; `--full` restores them with **no renames and no re-nesting** - a demoted field is simply absent until `--full`, in the exact position and under the exact name it has there.

| Demoted to `--full` in `--json`                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- |
| `providers[].label`, `providers[].source`                                                                                             |
| `state.refreshedAt`, `state.sourcesTried`                                                                                             |
| `windows[].percentUsed`, `windows[].startsAt`, `windows[].windowSeconds`                                                              |
| `windows[].pace.timeRemainingPercent`, `elapsedPercent`, `cycleBasis`, `cycleSeconds`, `projectedExhaustedAt`, `projectionConfidence` |
| `quotaSemantics.description`                                                                                                          |
| `effectiveAvailability[].pace.behindWindowIds`, `onPaceWindowIds`                                                                     |
| Account identity (`account`) and per-source `attempts`                                                                                |

Everything a consumer branches on stays in the default tier: `state.status`, `stale`, `authStatus`, `error`, `reason`, `remedyCommand`, `retryAfter`, `untrustedWindowIds`, and `degradedSources`; window `pace.status`, `reason`, `reservePercentPoints`, `burnMultiple`; `quotaSemantics.status` and `unresolvedWindowIds`; and every scope's `effectivePercentRemaining`, `boundedBy`, `limitingWindowIds`, `runway`, `selection`, and pace `aheadWindowIds` / `unknownWindowIds` / `worstReservePercentPoints`. `credits` also stays, so a consumer can avoid misreading it as exhaustion.

`--tui` renders from the complete in-memory model, so demotion never changes what the human report draws.

### Quota report shape

| Object                        | Fields                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| Quota report                  | `providers`                                                                               |
| Provider report               | `provider`, `windows`, `quotaSemantics`, `state`, optional `plan`, and optional `credits` |
| Provider report with `--full` | Also `label`, `source`, optional `account` identity, and per-source `attempts`            |
| Account identity (`--full`)   | Optional `email`, `organization`, `accountId`, and `identityStatus`                       |

Account identity and per-source `attempts` are omitted unless `--full` is passed.
Claude `identityStatus` is `verified` only when Anthropic returns an authoritative account identifier; `email` and `organization` are display-only and must not be used for duplicate detection.

### Provider `state`

| Field                | Description                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`             | Provider status                                                                                                                                             |
| `stale`              | Whether the provider report is stale                                                                                                                        |
| `sourcesTried`       | Sources tried for the provider (`--full`)                                                                                                                   |
| `refreshedAt`        | Optional refresh timestamp (`--full`)                                                                                                                       |
| `error`              | Optional error                                                                                                                                              |
| `retryAfter`         | Optional retry-after state                                                                                                                                  |
| `reason`             | Optional reason                                                                                                                                             |
| `remedyCommand`      | Optional remedy command                                                                                                                                     |
| `untrustedWindowIds` | Optional identifiers for limits that could not be parsed authoritatively                                                                                    |
| `authStatus`         | Optional machine-readable local auth usability: `usable`, `expired_refreshable`, or `unusable`. Distinct from quota freshness and from human `error` prose. |
| `degradedSources`    | Optional `{ source, error? }` list of credential sources a working sibling superseded on a fresh reading                                                    |

When stale or unavailable quota is likely fixable by a one-time macOS Keychain grant, `state.reason` is `keychain_access_required`, `state.remedyCommand` is `quota-axi --allow-keychain-prompt`, and JSON includes an agent-directed `help` entry. That prompt remedy is offered only when a Keychain prompt can help (`keychain_prompt_required`). A denied or timed-out Keychain outcome is reported as `keychain_access_denied` or `keychain_prompt_timeout` and stays silent no longer, but it does not advertise `--allow-keychain-prompt`. macOS `security` exit 44 is cannot-reach (`keychain_unreachable`), not item-absent: it is not signed-out, and it does not retire the Claude cache.
When no Grok credential establishes usability but at least one still has a valid literal refresh token, `state.authStatus` is `expired_refreshable` and `state.status` is `unavailable` (not `auth_required`). Stored-expired bearers are first tested with bounded read-only liveness attempts; this classification stands only after the credential's own model catalog definitively rejects it or cannot decide, and an empirically live bearer reports fresh quota or `usable` instead. The `grok` remedy (`state.reason: credentials_expired`, `state.remedyCommand: grok`, plus an agent-directed JSON `help` entry telling the user to run the Grok CLI once) is emitted only when the same refreshable CLI candidate is rejected by both consumer quota and the official Grok Build model catalog. It survives the delegated `grok models` refresh, so it names the case where that delegate could not run or did not recover the session (see [Delegated credential refresh](#delegated-credential-refresh)). A transient failure does not trigger the remedy. If Grok CLI OIDC is refreshable and Pi is not usable, `state.error` is `Grok access token expired`. If only Pi `xai` OAuth is refreshable, `state.error` is `Pi xAI access token expired` and no Grok CLI remedy is emitted because Grok cannot refresh Pi-owned credentials. Default JSON exposes `authStatus`; when a provider has no `quota[]` row, compact TOON preserves a defined auth status as `(auth <status>)` in `attention[]`. Source-appropriate advice is included only when a remedy exists. Full output shows the attempts: `model_auth_probe_live` means the credential's official model catalog accepted it but exposed no numeric quota. `attempts[].error: credentials_expired` marks a stored-expired credential that was not attempted.
True Grok sign-out or definitive remote rejection uses `state.authStatus: unusable` with `state.status: auth_required` and `state.error: Grok sign-in required` (no `credentials_expired` reason). For official Grok Build OIDC and Pi OAuth, a rejection from the consumer Usage-page operation alone is not that verdict because those access tokens can have a different audience; the matching first-party model catalog must reject the same bearer too. `authStatus: unusable` by itself only means that no source established usability; for example, a Pi credential-resolution failure instead has `state.status: error`. Callers must branch on `authStatus`, `status`, and `reason`, not on human error prose alone, and must not treat `expired_refreshable` as logged out.
When Grok Build OAuth, Pi `xai` OAuth, or a Pi `xai` API key establishes model usability but consumer credit windows cannot be read, `state.authStatus` is `usable`, windows stay empty, and `state.error` is `Grok model access available; quota unavailable` rather than sign-in required. This is authenticated-but-unmeasurable, not a percentage or evidence of unlimited capacity.

A provider with more than one credential source consults them in its fixed declared order and reports the one that works, so a broken store never speaks for a provider whose sibling store still answers. A store's own expiry field is advisory within that source, never a verdict or a reason to reorder sources: a stored-expired credential is still probed in its source's declared position because only the provider's own endpoint can establish that a credential is dead. The superseded source is not discarded: `state.degradedSources` names it on the fresh reading, and default TOON emits a `degraded_source` attention row for it. Pi auth readers reserve `missing` for an absent file or provider property; malformed stores and present non-object or structurally invalid entries are `invalid`. Handover is limited to credential problems - a transport, decoding, or server failure is about the request rather than the credential, so it is reported as-is instead of being retried on a second credential. When no source works the provider still reports its auth problem, and a source that only failed transiently outranks a definitive rejection so a rejected credential is never reported as a sign-out while a sibling's outage is unresolved.

Claude credential failures without a usable access token preserve the precise `credentials_missing` or `credentials_invalid` error. A usage response with HTTP 401 reports `Claude sign-in required` only when it definitively establishes account authentication failure; the [Claude provider notes](#provider-notes) own the withheld-Keychain exception and cache effects. HTTP 403 is not sufficient authentication evidence because network policy and WAF denials use it too; it stays unavailable or stale rather than claiming sign-out.

### Quota windows

| Field set | Fields                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------- |
| Required  | `id`, `label`, `kind`                                                                           |
| Optional  | Percentages, `startsAt`, reset fields, `windowSeconds`, credit-spend fields, and derived `pace` |

Do not interpret a model window's percentage in isolation. `quotaSemantics.effectiveAvailability` reports the effective percentage for each understood scope, the complete `boundedBy` window set used to compute it, the currently limiting window IDs, an effective `runway` aggregate, and a per-scope [`selection`](#per-scope-selection-signal) signal. `all_models` applies to any model without a more specific scope; whether a matching `model:*` scope also includes account bounds is provider-specific. Grok uses the analogous `all_products` and `product:*` scopes.

A model-specific `scope` names the model window or the shared model prefix when multiple period windows describe one Codex model.

`quotaSemantics.status` is `known` only when quota-axi understands the relationships needed for the reported scopes. A non-definitive availability entry omits `effectivePercentRemaining`. Unfamiliar vendor windows produce `partial` or `unknown` semantics and are named in `unresolvedWindowIds`; an empty provider report is `unknown` without inventing an unresolved window.

Cursor's IDE windows (`included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit`) all draw on the same plan billing cycle, so quota-axi treats them as jointly bounding and reports an `all_models` effective remaining equal to the lowest of them. That is the conservative reading: it never overstates headroom. Grok Bot weekly usage is a separate Cursor-account meter reported as its own `grok_bot` scope, so it never lowers IDE headroom and IDE windows never mask Grok Bot exhaustion. An unfamiliar Cursor window is not folded into either bound and does not create a bound of its own - it stays named in `unresolvedWindowIds` and turns the provider's semantics `partial` while the recognized-window bounds remain. GitHub Copilot's window relationships are still unknown, so it reports no effective remaining.

Z.AI's `five_hour` and `weekly` token windows jointly bound model usage and are reported as one `all_models` scope, while the `mcp_month` tool window is a separate resource reported as its own `tools` scope; a tool window near exhaustion therefore never lowers model headroom, and model windows never mask tool exhaustion. An unfamiliar or untrusted Z.AI window is not folded into either bound: it stays named in `unresolvedWindowIds`, turns the provider's semantics `partial`, and leaves both scopes non-definitive because it could add a bound to either.

Alibaba's account `weekly` window is reported at `all_models` scope, while each `model:*` limit is kept only at its named model scope; a model limit never becomes an account-wide bound. OpenCode Go's rolling, weekly, and monthly windows are reported as raw windows but remain `unknown` for effective availability because quota-axi has no provider evidence that those windows jointly bind `all_models`.

For every stale provider report, raw windows remain available for diagnostics but effective availability is always `unknown` and omits `effectivePercentRemaining` and `limitingWindowIds`. Window pace is `unknown` with reason `stale`, and each effective pace summary, effective `runway`, and `selection` is also `unknown` with its unmeasurable bounds named. Routing agents must not treat a stale raw percentage as current headroom.

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
| `cycleBasis`                              | `starts_at_resets_at` when both boundaries are trusted; otherwise `window_seconds` with `resetsAt`                                            |
| `cycleSeconds`                            | Trusted cycle duration used for the math                                                                                                      |

Pace is calculated only from trusted cycle evidence:

- Prefer trusted `startsAt` + `resetsAt` pairs (Grok's provider-reported current period; Cursor's monthly billing cycle, whose start comes from the payload's cycle start or the previous renewal date).
- Otherwise use provider-owned `windowSeconds` with `resetsAt` (Codex durations; Claude fixed 5h/7d; Kimi and Z.AI fixed 5h/weekly).
- Do not infer monthly, rolling, or unlabeled periods.

Every projection quota-axi publishes is cycle-average. There is deliberately no `projectionBasis` field: its absence means `cycle_average`, and a future non-cycle-average basis would name itself.

Default TOON keeps token cost low: `quota[]` puts `spendPriority` immediately after effective headroom and carries the runway verdict, its confidence, and the binding window's reset, while per-window rows and raw numeric reserve live in `--full`. Default `--json` keeps `pace.status`, `reason`, `reservePercentPoints`, and `burnMultiple`, and demotes the cycle-progress inputs those are derived from. Pace, runway, and `selection` are recomputed on every report from `generatedAt` and are not written to the quota cache.

Each `effectiveAvailability` entry also carries a compact `pace` summary over **every** bounding window for that scope (not only the current lowest-remaining limiter): per-status window lists, including `aheadWindowIds` and `unknownWindowIds`, plus `worstReservePercentPoints` / `worstReserveWindowId` (most negative signed reserve among known-pace windows). Different windows keep their own reset horizons; quota-axi does not invent one synthetic reset for a scope. This is factual inspectable data, never a provider/model routing recommendation.

`pace.worstReservePercentPoints` stays a single-window diagnostic and is deliberately not a scope-level comparative signal. The published per-scope comparative signal is [`selection`](#per-scope-selection-signal), which aggregates every bounding window instead of reporting one extreme.

### Effective usable runway

`effectiveAvailability[].runway` is an optional, additive field derived from every authoritative `boundedBy` window using the report's single `generatedAt` clock. It is completion-risk evidence, not a score or recommendation.

| `runway.status`        | Meaning                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exhausted_now`        | A bounding window reports zero remaining now. `usableRunwaySeconds` is `0`; `limitingWindowId` names that bound.                                                                                                              |
| `projected_exhaustion` | Every bound is measurable and one or more cycle-average projections exhaust before their own resets. The earliest one supplies `usableRunwaySeconds`, `projectedExhaustedAt`, `limitingWindowId`, and `projectionConfidence`. |
| `through_reset`        | Every measurable bound reaches its own current-cycle reset before projected exhaustion. There is deliberately no synthetic finite deadline or combined reset timestamp.                                                       |
| `unknown`              | A stale, missing, malformed, or otherwise unmeasurable authoritative bound prevents a sound aggregate conclusion. `unmeasurableWindowIds` names the blockers.                                                                 |

In default TOON the finite-runway detail moves to `exhaustion[]`; `runway` and `projectionConfidence` stay as the `runway` and `confidence` columns of the scope's `quota[]` row, and `unmeasurableWindowIds` becomes an `attention[]` row naming the blocked signals.

`usableRunwaySeconds` is nonnegative and is present only for finite results. `projectionConfidence` is `early` or `established`. Zero observed usage with a valid current cycle proves `through_reset` under that same cycle-average basis. Named model or product windows are additional bounds only for their applicable scopes, so they can become the effective limiting window without changing other scopes.

A bounding window with no `resetsAt` at all has not been triggered yet (e.g. a Claude `five_hour` window before its first request this window) rather than being a data gap. When that untriggered window also reports zero usage (100% remaining, 0% used), it is treated as fully available and excluded from `unmeasurableWindowIds`, so it never forces `runway.status: unknown` by itself; the report's other bounding windows still determine the aggregate. Its 100% can still contribute to `effectivePercentRemaining` as a headroom bound. quota-axi never synthesizes a `resetsAt` or starts the countdown client-side. A missing `resetsAt` paired with any other usage shape (unknown usage, or nonzero usage without an active clock) is a real data gap, not "not yet triggered," and still fails closed into `unmeasurableWindowIds` - alongside stale data, missing usage percent, an expired or malformed `resetsAt` that is actually present, and a missing projection when usage is nonzero and the cycle is known.

### Per-scope selection signal

`effectiveAvailability[].selection` is an optional, per-scope object published for every scope quota-axi reports, including `unknown` and stale ones. It is the primary published selection signal: one scalar per scope, comparable across scopes, providers, and accounts. Consumers that need to distinguish accounts can request the optional account identity with `--full`.

In default TOON the scalar is the `spendPriority` column of the scope's `quota[]` row - there is no separate `selection[]` block, at any tier, because the column already carries it. An unmeasurable scalar renders the literal `unknown`, never `0`: `0` is exact utilization, a completely different claim.

| Field                   | Meaning                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `status`                | `known` when every bounding window is measurable; otherwise `unknown`               |
| `spendPriority`         | The clamped scope scalar. Present only when `status` is `known`                     |
| `unmeasurableWindowIds` | Bounding windows without usable pace. Present whenever one made the scope `unknown` |

For each bounding window `w` of the scope:

```text
S_w         = percentRemaining_w - burnMultiple_w * timeRemainingPercent_w
gap_w       = S_w / timeRemainingPercent_w
scopeMetric = SUM(gap_w * cycleSeconds_w) / SUM(cycleSeconds_w)
```

`S_w` is the percentage points of that window's paid allowance projected to reach reset unused if the observed burn continues. Dividing by `timeRemainingPercent_w` makes windows on different reset clocks comparable, and weighting by `cycleSeconds_w` keeps a short session window from dominating a weekly or monthly one. The result is clamped to `[-100, +100]`.

| `spendPriority` | Meaning                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Positive        | Paid allowance is on track to reach reset **unused**, so spending here reclaims allowance that would otherwise be forfeited |
| `0`             | Exact utilization: the scope is projected to finish its cycle with nothing left over and nothing overdrawn                  |
| Negative        | Overdrawn against the reset clock                                                                                           |

A higher `spendPriority` therefore marks the scope where spending recovers the most paid allowance that would otherwise expire unused. At `burnMultiple` 1, `S_w` reduces exactly to that window's `reservePercentPoints`; the metric generalizes reserve to projected forfeiture at the observed burn pace.

Any bounding window without usable pace makes the **whole scope** unmeasurable: `status` is `unknown`, no scalar is emitted, and `unmeasurableWindowIds` names the blockers. An unknown window is never assumed healthy and never treated as zero. A window whose remaining cycle time has effectively run out is unmeasurable rather than infinite. The one case where an absent `burnMultiple` is not a gap is a window with zero elapsed cycle time and zero usage: nothing can have been consumed yet, so its observed burn is `0` and the scope stays measurable.

`selection` is derived per report from the same `generatedAt` clock as `pace` and `runway`, and is not cached.

**This is data, not routing.** quota-axi still never routes, ranks a winner, orders providers preferentially, proxies, logs in, or changes provider quota state. `selection` is a derived comparative _data_ signal computed entirely from figures quota-axi already reports; any routing, ranking, or preference is the consumer's decision. It is also advisory only: it never overrides `runway`, which remains the hard completion-risk evidence a consumer checks against its task horizon.

### Quota enums

| Name                             | Values                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Provider statuses                | `fresh`, `stale`, `unavailable`, `auth_required`, `rate_limited`, or `error`           |
| Provider sources                 | `oauth`, `pi:openai-codex`, `cli-rpc`, `cli`, `api`, `web`, `cache`, or `unavailable`  |
| Current provider adapter sources | `oauth`, `pi:openai-codex`, `cli-rpc`, `cli`, `api`, `web`, `cache`, and `unavailable` |
| Window kinds                     | `session`, `weekly`, `monthly`, `model`, `credits`, or `unknown`                       |
| Window pace statuses             | `ahead`, `on_pace`, `behind`, or `unknown`                                             |
| Effective pace statuses          | `ahead`, `on_pace`, `behind`, `mixed`, or `unknown`                                    |
| Effective runway statuses        | `exhausted_now`, `projected_exhaustion`, `through_reset`, or `unknown`                 |
| Effective selection statuses     | `known` or `unknown`                                                                   |
| Pace projection confidence       | `early` or `established`                                                               |
| Pace cycle basis                 | `starts_at_resets_at` or `window_seconds`                                              |
| Quota relationship statuses      | `known`, `partial`, or `unknown`                                                       |
| Source attempt statuses          | `success`, `failed`, or `skipped`                                                      |

Source attempts can include `credentialPresent` when a source is not genuinely absent, including when a read failure prevents a more precise classification. They can include `degraded: false` when a non-success attempt is not a broken credential source; otherwise fresh reports derive `state.degradedSources` from failed attempts and skipped attempts with `credentialPresent`.

### Provider windows

| Provider               | Windows and capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude                 | Can report `five_hour`, `seven_day`, optional `seven_day_opus`, and optional `extra_usage` windows. Trusted session/weekly/model windows emit fixed `windowSeconds` (18,000 or 604,800) for pace; `extra_usage` does not invent a monthly duration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Claude scoped `limits` | When the account's usage response includes a scoped `limits` list, quota-axi surfaces every active window it describes instead, including model-scoped ones (e.g. Fable) as a `model:<slug>` window with the same trusted weekly duration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Codex                  | Identifies exact 18,000-second and 604,800-second periods as `five_hour` and `weekly`, regardless of source slot; periods without a duration retain their positional identity. Additional model- or feature-scoped limits use `model:<id>:5h` / `model:<id>:7d`, and code-review limits use `code_review_five_hour` / `code_review_weekly`. Unfamiliar durations remain honest `<hours>h` windows instead of being classified as known periods. Duplicate derived IDs are preserved with `_2`, `_3`, and later suffixes. Optional credit balance data can also appear.                                                                                                                                                                                                                                                                                                                                                                                       |
| Cursor                 | Can report `included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit` windows from `GetCurrentPeriodUsage`, plus an optional `grok_bot` weekly window from the same dashboard service's `GetSandUsageStatus` RPC. Their effective-availability interpretation is documented in [Quota windows](#quota-windows). Monthly labels alone are not trusted cycle evidence, but the billing cycle is: the monthly windows take `startsAt` from a reported `billingCycleStart`, or - with only `billingCycleEnd` - from the previous renewal date one calendar month earlier (clamped to the last day of that month), so pace uses `starts_at_resets_at`. With neither field the cycle stays unresolved; no fixed 30-day duration is invented. The Grok Bot window uses the sand payload's own `currentPeriodStart` / `nextResetTimestampUtc` pair when present, and is omitted when that RPC is missing, non-finite, or a pooled enterprise allowance. |
| GitHub Copilot         | Can report quota snapshot windows such as `chat`, `completions`, and `premium_interactions`; when the first-party endpoint exposes entitlement but no numeric quota windows, quota-axi reports a fresh provider state with an empty `windows` list rather than inventing percentages. Pace stays `unknown` without trusted cycle boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Grok                   | With a consumer-compatible Grok session or Pi `xai` OAuth bearer, can report the shared `credits` window, optional product-scoped `product:<slug>` windows, the current-period `startsAt` and reset, and optional prepaid credit balance from the consumer Usage-page operation. Official Grok Build OAuth and Pi OAuth can remain valid for their model catalogs while that separate operation rejects their audience; in that case quota-axi reports usable auth with no windows rather than inventing a SuperGrok percentage. A Pi `xai` API key likewise establishes model usability only. Top-level `credits.remaining` is prepaid/on-demand balance, distinct from the shared period `windows` credits percentage used for effective availability. Pace prefers the startsAt/resetsAt pair.                                                                                                                                                            |
| Grok proto3 zero       | For the exact consumer operation only, an omitted usage float is the official proto3 zero when a valid weekly or monthly current period proves the config is present; quota-axi reports `0` used and `100` remaining rather than deriving usage from money.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Kimi                   | Reports the principal `weekly` subscription window (with trusted 604,800s duration) plus every valid self-described limit in wire order. Only a limit whose normalized duration is exactly 18,000 seconds is identified as `five_hour`; future limits remain `limit:<index>` unknown windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Z.AI                   | Can report the Coding Plan `five_hour` and `weekly` token windows (with trusted 18,000s and 604,800s durations) plus the `mcp_month` tool window, whose duration is not invented. The two token limits are identified by the endpoint's own `unit`/`number` values rather than array position; any other limit, or a repeat of an already reported one, degrades to an untrusted `limit:<index>` unknown window named in `state.untrustedWindowIds`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Antigravity (`agy`)    | On macOS and Linux, can report `gemini_5h`, `gemini_weekly`, `claude_gpt_5h`, and `claude_gpt_weekly` from an already-running Antigravity app or `agy` loopback quota summary. If only model config quota is exposed, quota-axi reports model-scoped `model:<slug>` windows instead of inventing grouped windows. Antigravity v1 snapshots do not expose enough history for honest burn-rate pace, so pace stays `unknown`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Alibaba                | Reads the local `bl` CLI's Alibaba Coding Plan Token Plan usage; reports the plan name and weekly remaining percentage and reset time from the CLI's JSON output, plus any named model limits as separate `model:<name>` windows. Repeated limits for the same model remain separate with suffixed IDs such as `model:<name>:2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| OpenCode Go            | Reads `opencode-go` (falling back to `opencode`) from OpenCode's `auth.json` and reports the provider's rolling, weekly, and monthly usage windows. It uses only cycle durations present in the payload; absent durations remain absent, and the windows' effective relationship stays unknown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Model catalog and `models`

`quota-axi models [--intelligence high|medium|low] [--sort runway] [--provider ...] [--json|--full]` joins a reviewed catalog of native Claude, Codex, Grok, and Kimi models to the provider's effective quota evidence. It queries those four catalog-backed providers by default and accepts only those providers in an explicit models scope. Cursor and Copilot are excluded from this first catalog because their hosted model availability is plan-dependent; Copilot's quota relationships are also currently unknown. Z.AI, Alibaba, OpenCode Go, and Antigravity report quota but have no reviewed catalog entries yet, so they are not `models` providers either.

Catalog buckets are coarse editorial classifications relative to the current frontier, not scores. They are curated from public provider material and public leaderboards, including [Artificial Analysis](https://artificialanalysis.ai/) as an informing source. quota-axi does not reproduce Artificial Analysis scores, has no runtime Artificial Analysis dependency, and never commits an Artificial Analysis key. `scripts/refresh-model-kb.ts` is a maintainer-only review aid: it may use a private `AA_API_KEY` to suggest changes, but it never writes the catalog.

Every models response includes `catalog.version` and `catalog.provenance`; callers must treat catalog freshness and unmapped `unmatchedWindowIds` as explicit uncertainty. A model row exposes the applicable effective quota scope and provider state. When no model-specific scope is known, the provider account scope remains the evidence rather than an invented model limit.

Default model order is deterministic and non-preferential: provider, then model ID. `--sort runway` is an explicit, evidence-preserving comparator only: finite `usableRunwaySeconds` descend, then `through_reset`, then `exhausted_now`, with unknown evidence last. Equal evidence appears in `sort.tieGroups`; no hidden score or model, provider, harness, credential, or route recommendation is implied. The comparator registry is intentionally extensible for a future separately sourced `cost` comparator, which is not shipped in v1.

### `auth --json` shape

| Object               | Fields                                                    |
| -------------------- | --------------------------------------------------------- |
| Auth report          | `generatedAt`, `schemaVersion: 1`, and `auth`             |
| Provider auth report | `provider` and `sources`                                  |
| Auth source entry    | `source`, optional `path`, `status`, and optional `error` |

Auth source entries can include `credentialPresent` when a source is not genuinely absent, including when a read failure prevents a more precise classification.

| Name                 | Values                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth source statuses | `available`, `missing`, `invalid`, `expired`, `skipped`, or `error`                                                                                                                                                                      |
| Auth source names    | `oauth-file`, `keychain`, `auth-json`, `auth-env`, `apps-json`, `state-vscdb`, `cli-keychain`, `cli-authfile`, `cli-rpc`, `pi:openai-codex`, `pi:kimi-coding`, `pi:xai`, `kimi-code-cli`, `opencode:auth.json`, `bl-cli`, and `loopback` |

## Security Posture

### Provider credential sources

| Provider       | Credential sources read                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude         | `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`; on macOS, the corresponding default or path-hashed Claude Code Keychain value pinned to Claude Code's validated current-user account, with `--allow-keychain-prompt` or, after a profile-and-account-scoped non-secret access marker exists, on plain calls                                                                                           |
| Codex          | `$CODEX_HOME/auth.json` or `~/.codex/auth.json`, then Pi's `$PI_CODING_AGENT_DIR/auth.json` `openai-codex` subscription OAuth entry (default `~/.pi/agent/auth.json`), before the read-only CLI fallback; `$QUOTA_AXI_CODEX_BINARY` can pin that fallback to an absolute executable path                                                                                                                                       |
| Cursor         | Cursor editor: `$CURSOR_STATE_DB` when set or the platform Cursor state database path. Cursor CLI (`cursor-agent`), macOS: identity from `$CURSOR_CLI_CONFIG` or `~/.cursor/cli-config.json` plus the `cursor-access-token` / `cursor-user` Keychain value with `--allow-keychain-prompt` or an account-scoped marker; Linux: only `accessToken` from `$CURSOR_CLI_CONFIG` or `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` |
| GitHub Copilot | `$GITHUB_COPILOT_APPS_JSON` when set or the local Copilot apps auth file                                                                                                                                                                                                                                                                                                                                                       |
| Grok           | Grok CLI session auth from `$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json` / `~/.grok/auth.json`, plus Pi's independent `$PI_CODING_AGENT_DIR/auth.json` `xai` entry (default `~/.pi/agent/auth.json`) for OAuth or literal API-key model auth                                                                                                                                            |
| Kimi           | Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) for a literal `kimi-coding` API key or OAuth access token first, then an official Kimi Code CLI access token from `$KIMI_CODE_HOME/credentials/kimi-code.json` (default `$HOME/.kimi-code/credentials/kimi-code.json`). A stored-expired token in either store is still probed rather than skipped                                                     |
| Z.AI           | opencode's `auth.json` (`$XDG_DATA_HOME/opencode/auth.json` when set, otherwise `~/.local/share/opencode/auth.json`) for a literal Coding Plan API key under `zai-coding-plan`, `zai`, `z-ai`, `z.ai`, `zhipu`, or `zhipuai`                                                                                                                                                                                                   |
| Antigravity    | No credential files; discovers already-running Antigravity or `agy` processes and reads only their 127.0.0.1 read-only loopback endpoints                                                                                                                                                                                                                                                                                      |
| Alibaba        | The local `bl` CLI (`bl usage token-plan --output json`); quota-axi never reads Alibaba credential files or exchanges refresh data                                                                                                                                                                                                                                                                                             |
| OpenCode Go    | `$XDG_DATA_HOME/opencode/auth.json` when set, `%LOCALAPPDATA%\opencode\auth.json` on Windows, otherwise `~/.local/share/opencode/auth.json`, for a literal `opencode-go` key with `opencode` fallback                                                                                                                                                                                                                          |

### Provider notes

**Claude**

- quota-axi mirrors Claude Code's Keychain account selector: nonempty `USER`, otherwise the operating-system username, validated against Claude Code's safe account pattern with the same `claude-code-user` fallback. Both presence and value reads require that account plus the resolved service. There is no ambiguous service-only fallback.
- quota-axi records the non-secret access marker after any successful pinned Keychain value read.
- When that profile-and-account-scoped marker exists, plain calls read the pinned Keychain value again so an already-approved "Always Allow" grant keeps live Claude quota fresh. Legacy service-only markers remain untouched but do not authorize a value read.
- Without the flag or the current marker, quota-axi may perform a non-secret pinned Keychain item presence check so it only suggests Keychain access when the selected Claude credential item exists.
- In `--full` output, Claude usage attempts identify `oauth-file` or `keychain` as the credential discovery source. They never include the Keychain account.
- When an access token exists, local `expiresAt` metadata is advisory. quota-axi sends that token only to Anthropic's existing read-only usage request; success returns fresh quota, while HTTP 401 definitively rejects that bearer. HTTP 403 alone is non-definitive because Anthropic's network-policy and WAF denials can use the same status for a valid bearer.
- When that stored token was expired, carried a refresh token, and was definitively rejected, quota-axi may run `claude doctor` and retry once against the store Claude Code rewrote, subject to the best-effort live-process check and residual race described under [Delegated credential refresh](#delegated-credential-refresh). `claude doctor` is Claude Code's own installation health check: it starts no session, sends no model request, spends no quota, and does not connect to configured MCP servers. quota-axi never exchanges the Claude refresh token itself; it only checks that one is present, because Anthropic rotates it on use and a second exchange would sign Claude Code out. On macOS a withheld Keychain value read suppresses the delegate and keeps the Keychain remedy instead, because the CLI would rewrite a store quota-axi still could not read.
- Missing or invalid credentials without a usable access token and usage HTTP 401 normally bypass and best-effort retire Claude cache. When a macOS Keychain value read was denied, however, a 401 from a non-Keychain candidate such as an expired oauth-file sidecar rejects only that candidate: quota-axi reports `keychain_access_denied`, does not classify Claude as signed out, and preserves any eligible stale cache. macOS Keychain `security` exit 44 is likewise cannot-reach, not absence: it does not classify the account as signed out and does not retire the Claude cache. HTTP 403, timeout, network, rate-limit, server, and response-compatibility failures may use only a formerly fresh Claude snapshot less than seven days old that was captured for the same locally selected Claude configuration context (see [Cache](#cache)). Reset-expired windows are removed; resetless session, monthly, and credit windows expire after five hours, resetless weekly and model windows expire after seven days, and resetless unknown windows are rejected. A stale Claude attention row names `fetch failed` plus the usage-fetch error rather than a bare stale label.
- After a successful usage read, quota-axi queries Anthropic's first-party OAuth profile endpoint with the same credential. Its authoritative root `account.uuid` is exposed as `account.accountId` only in `--full` output; if that field is absent, `identityStatus` is `unverified` instead of deriving an identity from email, organization data, or cached account metadata.

**Codex**

- Codex checks native `$CODEX_HOME/auth.json` or `~/.codex/auth.json` OAuth first.
  If that does not return quota, it checks the exact `openai-codex` entry in Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) before the CLI fallback.
  A successful Pi-backed probe reports source `pi:openai-codex`.
- Native Codex `auth.json` support is OAuth-token only; API key values such as `OPENAI_API_KEY` are treated as invalid for quota usage calls and are not sent to ChatGPT usage endpoints.
- Access-token JWT usability is authoritative for the native OAuth bearer probe.
  An expired `id_token` alone does not mark `auth-json` expired or skip OAuth; identity-token expiry is diagnostic metadata only.
  A stored-expired `access_token` is still probed in native OAuth's first declared source position rather than skipped, so only the usage endpoint's own rejection is an authentication verdict. A missing `access_token` skips OAuth and preserves the Pi and read-only CLI fallbacks.
- The Pi broker opens `auth.json` read-only with a strict 64 KiB cap and guaranteed descriptor cleanup.
  It accepts only Pi's literal ChatGPT subscription OAuth shape: nonempty, control-byte-free `access` and `accountId` strings plus a numeric millisecond `expires` value.
  Strings containing `$` or beginning with `!` are rejected rather than resolved.
  Pi `api_key` entries are unsupported because platform API billing is not ChatGPT subscription quota.
  Malformed, unsupported, expired-refreshable, and expired-non-refreshable states remain distinct diagnostics.
- quota-axi checks only whether Pi's refresh property is present; it never reads or retains the refresh-token value.
  It never performs a refresh-token exchange, refreshes Pi OAuth, launches Pi, or writes credential state.
  Pi owns refresh; quota-axi reads the current entry and sends its access token and account ID only to the existing bounded, read-only ChatGPT usage probe. Stored expiry is advisory, so the probe may test a stored-expired access token and only the endpoint's rejection marks it dead.
  Refresh token values are never logged, rendered, cached, or sent.
  Access token values are never logged, rendered, or cached.
- It may run `codex -s read-only -a untrusted app-server` for Codex JSON-RPC fallback. That probe is also Codex's delegated refresh: the Codex CLI renews its own expired OAuth session and rewrites `auth.json` before answering, so an expired stored token still reports live quota without quota-axi touching the refresh token or spawning a second command. Codex rotates the refresh token on use, which is why the exchange stays the vendor's.
- Set `QUOTA_AXI_CODEX_BINARY` to an absolute executable path when the fallback must use a specific Codex installation. Auth inspection and the app-server probe resolve the same path, and an invalid override fails closed instead of consulting `PATH`.

**Cursor**

- The Cursor editor and the Cursor CLI keep credentials in different stores, so both are independent sources and Cursor auth is usable when either one is. For quota fetching, the editor `state-vscdb` source is tried first because it never prompts; the platform CLI source is tried when the editor has no usable token or its token is rejected. The `auth` command reports both sources.
- Cursor Desktop is not required. On macOS, a CLI-only machine can refresh from the CLI Keychain token after the one-time Keychain grant described below; that quota attempt is named `cli-keychain` in `sourcesTried`. On Linux, `cursor-agent` quota uses the read-only `cli-authfile` source from `auth.json`; its `accessToken` is only a bearer for the existing dashboard RPCs. The editor-credential fetch keeps its historical `api` attempt name. When credential discovery cannot produce a token, an unavailable source known to hold a credential takes precedence over a merely absent store, so a signed-in `cursor-agent` user sees the applicable source state rather than `Cursor sign-in required`.
- Editor source: it uses `sqlite3 -readonly` to read `cursorAuth` values and calls Cursor's first-party dashboard RPCs. If `sqlite3` is unavailable, that source is reported as skipped with `sqlite3_unavailable`.
- CLI source: on macOS, `cli-config.json` holds sign-in identity only and is never a token; its `authInfo` supplies the reported account email, and the access token is read from the login Keychain item `cursor-access-token` / `cursor-user` only under `--allow-keychain-prompt` or an existing account-scoped non-secret access marker. On Linux, `cli-authfile` reads only `accessToken` from `$CURSOR_CLI_CONFIG` or `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json`; missing, unreadable, malformed, or empty files are unavailable. The sibling refresh token is never read.
- quota-axi never refreshes Cursor credentials, and Cursor has no delegated refresh. Neither the Linux auth-file refresh token nor the macOS `cursor-refresh-token` Keychain item is read, and no non-interactive `cursor-agent` command was observed to rotate the stored session, so an expired or rejected CLI access token falls through to stale/unavailable reporting and requires `cursor-agent login` outside quota-axi. Cursor CLI session tokens are long-lived (about sixty days observed), so this costs little in practice. This is a known limitation, not a silent gap.
- The token value is used only as the bearer of Cursor's read-only dashboard RPCs (`GetCurrentPeriodUsage`, `GetPlanInfo`, and `GetSandUsageStatus`). It is never logged, cached, or included in any output. quota-axi does not call Grok Bot trial, banked-reset, or machine-registration methods.

**GitHub Copilot**

- It calls GitHub's first-party Copilot user endpoint.
- It only sends tokens associated with public GitHub hosts to that public endpoint; host-specific GitHub Enterprise tokens are treated as unavailable there.
- The stored Copilot OAuth token does not expire and carries no refresh token, so there is nothing to renew and Copilot has no delegated refresh.

**Grok**

- It checks two independent usability sources: Grok CLI session auth and Pi's `xai` credential in `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`). Grok is locally usable when either source is usable, including asymmetric cases where the other source is absent, malformed, stale, or expired. True sign-out requires every applicable source to be unavailable or definitively rejected; `authStatus: unusable` can also accompany an indeterminate local credential-resolution failure, but that failure remains `state.status: error` rather than `auth_required`.
- Grok CLI session-scoped auth and Pi `xai` OAuth are eligible, read-only, for Grok's consumer `grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig` operation. The CLI source is attempted first; fresh quota makes a Pi request unnecessary, authenticated-but-unmeasurable auth falls through to Pi for numeric quota, and a transient failure stops sibling handover. CLI session-scoped entries are preferred over API-key entries. Observed Grok CLI OIDC access tokens are short-lived (about six hours on current CLI sessions) while a refresh token remains present for CLI-owned recovery.
- Session-scoped Grok auth includes web/session scopes and official Grok Build OIDC records scoped to `auth.x.ai` with `auth_mode` or `authMode` set to `oidc`, including scope keys with `::<client id>` suffixes. A consumer-operation 401/403 for official Build OIDC is followed by a GET to `https://cli-chat-proxy.grok.com/v1/models`; success proves subscription-backed model auth but that catalog carries no numeric quota, so its body is discarded and the report stays unmeasurable.
- Pi `xai` auth follows Pi's auth-file contract: `type: "oauth"` with literal `access` / optional `refresh` / `expires`, or `type: "api_key"` with a literal `key`. Environment, template, and command references are not resolved. Ambient `XAI_API_KEY` is not a quota-axi credential source. A Pi OAuth bearer is first offered to consumer credits; if that operation rejects it, `https://api.x.ai/v1/models` is the corresponding read-only liveness check. A Pi API key establishes model usability locally (`authStatus: usable` with empty windows when it cannot expose consumer quota), not grok.com credits.
- The Grok CLI owns OIDC access-token refresh and rewrites `~/.grok/auth.json`; Pi owns refresh of its own `auth.json` OAuth entries. quota-axi never exchanges a refresh token, launches an agent session, or writes either auth file. Expired-session classification and recovery fields are documented under [Provider `state`](#provider-state).
- When the Grok CLI session was stored-expired, carries a refresh token, and grok.com definitively rejected it, quota-axi runs `grok models` and retries once against the file the CLI rewrote (see [Delegated credential refresh](#delegated-credential-refresh)). `grok models` prints the account's model list and exits: it starts no agent, opens no TUI, and spends no model quota. The delegate is skipped for a relocated store (`GROK_AUTH`, `GROK_AUTH_JSON`, `GROK_AUTH_PATH`), because the CLI would rotate its own default file instead. Pi's `xai` entry has no delegated refresh: no non-interactive Pi command was observed to renew it, so it stays read-only.
- Stored expiry is advisory within a source, never a verdict or a reason to reorder sources. Shared credential selection (`src/providers/credential-selection.ts`) empirically tests stored-expired credentials in that source's declared position. A consumer-compatible bearer wins with fresh quota. An official Build/Pi OAuth bearer rejected only by consumer billing is tested against its own first-party model catalog; catalog success produces usable, unmeasurable auth instead of false expiry or sign-out.
- HTTP 401/403 and auth-class gRPC codes are definitive only for the credential surface receiving them. A transient network/rate-limit failure never switches credentials or becomes an auth verdict (the stored classification stands). Such failures remain stale-cache eligible for same-source web snapshots.
- It does not send browser cookies, perform OAuth, exchange a refresh token, retain model-catalog or raw quota response bodies, or derive usage from model presence, rate-limit headers, or monetary fields. The only Grok process it ever starts is the declared `grok models` refresh delegate.

**Kimi**

- It opens Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) read-only with a strict 64 KiB cap and guaranteed descriptor cleanup. It accepts only the exact `kimi-coding` entry, either `type: "api_key"` with a nonempty, control-byte-free literal string `key`, or `type: "oauth"` with such an `access` token and an optional numeric `expires`. A stored-expired OAuth token remains eligible for the bounded read-only liveness probe in Pi's first declared source position; only the endpoint's rejection marks one dead. A missing file or `kimi-coding` entry is `missing`; malformed or oversized stores, invalid entry shapes, and unsafe environment, template, or command references are `invalid`; unknown credential types are `unsupported`; and expired OAuth is `expired` with refresh-path presence preserved. None of these states resolves references, exposes values, or mutates Pi auth state.
- If the Pi source cannot answer, it reads the official Kimi Code CLI credential at `$KIMI_CODE_HOME/credentials/kimi-code.json`, defaulting to `$HOME/.kimi-code/credentials/kimi-code.json`. It accepts only a non-empty `access_token` with a Unix-seconds `expires_at` (a JSON number or numeric string). A token within 60 seconds of expiry is classified `expired` but is still tested by the bounded read-only probe in the CLI source's declared position; only the endpoint decides the verdict.
- The Pi source always has priority. Ambient API-key environment variables are not a credential source. The CLI source is consulted whenever Pi cannot answer - no supported credential, an unreadable store, or a Pi credential the provider definitively rejected - so a broken Pi entry does not hide a working Kimi Code CLI session. Transport, decoding, timeout, cancellation, and server failures do not trigger credential switching.
- It sends one redirect-disabled `GET` to the fixed `https://api.kimi.com/coding/v1/usages` endpoint with a 15 second total deadline and a 262,144-byte decoded-body cap.
- It never uses `refresh_token`, accepts a custom Kimi origin, launches Pi or Kimi, makes a model request, refreshes or writes credentials, creates a device ID, imports cookies, sends device identity, retains raw responses, or exposes account, plan, token, or fingerprint data. Kimi has no delegated refresh: no non-interactive Pi or Kimi Code CLI command was established as renewing either store, so an expired record stays read-only with honest advice.
- Definitive credential absence or rejection retires Kimi cache data, but only when it is the verdict that speaks for the provider: a sibling source that failed transiently outranks it, so the cache survives. Transient fallback drops reset-expired windows and applies five-hour or seven-day age bounds to windows without resets.

**Z.AI**

- It reads opencode's `auth.json` (`$XDG_DATA_HOME/opencode/auth.json` when set, otherwise `~/.local/share/opencode/auth.json`; `%LOCALAPPDATA%\opencode\auth.json` on Windows) and accepts only a nonempty, control-byte-free literal string key under a known Coding Plan provider id, taken from `key`, `apiKey`, `api_key`, `token`, `accessToken`, or `auth_token`, or from a bare string entry. Environment, template, and command references are not resolved or executed, so an entry that holds one is treated as no credential rather than sent as a header value. quota-axi never writes or manages opencode state.
- The `zai-coding-plan`, `zai`, `z-ai`, and `z.ai` ids resolve to `api.z.ai`, and `zhipu` / `zhipuai` resolve to `open.bigmodel.cn`; ambient API-key environment variables are not a credential source.
- It sends one redirect-disabled `GET` to that host's `/api/monitor/usage/quota/limit` with the key in a bare `Authorization` header (no `Bearer` prefix), a 15 second total deadline, and a 262,144-byte decoded-body cap. The endpoint is undocumented, so normalization is deliberately schema-tolerant rather than positional.
- Definitive credential absence, an unparseable credential file, and HTTP 401/403 retire Z.AI cache data. An auth file that exists but cannot be read is an indeterminate local failure rather than a sign-out, so it reports `state.status: error` and stays cache-eligible. Timeout, network, 408, 429, 5xx, oversized-response, and unreadable-auth-file failures may reuse a formerly fresh snapshot with reset-expired windows removed and, for windows without a reset, five-hour, seven-day, or thirty-day age bounds by window kind; a resetless untrusted unknown window has no age bound of its own and is dropped.
- It never launches opencode, refreshes or writes credentials, sends cookies, retains raw responses, or exposes the account's key or plan identity beyond the plan label the endpoint reports. The Coding Plan key does not expire, so there is nothing to renew and Z.AI has no delegated refresh.

**Antigravity**

- It never launches, restarts, signs in to, or mutates Antigravity or `agy`. It reads no credential store, so it has no delegated refresh either.
- On macOS and Linux, it discovers only the current user's processes and their owned listening ports, then sends read-only POST requests with operation-specific bodies to local endpoints on `127.0.0.1`. An app-advertised extension port is eligible only when the same process owns its listener.
- It prefers `RetrieveUserQuotaSummary` with `forceRefresh: false`, uses `GetUserStatus` for plan identity and account identity exposed only behind `--full`, and can fall back to model quota data from `GetUserStatus` / `GetCommandModelConfigs` when grouped quota summary is unavailable.
- Percent remaining and reset times come only from vendor `remainingFraction`/`resetTime` fields. It does not invent windows, resets, or percentages.
- Burn rate is not reported for Antigravity v1 because the local payload exposes point-in-time quota snapshots, not enough history to compute a rate honestly.

### Delegated credential refresh

quota-axi reports quota; it is not an auth app. It never mints a credential, never rotates one, and never performs a refresh-token exchange over HTTP. Those refresh tokens rotate on use, so a second holder performing the exchange would spend the vendor's own single-use token and sign the user out of the harness being measured.

Instead, when the same stored access token is expired, carries a refresh token, **and** is definitively rejected, quota-axi may run the vendor CLI's own smallest non-interactive command that already owns rotation, then re-read the store that CLI rewrote and retry the same read-only quota request once. Rotation is always the vendor's; quota-axi only reads the result.

| Provider                                                              | Vendor-owned recovery path        | Store the vendor rewrites                             |
| --------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| Claude                                                                | `claude doctor` delegate          | the Claude Code Keychain item, or `.credentials.json` |
| Codex                                                                 | existing `app-server` quota probe | `$CODEX_HOME/auth.json`                               |
| Grok                                                                  | `grok models` delegate            | `$GROK_HOME/auth.json`                                |
| Cursor, GitHub Copilot, Kimi, Z.AI, Alibaba, OpenCode Go, Antigravity | none                              | read-only; see the per-provider notes below           |

The Claude and Grok delegated runs are bounded the same way:

- Fixed argv declared in this repository, resolved through `PATH` (or a provider's absolute binary override), never through a shell and never assembled from provider responses, configuration, or user input.
- No interactive surface: the child gets no stdin, so a vendor command that would prompt exits instead of waiting; `TERM=dumb`, `NO_COLOR=1`, and the vendors' own `NO_BROWSER` / `NO_OPEN_BROWSER` opt-outs are forced. No delegate opens a browser, starts a session, or spends the quota being measured.
- A wall-clock budget that bounds how long quota-axi waits, never how long the vendor may run. quota-axi never signals a delegated run: the command is the vendor performing a single-use OAuth refresh-token exchange against its own store, and interrupting one part way through is the sign-out this whole design exists to prevent. When the budget expires quota-axi stops waiting, leaves the vendor running, and reports the refresh as unconfirmed. The delegate also runs in its own process group, so a Ctrl+C that quits a live `--tui` cannot land on a vendor mid-exchange.
- At most one delegated refresh per credential source per quota read. That bound is per read rather than per process, so a long-running `--tui` still recovers from a session that expires while it is up.
- Vendor output is discarded at the operating system, never read. A credential is never parsed out of a vendor's stdout; the refreshed value only ever comes from re-reading the vendor's own store.
- It runs only for soft expiry: a stored-expired credential that carries a refresh token and was definitively rejected. Transient failures, missing or malformed stores, stored-valid credentials the server revoked, and relocated stores the vendor would not rewrite all stay read-only.
- Claude adds a best-effort check before delegating: the process list must show no Claude Code process. Claude Code owns that session and refreshes it on its own schedule, so `claude doctor` alongside a live session is at best redundant and at worst a second holder racing a single-use refresh token. This also means a detached `claude doctor` that outlives quota-axi's wait is visible to the next read, which stays read-only instead of stacking another refresh on it. Not knowing counts as not safe: where the process list cannot be read (Windows, no effective uid, no `ps`), quota-axi stays read-only rather than guessing. The check and spawn are not atomic, so a Claude Code session starting after the check or another concurrent quota-axi read can still overlap the delegate. This narrows the common repeated five-minute `--tui` versus live-session collision and, together with never signaling the delegate, is strictly safer than force-killing without adding a failure mode beyond the pre-existing vendor-owned race.
- `--no-credential-refresh` disables it entirely, and the read-only `auth` command never delegates a refresh.

A Claude or Grok delegated run appears in `--full` output as its own attempt (`claude-cli-refresh`, `grok-cli-refresh`). Its `error` says what happened, so a report shows why no refresh took place:

| Attempt error                      | Meaning                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `refresh_command_not_found`        | The vendor CLI is not installed, so there was nothing to delegate to (`skipped`). |
| `refresh_spawn_failed`             | The vendor command could not be started.                                          |
| `refresh_live_vendor_process`      | Claude Code is already running and owns its own refresh (`skipped`).              |
| `refresh_vendor_processes_unknown` | quota-axi could not read the process list, so it stayed read-only (`skipped`).    |
| `refresh_timed_out`                | The vendor outran quota-axi's wait and was left running; the outcome is unknown.  |
| `refresh_exit_status`              | The vendor ran and exited non-zero; the store was still re-read.                  |

A `refresh_timed_out` run is never treated as a credential verdict. Claude reports that read as unmeasured (`claude_refresh_unconfirmed`), falling back to a stale cached snapshot when one applies, and keeps the cached snapshot rather than retiring it. On Windows, a resolved `.cmd` or `.bat` command shim runs through the platform command interpreter without enabling Node's shell mode, preserving the no-shell argument boundary. Quota accuracy and the no-shell safety guarantee are unchanged. Codex needs no extra spawn: its existing read-only `cli-rpc` app-server probe both refreshes `auth.json` and returns the rate limits, so an expired Codex token already reports live quota through the vendor CLI.

Providers with no established non-interactive rotation command stay read-only on purpose. That is a documented limitation rather than a reason to force an unsafe path: Cursor's CLI token is long-lived and no non-interactive `cursor-agent` command was observed to rotate it, GitHub Copilot's stored OAuth token does not expire, Z.AI uses a non-expiring API key, Alibaba is accessed through the read-only `bl` usage command, OpenCode Go has no vendor-owned rotation command, Pi-owned OAuth entries (`openai-codex`, `xai`, `kimi-coding`) have no non-interactive Pi refresh command, and Antigravity exposes no credential store at all.

### Safety guarantees

- Quota and auth HTTP requests go only to first-party provider usage, quota, billing, entitlement, or read-only credential-liveness endpoints with the user's local credentials; Antigravity requests stay on 127.0.0.1 loopback.
- The user-initiated `update` command is the only outbound non-provider network surface, and it is not part of quota measurement.
- It sends credential values only to the first-party provider request they authenticate.
- It never prints, logs, or caches credential values.
- It never mints, rotates, or writes a credential, and never performs a refresh-token exchange. Credential renewal is always delegated to the vendor CLI that owns the store (see [Delegated credential refresh](#delegated-credential-refresh)).
- It never retains, prints, logs, renders, caches, sends, or exchanges a refresh token's value. The Pi credential brokers read a stored refresh value only to derive a usability boolean - whether it is a usable literal secret rather than absent or an environment, template, or command reference - and discard it immediately; elsewhere only its presence is checked, as evidence that the vendor can still recover.
- It never launches the Cursor, Pi, Kimi, or OpenCode CLIs. It runs the read-only Alibaba `bl` usage command, the declared read-only Codex app-server probe, and the two declared refresh delegates (`claude doctor`, `grok models`); none starts a session or spends the quota being measured. Antigravity/`agy` is never launched.
- It never signals or kills a delegated refresh. A vendor that outruns quota-axi's wait is left to finish its own token exchange, and quota-axi reports an unconfirmed refresh instead of a credential verdict.
- It never routes, ranks a winner, or orders providers preferentially. Derived comparative signals, including `effectiveAvailability[].selection`, are published as data for the consumer to act on.

### Cache

| Item                                   | Behavior                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quota cache                            | Lives at `~/.cache/quota-axi/quotas.json` or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.                                                                                                                                                                                                                                                                         |
| Quota cache permissions                | Uses `0600` file permissions.                                                                                                                                                                                                                                                                                                                                                         |
| Quota cache contents                   | Stores normalized non-secret snapshots only.                                                                                                                                                                                                                                                                                                                                          |
| Claude Keychain access marker          | Lives alongside the quota cache as `claude-keychain-access-granted[-<profile-hash>]-account-<account-hash>`; the profile hash is eight hexadecimal characters when applicable and the account hash is sixteen. It uses `0600` file permissions, contains no credential material or raw account name, and legacy service-only markers are ignored rather than deleted.                 |
| Cursor CLI Keychain access marker      | Lives alongside the quota cache as `cursor-cli-keychain-access-granted-account-<account-hash>`, where the account hash is sixteen hexadecimal characters. It uses `0600` file permissions and contains no credential material or raw account identity.                                                                                                                                |
| Cached reports                         | Only fresh provider snapshots with windows are cached.                                                                                                                                                                                                                                                                                                                                |
| Fresh provider reports with no windows | Clear any cached snapshot for that provider, so entitlement-only reports do not leave stale quota windows behind.                                                                                                                                                                                                                                                                     |
| Reports and details not cached         | Failed providers, stale providers, account identity, and source attempts are not cached.                                                                                                                                                                                                                                                                                              |
| Claude cache fallback                  | Follows the [Claude provider rules](#provider-notes), including the denied-Keychain exception. Eligible fallback uses a formerly fresh snapshot from the same selected Claude configuration context, with a seven-day provider bound plus reset and resetless-window pruning. Its cache-only SHA-256 context identifier is opaque; legacy context-less Claude records are not reused. |
| Codex cache identities                 | Cached Codex windows are accepted only when ID, label, kind, duration, and duplicate suffix order agree; stale snapshots with mismatched identities are rejected.                                                                                                                                                                                                                     |
| Grok cache provenance                  | Only snapshots produced by the current `web` consumer operation can be used as Grok stale fallback; legacy `api` billing-proxy snapshots are rejected.                                                                                                                                                                                                                                |

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
