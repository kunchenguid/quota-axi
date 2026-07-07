<h1 align="center">quota-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/quota-axi"><img alt="npm" src="https://img.shields.io/npm/v/quota-axi?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/quota-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/quota-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://x.com/kunchenguid"><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square" /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord" /></a>
</p>

<h3 align="center">Know your local agent quota headroom without turning it into routing advice.</h3>

Agents need quota state before they choose where work can safely run.
Vendor dashboards are not shaped for shell automation, and local CLIs expose different windows, resets, and auth files.

quota-axi reports local Claude and Codex quota windows in one AXI-shaped call.
It is data only: it never routes, recommends, proxies, intercepts, logs in, imports browser cookies, or mutates provider state.

- **Honest comparison ceiling** - quota-axi reports normalized quota windows, reset times, and provider credit balances when available.
- **Local first** - it reads local Claude and Codex auth sources, calls first-party provider endpoints, and can fall back to a read-only Codex app-server probe.
- **Agent shaped** - default stdout is compact TOON, with JSON available for callers that need the normalized model.

## Quick Start

```sh
$ npx -y quota-axi
bin: ~/.npm/_npx/.../quota-axi
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2026-07-06T18:10:00.000Z"
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,pro,oauth,fresh,"2026-07-06T18:09:55.000Z"
  codex,plus,cli-rpc,fresh,"2026-07-06T18:09:58.000Z"
windows[6]{provider,id,label,percentRemaining,resetsAt,state}:
  claude,five_hour,session,82,"2026-07-06T22:15:00.000Z",fresh
  claude,seven_day,week,64,"2026-07-10T16:00:00.000Z",fresh
  claude,seven_day_opus,opus week,93,"2026-07-11T09:30:00.000Z",fresh
  claude,extra_usage,extra usage,75,unknown,fresh
  codex,five_hour,session,71,"2026-07-06T21:45:00.000Z",fresh
  codex,weekly,week,43,"2026-07-11T09:00:00.000Z",fresh
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
```

```sh
$ quota-axi auth
bin: ~/.npm/_npx/.../quota-axi
description: Inspect local quota auth sources without printing secret values
auth[4]{provider,source,path,status,error}:
  claude,oauth-file,~/.claude/.credentials.json,available,none
  claude,keychain,none,skipped,keychain_prompt_required
  codex,auth-json,~/.codex/auth.json,available,none
  codex,cli-rpc,none,available,none
help[1]:
  Run `quota-axi --allow-keychain-prompt auth` to permit macOS Keychain access
```

## Install

quota-axi requires Node.js 20 or newer.

**npm**

```sh
npm install -g quota-axi
```

**Direct use**

```sh
npx -y quota-axi
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

The npm package includes `skills/quota-axi/SKILL.md`, an installable skill for agent runtimes that support local skills.
The skill is generated from `src/skill.ts`; update it with `pnpm run build:skill` and verify it with `pnpm run build:skill -- --check`.

## How It Works

```
┌────────────┐
│ quota-axi  │
└─────┬──────┘
      ▼
┌───────────────┐
│ claude,codex  │
└─────┬─────────┘
      ▼
┌───────────────┐       ┌──────────────┐
│ local auth    │ ───▶  │ first-party  │
│ sources       │       │ usage APIs   │
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

- **Live first** - direct provider usage calls use 15 second request timeouts, Codex JSON-RPC reads use short per-call timeouts, and stale cache fallback is per provider.
- **No default Keychain prompt** - macOS Claude Keychain reads are skipped unless `--allow-keychain-prompt` is passed.
- **Partial success is success** - one provider can fail while another returns fresh or stale data, and the process still exits 0. Exit code 1 means every provider failed, and 2 means a usage error.
- **No token equivalence** - quota-axi does not claim that one provider percentage equals another provider percentage.

## CLI Reference

