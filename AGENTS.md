# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

Provider windows, credentials, cache identity, output tiers, and the TUI are owned by [README.md](README.md). Follow the section named below instead of restating it here.

- [VISION.md](VISION.md) is the acceptance policy and sits ahead of what ships. Accuracy of the reported number comes first. [README Security Posture](README.md#security-posture) is what ships today; do not restate VISION.md wording as a current guarantee.
- quota-axi is data only. It reports the local providers named in the README, including Muse, and must never route, recommend, rank a winner, order providers preferentially, proxy, intercept, log in, import browser cookies, or mint or rotate a credential. The per-scope `selection` signal is data for the consumer. The generated skill stays a stub that defers to the CLI ([README Agent Skill](README.md#agent-skill)).
- Never exchange a refresh token, and never retain, log, render, cache, or send its value. Delegated refresh checks presence only. Pi brokers may read a stored refresh value only to classify it as a usable literal, then discard it. See [README Safety guarantees](README.md#safety-guarantees) and [README Delegated credential refresh](README.md#delegated-credential-refresh).
- A delegate runs only when the same stored access token is expired, carries a refresh token, and was definitively rejected, and only through `src/providers/delegated-refresh.ts`. quota-axi never signals that child. A run that outruns the wait is unmeasured or stale, never a sign-out, and never retires the cache. Leaving a provider read-only is always allowed.
- Never read a secret in order to decide cache silence, and never log or render a credential. Cache files are `0600` and hold only normalized non-secret snapshots. Do not cache raw provider responses or credential headers ([README Cache](README.md#cache)).
- Do not invent a quota figure, window, reset, percentage, or cycle the vendor did not supply. Do not treat an inherited bound as exhaustion without the evidence in [README Quota windows](README.md#quota-windows). A `shareOf` window never yields a remaining. Demote fields only in the renderer.
- New credential sources follow the checklist in [README Provider `state`](README.md#provider-state). New remote fetches go through `src/lib/http.ts`. New process-table reads go through `currentUserProcessListArgs`. Context-scoped cache identity goes through `CONTEXT_SCOPED_PROVIDERS`.
- Codex stale cache reuse requires a stored account stamp matching a credential identity the current read actually tried; see [README Cache](README.md#cache).
- `--profile-only` is fail-closed for one Claude or Codex credential file and bypasses other sources, delegated refresh, and the cache ([README Profile-only quota reads](README.md#profile-only-quota-reads)). Omitting it keeps ordinary discovery.
- `--allow-keychain-prompt` is the one-time opt-in for a secure-store value read that can prompt. Relay "Always Allow" when `keychain_access_required` appears. A missing `sqlite3` is `sqlite3_unavailable`; do not install system packages.
- Provider tests use synthetic stores and mocked Keychain, process, and HTTP boundaries. Never use a live credential, the real `security` binary, a real refresh, or a provider API. Pass `refreshCredentials: false` unless the test is about delegation.
- Muse (`muse`) is a default unscoped provider and stays read-only. Its only quota read is the Muse CLI's own startup request, `POST /muse-code/key`, whose response also carries the account's Model API key; parse through a key-allowlist reviver so the key never reaches an object. A live 1.4.0 Power Usage mint body may omit `subs_usage`; that is an empty reading, not a missing allowlist key. Do not expand the allowlist without live usage key paths. On macOS the token lives in the login Keychain item `ai.meta.dev.credentials` / `meta`, gated by `--allow-keychain-prompt` like the Cursor CLI source (`src/providers/muse-keychain-credential.ts`). `auth` passes `presenceOnly: !allowKeychainPrompt` so a leftover grant marker never fetches the bundle. A skipped present Keychain source is never a sign-out, even when a later sibling is rejected: report the blocked read and preserve the cache. An unreadable or malformed Muse auth file with no working fallback is an operational failure, not `auth_required`. `src/providers/muse-read-gate.ts` bounds requests to one per credential per `MUSE_KEY_READ_INTERVAL_MS` via a `0600` ledger of opaque context digests: check and `pending` claim are one locked step, and a request does not leave without that recorded claim. Inside the interval replay and send nothing. A successful empty reading records a non-secret empty-quota marker on that ledger so interval replay returns the same observation; a cache miss after a windowed quota outcome is not turned into an empty reading. Muse is excluded from `--max-age` / `QUOTA_AXI_MAX_AGE` fresh reuse, because a macOS Keychain login switch does not change a traced file; the five-minute ledger remains the bound on vendor calls. Muse snapshots are context-scoped (answering source plus a one-way digest of the credential that answered) through `CONTEXT_SCOPED_PROVIDERS`. Do not loosen the gate or add a delegate without fresh empirical evidence of the endpoint's rotation behavior. Contract in [README Provider notes](README.md#provider-notes).

## Development

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build:skill -- --check
```

After a dependency change, run `pnpm exec prettier --write pnpm-lock.yaml`. Do not hand-edit `skills/quota-axi/SKILL.md`, `CHANGELOG.md`, or `.release-please-manifest.json`.

## Release and the contribution gate

[CONTRIBUTING.md](CONTRIBUTING.md) owns the contributor workflow, release-please, OIDC publish, generated-file, `paths-ignore`, and no-mistakes pin rules. Do not retarget `bootstrap-sha` unless the published baseline itself is being corrected.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
