# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- quota-axi is data only.
- It reports local Claude, Codex, Cursor, GitHub Copilot, Grok, and Kimi quota windows, and it must never route, recommend, proxy, intercept, log in, import browser cookies, or mutate provider state.
- Claude quota windows can include `five_hour`, `seven_day`, `seven_day_opus`, and `extra_usage`. When the OAuth usage response includes a `limits` array, that array is the authoritative, self-describing source and is preferred over the fixed top-level fields: it surfaces every active limit, including ones scoped to a specific model (e.g. Fable) via `scope.model.display_name`, with a `model:<slug>` window id.
- Claude credential-validity and cache-fallback contracts are documented in [README Security Posture](README.md#security-posture). A definitive auth failure (HTTP 401/403, missing/invalid credentials) is only definitive once every credential source has been consulted: while any source is skipped unread it must not retire the cache or report sign-out, because a stale `~/.claude/.credentials.json` alongside a live Keychain credential is the normal macOS shape.
- Codex window identity and cache-validation contracts are documented in [README Provider windows](README.md#provider-windows) and [README Cache](README.md#cache).
- Cursor reads `$CURSOR_STATE_DB` or the local Cursor state database via `sqlite3 -readonly` for `cursorAuth` values and can report `included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit` windows from the first-party dashboard usage endpoint.
- If `sqlite3` is unavailable, Cursor auth is reported as skipped with `sqlite3_unavailable`; do not treat that as permission to install system packages.
- GitHub Copilot reads `$GITHUB_COPILOT_APPS_JSON` or the local `github-copilot/apps.json` auth file and can report quota snapshot windows such as `chat`, `completions`, and `premium_interactions` from GitHub's first-party Copilot user endpoint. If the endpoint only exposes entitlement and no numeric quota windows, return a fresh provider report with `windows: []` rather than inventing percentages.
- Copilot only sends tokens associated with public GitHub hosts to the public endpoint; host-specific GitHub Enterprise tokens are treated as unavailable there.
- Grok reads two independent usability sources: Grok CLI session auth (`$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json`/`~/.grok/auth.json`) and Pi's `$PI_CODING_AGENT_DIR/auth.json` `xai` entry (default `~/.pi/agent/auth.json`, OAuth or literal API key). Treat Grok as usable when either source is locally usable; true sign-out requires every applicable source unavailable or rejected.
- Grok CLI path selects session-scoped auth instead of API-key entries and recognizes OIDC records scoped to `auth.x.ai` with `auth_mode` or `authMode` set to `oidc`.
- Grok consumer quota comes only from the read-only `grok_api_v2.GrokBuildBilling.GetGrokCreditsConfig` operation when a CLI session bearer is available; Pi `xai` alone can establish `authStatus: usable` with unknown/empty consumer windows. Soft CLI/Pi expiry is `authStatus: expired_refreshable`, not `auth_required` logout; `reason: credentials_expired` and the `grok` remedy apply only when Grok CLI auth is refreshable, not Pi-only expiry.
- Grok credential recovery and quota interpretation contracts are documented in [README Provider state](README.md#provider-state), [README Provider windows](README.md#provider-windows), and [README Security Posture](README.md#security-posture).
- Grok cache fallback accepts only current `web` source snapshots, not legacy `api` billing-proxy entries. Never send cookies, launch Grok or Pi, refresh credentials, or retain raw responses.
- Codex OAuth credential availability is access-token authoritative: expired `id_token` alone must not mark `auth-json` expired or skip the bearer quota probe.
- Kimi's credential, fallback, and transport contracts are documented in [README Security Posture](README.md#security-posture). Pi's `kimi-coding` entry is read in place as either an `api_key` or an unexpired `oauth` access token; an expired OAuth record resolves as `expired` (falling through to the Kimi Code CLI source) and is never refreshed, mirroring `src/providers/pi-xai-credential.ts`.
- Provider adapter behavior (retry-after handling, snake/camel field tolerance, window parsing) is an original, clean-room implementation derived only from the vendors' own OAuth/HTTP behavior; quota-axi carries no vendored or attributed third-party adapter code.
- Slow-path CLI plumbing (routing, `--help`, trailing version flags, error framing, exit codes, and the built-in `update` self-updater) comes from `axi-sdk-js` `runAxiCli`, matching sibling tasks-axi; machine TOON/JSON rendering stays in `src/render.ts` and the command bodies live in `src/commands.ts`.
- `bin/quota-axi.ts` answers a bare `-v`/`-V`/`--version` through `axi-sdk-js/fast-path` plus the leaf `src/version.ts` (node builtins only), and imports `src/cli.js` dynamically so the provider graph never loads on that path. Keep `src/version.ts` leaf-clean; `test/version-fast-path.test.ts` guards this with an ESM loader module trace (plus negative control) and flag parity, deliberately with no wall-clock CI assertion.
- `quota` is the implicit default command: `runAxiCli` routes on `argv[0]` and rejects a leading flag, so `src/cli.ts` `normalizeArgv` prepends `quota` for a bare call or flag-first call (`quota-axi --json`) while leaving `auth`, `update`, single-token `--help`, and any version flag that reaches the slow path to the SDK. Validation errors throw `AxiError("...", "VALIDATION_ERROR")` (exit 2); the all-providers-failed path sets `process.exitCode = 1` and still renders.
- Default stdout is compact TOON.
- `--json` emits the normalized model, and `--full` is required before account identity or per-source attempts are shown.
- `--tui` (quota command only, mutually exclusive with `--json`) renders the human card-grid report from the pure renderer in `src/tui.ts`, driven on an interactive terminal by the injected-io live loop in `src/tui-live.ts` (`--refresh`, `--once`, `q`/Ctrl+C to quit); it is presentation only, documented in [README Human terminal report](README.md#human-terminal-report---tui), and must never change the TOON/JSON machine contract, exit codes, or caching.
- TUI wording is humanized independently of the machine contract: `through_reset` renders as `on pace ✓`, pace is shown only by the bar fill and `┃` marker (no burn-multiple chip or legend), and projected exhaustion is a relative `empty in Nd Nh` headline countdown (no triangle prefix, warning styling retained) with no absolute-time body note. JSON and TOON keep `through_reset` and the full `pace` object. The headline bar uses the binding window's own label from `limitingWindowIds` (`week`/`session`/`credits`) as its primary label; scoped rollups may append their model or product scope. See [README Human terminal report](README.md#human-terminal-report---tui).
- JSON report shape and quota interpretation, including stale effective availability, per-window cycle-average pace, and effective usable runway (`schemaVersion: 3`), are documented in [README Output Model](README.md#output-model), [README Pace signals](README.md#pace-signals), and [README Effective usable runway](README.md#effective-usable-runway). Pace and runway are derived in `src/pace.ts` from trusted `startsAt`/`resetsAt` or `windowSeconds` plus `generatedAt`; runway aggregates every authoritative bound, preserves uncertainty, and is not cached. Negative `reservePercentPoints` means usage is ahead of the reset clock. `state.retryAfter` can appear for provider rate limits, and `state.reason: keychain_access_required` plus `state.remedyCommand` can appear when a stale or unavailable Claude result is blocked by a skipped macOS Keychain prompt.
- macOS Claude Keychain presence and value reads mirror Claude Code's validated current-user account selector and never fall back to an ambiguous service-only query. Value reads are skipped on plain calls until a successful value read records the profile-and-account-scoped non-secret access marker under the quota-axi cache directory; after that, plain calls may reuse the existing grant and read live Claude quota.
- Managed-profile, Claude identity, and Codex executable-override contracts are documented in [README Security Posture](README.md#security-posture).
- `--allow-keychain-prompt` is the first-time opt-in that permits the Claude Keychain value read which can prompt, and agents should relay the one-time "Always Allow" grant when `keychain_access_required` advice appears.
- Codex uses `$CODEX_HOME/auth.json` or `~/.codex/auth.json` OAuth before the CLI fallback.
- Codex `auth.json` support is OAuth-token only; never treat `OPENAI_API_KEY` as valid quota auth or send API keys to ChatGPT quota endpoints.
- Never launch the Claude CLI to probe quota, because that would spend the quota being measured.
- The read-only Codex app-server JSON-RPC probe is the only CLI fallback.
- The cache path is `~/.cache/quota-axi/quotas.json`, or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.
- The Claude Keychain access marker is stored alongside the cache, is `0600`, is keyed by hashed profile/account identity, and contains no credential material or raw account name. Legacy service-only markers are ignored without being deleted.
- Quota cache files must be `0600` and contain only normalized non-secret snapshots.
- Only fresh provider snapshots with windows are cached; fresh provider reports with no windows clear any existing cached snapshot for that provider.
- Failed providers, stale providers, account identity, source attempts, and derived `pace` objects are not cached.
- Do not cache raw provider responses or credential headers.

## Development

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build:skill -- --check
```

## Release process

Releases are cut by release-please from conventional commit messages on `main`; merging the bot's release PR triggers `npm publish` via `.github/workflows/release-please.yml`, using npm's OIDC trusted-publisher flow (`id-token: write` + `--provenance`), not an `NPM_TOKEN` secret.
`.release-please-manifest.json` is primed at `0.1.0`, the version already published to npm by hand before release-please was wired up; release-please owns every version after that.
`release-please-config.json` intentionally sets `bootstrap-sha` to `9f5dc949c50ab8ac0a441be777e1c3693ee0b612`, the commit that produced the already-published npm `0.1.0`; do not retarget it to later scaffolding commits unless the published baseline itself is being corrected.
Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json` (a guard workflow blocks PRs that touch them), and regenerate `skills/quota-axi/SKILL.md` with `pnpm run build:skill` instead of editing it directly (`pnpm run build:skill -- --check` in CI fails if it drifts from `src/skill.ts`).
Every `pull_request` workflow must `paths-ignore` the release-please output set (`.release-please-manifest.json`, `CHANGELOG.md`, `package.json`) so release PRs create zero runs; `test/release-ci-exclusions.test.ts` derives that set from `release-please-config.json` and fails if a workflow drifts.

## Lockfile formatting

The committed `pnpm-lock.yaml` is Prettier-formatted, which is not pnpm's native output format.
After changing dependencies, run `pnpm exec prettier --write pnpm-lock.yaml` so the diff collapses to the real change instead of a wholesale reformat; CI's `pnpm install --frozen-lockfile` parses the YAML structurally and accepts this formatting.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
