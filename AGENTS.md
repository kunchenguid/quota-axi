# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- quota-axi is data only.
- It reports local Claude, Codex, Cursor, GitHub Copilot, Grok, and Antigravity (`agy`) quota windows, and it must never route, recommend, proxy, intercept, log in, import browser cookies, or mutate provider state.
- Claude quota windows can include `five_hour`, `seven_day`, `seven_day_opus`, and `extra_usage`. When the OAuth usage response includes a `limits` array, that array is the authoritative, self-describing source and is preferred over the fixed top-level fields: it surfaces every active limit, including ones scoped to a specific model (e.g. Fable) via `scope.model.display_name`, with a `model:<slug>` window id.
- Codex quota windows can include `five_hour` and `weekly`, plus optional credit balance data. Codex responses can also carry extra limits scoped to a specific model or feature (HTTP: `additional_rate_limits`; app-server RPC: `rateLimitsByLimitId`), surfaced as `model:<id>:5h` / `model:<id>:7d` windows.
- Cursor reads `$CURSOR_STATE_DB` or the local Cursor state database via `sqlite3 -readonly` for `cursorAuth` values and can report `included_usage`, `auto_usage`, `api_usage`, and optional `spend_limit` windows from the first-party dashboard usage endpoint.
- If `sqlite3` is unavailable, Cursor auth is reported as skipped with `sqlite3_unavailable`; do not treat that as permission to install system packages.
- GitHub Copilot reads `$GITHUB_COPILOT_APPS_JSON` or the local `github-copilot/apps.json` auth file and can report quota snapshot windows such as `chat`, `completions`, and `premium_interactions` from GitHub's first-party Copilot user endpoint. If the endpoint only exposes entitlement and no numeric quota windows, return a fresh provider report with `windows: []` rather than inventing percentages.
- Copilot only sends tokens associated with public GitHub hosts to the public endpoint; host-specific GitHub Enterprise tokens are treated as unavailable there.
- Grok reads `$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json`/`~/.grok/auth.json`, selects session-scoped auth instead of API-key entries, recognizes OIDC records scoped to `auth.x.ai` with `auth_mode` or `authMode` set to `oidc`, and can report `credits`, optional `on_demand`, and optional `product:<slug>` windows from the first-party billing endpoint.
  When billing exposes only a current period and prepaid balance, Grok reports a reset-only `credits` window without inventing usage percentages.
- Grok may read `$GROK_HOME/version.json` or package metadata near a local `grok` executable to send `x-grok-client-version`, but it must not launch the Grok CLI.
- Antigravity (`agy`) discovers already-running Antigravity/`agy` processes via `ps` plus listening ports via `lsof`, then reads only 127.0.0.1 loopback quota endpoints. It prefers `RetrieveUserQuotaSummary`, may use `GetUserStatus` / `GetCommandModelConfigs` as read-only fallbacks, reports `gemini_5h`, `gemini_weekly`, `claude_gpt_5h`, and `claude_gpt_weekly` when grouped summary exists, and must never launch or restart Antigravity/`agy`.
- Provider adapter behavior (retry-after handling, snake/camel field tolerance, window parsing) is an original, clean-room implementation derived only from the vendors' own OAuth/HTTP behavior; quota-axi carries no vendored or attributed third-party adapter code.
- Default stdout is compact TOON.
- `--json` emits the normalized model, and `--full` is required before account identity or per-source attempts are shown.
- JSON provider reports include `provider`, `label`, `source`, `windows`, and `state`; `state.retryAfter` can appear for provider rate limits, and `state.reason: keychain_access_required` plus `state.remedyCommand` can appear when a stale or unavailable Claude result is blocked by a skipped macOS Keychain prompt.
- macOS Claude Keychain value reads are skipped on plain calls until a successful value read records the non-secret access marker under the quota-axi cache directory; after that, plain calls may reuse the existing grant and read live Claude quota.
- `--allow-keychain-prompt` is the first-time opt-in that permits the Claude Keychain value read which can prompt, and agents should relay the one-time "Always Allow" grant when `keychain_access_required` advice appears.
- Codex uses `$CODEX_HOME/auth.json` or `~/.codex/auth.json` OAuth before the CLI fallback.
- Codex `auth.json` support is OAuth-token only; never treat `OPENAI_API_KEY` as valid quota auth or send API keys to ChatGPT quota endpoints.
- Never launch the Claude CLI to probe quota, because that would spend the quota being measured.
- The read-only Codex app-server JSON-RPC probe is the only CLI fallback.
- The cache path is `~/.cache/quota-axi/quotas.json`, or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.
- The Claude Keychain access marker is stored alongside the cache, is `0600`, and contains no credential material.
- Quota cache files must be `0600` and contain only normalized non-secret snapshots.
- Only fresh provider snapshots with windows are cached; fresh provider reports with no windows clear any existing cached snapshot for that provider.
- Failed providers, stale providers, account identity, and source attempts are not cached.
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

## Lockfile formatting

The committed `pnpm-lock.yaml` is Prettier-formatted, which is not pnpm's native output format.
After changing dependencies, run `pnpm exec prettier --write pnpm-lock.yaml` so the diff collapses to the real change instead of a wholesale reformat; CI's `pnpm install --frozen-lockfile` parses the YAML structurally and accepts this formatting.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