| Command     | Description                                      |
| ----------- | ------------------------------------------------ |
| `quota-axi` | Report Claude and Codex quota windows            |
| `auth`      | Report local auth-source availability, no values |

### Flags

| Flag                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `--provider claude,codex` | Scope providers                                        |
| `--json`                  | Emit normalized JSON instead of TOON for quota or auth |
| `--full`                  | Include quota account identity and source attempts     |
| `--allow-keychain-prompt` | Permit macOS Claude Keychain access that could prompt  |
| `-h`, `--help`            | Print terse AXI help                                   |
| `-v`, `-V`, `--version`   | Print version                                          |

## Output Model

`--json` emits `schemaVersion: 1`.
Quota reports contain `providers`, each with `provider`, `label`, `source`, `windows`, `state`, optional `plan`, and optional `credits`.
With `--full`, providers can also include `account` identity and per-source `attempts`.
Provider `state` includes `status`, `stale`, `sourcesTried`, optional `refreshedAt`, optional `error`, and optional `retryAfter`.
Quota windows include `id`, `label`, `kind`, optional percentages, optional reset fields, optional `windowSeconds`, and optional credit-spend fields.
Account identity and per-source `attempts` are omitted unless `--full` is passed.
Provider statuses are `fresh`, `stale`, `unavailable`, `auth_required`, `rate_limited`, or `error`.
Provider sources are `oauth`, `cli-rpc`, `api`, `web`, `cache`, or `unavailable`; v1 emits `oauth`, `cli-rpc`, `cache`, and `unavailable`.
Window kinds are `session`, `weekly`, `monthly`, `model`, `credits`, or `unknown`.
Source attempts use `success`, `failed`, or `skipped`.
Claude can report `five_hour`, `seven_day`, optional `seven_day_opus`, and optional `extra_usage` windows.
When the account's usage response includes a scoped `limits` list, quota-axi surfaces every active window it describes instead, including model-scoped ones (e.g. Fable) as a `model:<slug>` window.
Codex can report `five_hour` and `weekly` windows plus optional credit balance data, plus any additional model- or feature-scoped rate limits the account has as `model:<id>:5h` / `model:<id>:7d` windows, and an optional code-review rate limit as `code_review_five_hour` / `code_review_weekly`.
`auth --json` emits `generatedAt`, `schemaVersion: 1`, and `auth`, where each provider report has `provider` and `sources`.
Auth source entries include `source`, optional `path`, `status`, and optional `error`.
Auth source statuses are `available`, `missing`, `invalid`, `expired`, or `skipped`.
Auth source names are `oauth-file`, `keychain`, `auth-json`, and `cli-rpc`.

## Security Posture

quota-axi reads `~/.claude/.credentials.json` for Claude.
On macOS, it reads `Claude Code-credentials` from Keychain only with `--allow-keychain-prompt`; when enabled, the Keychain credential is tried before file credentials.
For Codex, it reads `$CODEX_HOME/auth.json` or `~/.codex/auth.json` before the read-only CLI fallback.
Codex `auth.json` support is OAuth-token only; API key values such as `OPENAI_API_KEY` are treated as invalid for quota usage calls and are not sent to ChatGPT usage endpoints.
It may run `codex -s read-only -a untrusted app-server` for Codex JSON-RPC fallback.
It never launches the Claude CLI, so it cannot accidentally spend the quota it measures.

Direct HTTP requests go only to Anthropic and OpenAI first-party usage endpoints with the user's local credentials.
It sends credential values only to the first-party provider request they authenticate.
It never prints, logs, or caches credential values.
The cache lives at `~/.cache/quota-axi/quotas.json` (or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set), uses `0600` file permissions, and stores normalized non-secret snapshots only.
Only fresh provider snapshots with windows are cached.
Failed providers, stale providers, account identity, and source attempts are not cached.

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

## Attribution

quota-axi is independently implemented from local Baby Menu quota code and public provider behavior references.

## License

MIT
