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

### `auth --json` shape

| Object               | Fields                                                    |
| -------------------- | --------------------------------------------------------- |
| Auth report          | `generatedAt`, `schemaVersion: 1`, and `auth`             |
| Provider auth report | `provider` and `sources`                                  |
| Auth source entry    | `source`, optional `path`, `status`, and optional `error` |

Auth source entries can include `credentialPresent` when a non-secret probe confirms a credential item exists.

| Name                 | Values                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Auth source statuses | `available`, `missing`, `invalid`, `expired`, or `skipped`                                   |
| Auth source names    | `oauth-file`, `keychain`, `auth-json`, `auth-env`, `apps-json`, `state-vscdb`, and `cli-rpc` |

## Security Posture

### Provider credential sources

| Provider       | Credential sources read                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude         | `~/.claude/.credentials.json`; on macOS, the `Claude Code-credentials` Keychain value with `--allow-keychain-prompt` or, after a non-secret access marker exists, on plain calls |
| Codex          | `$CODEX_HOME/auth.json` or `~/.codex/auth.json` before the read-only CLI fallback                                                                                                |
| Cursor         | `$CURSOR_STATE_DB` when set or the platform Cursor state database path                                                                                                           |
| GitHub Copilot | `$GITHUB_COPILOT_APPS_JSON` when set or the local Copilot apps auth file                                                                                                         |
| Grok           | `$GROK_AUTH_JSON`, inline `$GROK_AUTH`, `$GROK_AUTH_PATH`, or `$GROK_HOME/auth.json` / `~/.grok/auth.json`                                                                       |

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

### Safety guarantees

- Direct HTTP requests go only to first-party provider usage, quota, billing, or entitlement endpoints with the user's local credentials.
- It sends credential values only to the first-party provider request they authenticate.
- It never prints, logs, or caches credential values.
- It never launches the Claude CLI, so it cannot accidentally spend the quota it measures.

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
