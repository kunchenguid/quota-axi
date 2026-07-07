# quota-axi v1 end-to-end CLI transcript

These are fixture-backed runs of the built CLI (`node dist/bin/quota-axi.js`) on macOS, captured 2026-07-07.
The commands used hermetic homes, throwaway caches, and stubbed provider responses so no personal account metadata is recorded.
All plan names, quota percentages, reset times, auth availability states, credit balances, emails, and account ids below are representative fake values.

## 1. Help and version

```console
$ quota-axi --help
usage: quota-axi [auth] [flags]
commands[2]:
  (none)=quota, auth
flags[6]:
  --provider <claude,codex>, --json, --full, --allow-keychain-prompt, --help, -v/--version
examples:
  quota-axi
  quota-axi --provider claude
  quota-axi --json
  quota-axi --full
  quota-axi auth
$ echo $?
0

$ quota-axi --version
quota-axi 0.1.0
```

## 2. Default quota report (compact TOON, fixture credentials)

The Claude fixture contains an expired OAuth token and the Keychain copy is skipped by default.
The Codex fixture returns a fresh synthetic quota response.
Partial success still exits 0.

```console
$ HOME=$HARNESS/home CODEX_HOME=$HARNESS/home/.codex XDG_CACHE_HOME=$HARNESS/cache quota-axi
bin: ~/.no-mistakes/worktrees/.../dist/bin/quota-axi.js
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2035-01-15T12:00:00.000Z"
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,unknown,unavailable,auth_required,none
  codex,fixture-pro,oauth,fresh,"2035-01-15T12:00:00.000Z"
windows[2]{provider,id,label,percentRemaining,resetsAt,state}:
  codex,five_hour,session,42,"2035-01-15T17:00:00.000Z",fresh
  codex,weekly,week,88,"2035-01-22T12:00:00.000Z",fresh
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
$ echo $?
0
```

The fixture run completed in 0.49s wall clock.

## 3. `auth` subcommand (source availability, no secret values)

```console
$ HOME=$HARNESS/home CODEX_HOME=$HARNESS/home/.codex XDG_CACHE_HOME=$HARNESS/cache quota-axi auth
bin: ~/.no-mistakes/worktrees/.../dist/bin/quota-axi.js
description: Inspect local quota auth sources without printing secret values
auth[4]{provider,source,path,status,error}:
  claude,oauth-file,~/.claude/.credentials.json,expired,none
  claude,keychain,none,skipped,keychain_prompt_required
  codex,auth-json,~/.codex/auth.json,available,none
  codex,cli-rpc,none,missing,none
help[1]:
  Run `quota-axi --allow-keychain-prompt auth` to permit macOS Keychain access
$ echo $?
0
```

The synthetic `expired` status comes from a fixture `expiresAt` value of `2035-01-01T00:00:00.000Z` evaluated against the fixed harness clock.
No Keychain prompt appeared because `--allow-keychain-prompt` was not passed.

## 4. `--json` (normalized model, identity omitted by default)

Note: no `account` and no `attempts` fields appear without `--full`.

```console
$ HOME=$HARNESS/home CODEX_HOME=$HARNESS/home/.codex XDG_CACHE_HOME=$HARNESS/cache quota-axi --json
{
  "generatedAt": "2035-01-15T12:00:10.000Z",
  "schemaVersion": 1,
  "providers": [
    {
      "provider": "claude",
      "label": "Claude",
      "source": "unavailable",
      "windows": [],
      "state": {
        "status": "auth_required",
        "stale": false,
        "error": "Claude sign-in required",
        "sourcesTried": ["oauth-file", "keychain"]
      }
    },
    {
      "provider": "codex",
      "label": "Codex",
      "source": "oauth",
      "plan": "fixture-pro",
      "windows": [
        {
          "id": "five_hour",
          "label": "session",
          "kind": "session",
          "percentUsed": 58,
          "resetsAt": "2035-01-15T17:00:00.000Z",
          "windowSeconds": 18000,
          "percentRemaining": 42
        },
        {
          "id": "weekly",
          "label": "week",
          "kind": "weekly",
          "percentUsed": 12,
          "resetsAt": "2035-01-22T12:00:00.000Z",
          "windowSeconds": 604800,
          "percentRemaining": 88
        }
      ],
      "credits": { "remaining": 1234, "unlimited": false, "unit": "credits" },
      "state": {
        "status": "fresh",
        "stale": false,
        "refreshedAt": "2035-01-15T12:00:10.000Z",
        "sourcesTried": ["oauth"]
      }
    }
  ]
}
$ echo $?
0
```

## 5. `--full` (fake accounts and per-source attempts appear)

The email and account id below are fixture placeholders, not personal values.

```console
$ HOME=$HARNESS/home CODEX_HOME=$HARNESS/home/.codex XDG_CACHE_HOME=$HARNESS/cache quota-axi --full
bin: ~/.no-mistakes/worktrees/.../dist/bin/quota-axi.js
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2035-01-15T12:00:20.000Z"
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,unknown,unavailable,auth_required,none
  codex,fixture-pro,oauth,fresh,"2035-01-15T12:00:20.000Z"
windows[2]{provider,id,label,percentRemaining,resetsAt,state}:
  codex,five_hour,session,42,"2035-01-15T17:00:00.000Z",fresh
  codex,weekly,week,88,"2035-01-22T12:00:00.000Z",fresh
accounts[2]{provider,email,organization,accountId}:
  claude,hidden,none,none
  codex,fixture-user@example.test,none,acct_fixture_123
attempts[3]{provider,source,status,error}:
  claude,oauth-file,skipped,credentials_expired
  claude,keychain,skipped,keychain_prompt_required
  codex,oauth,success,none
help[3]:
  Run `quota-axi --provider claude --json` for JSON output
  Run `quota-axi --full` to include account and source-attempt details
  Run `quota-axi auth` to inspect local auth source availability without printing secrets
$ echo $?
0
```

## 6. Cache file guarantees

Only the fresh provider snapshot is cached, permissions are `0600` in a `0700` directory, no account identity is persisted, and a scan for credential-like strings finds nothing.

```console
$ ls -l "$XDG_CACHE_HOME/quota-axi/quotas.json"
-rw-------@ ... quotas.json
$ stat -f "%Lp" "$XDG_CACHE_HOME/quota-axi"
700
$ grep -ciE 'accessToken|access_token|authorization|bearer|sk-|eyJ' "$XDG_CACHE_HOME/quota-axi/quotas.json"
0
$ cat "$XDG_CACHE_HOME/quota-axi/quotas.json"
{
  "generatedAt": "2035-01-15T12:00:20.000Z",
  "schemaVersion": 1,
  "providers": [
    {
      "provider": "codex",
      "label": "Codex",
      "source": "oauth",
      "windows": [
        { "id": "five_hour", "label": "session", "kind": "session", "percentUsed": 58, "percentRemaining": 42, "resetsAt": "2035-01-15T17:00:00.000Z", "windowSeconds": 18000 },
        { "id": "weekly", "label": "week", "kind": "weekly", "percentUsed": 12, "percentRemaining": 88, "resetsAt": "2035-01-22T12:00:00.000Z", "windowSeconds": 604800 }
      ],
      "state": { "status": "fresh", "stale": false, "sourcesTried": ["oauth"], "refreshedAt": "2035-01-15T12:00:20.000Z" },
      "plan": "fixture-pro",
      "credits": { "remaining": 1234, "unlimited": false, "unit": "credits" }
    }
  ]
}
```

## 7. Stale-cache fallback

The same fixture cache is reused with an empty `$HOME`, `CODEX_HOME` pointing at a nonexistent directory, and a `PATH` without the codex binary.
Codex falls back to the cached snapshot marked `stale`, and the process still exits 0.

```console
$ HOME=/tmp/fake-home CODEX_HOME=/tmp/fake-home/.codex PATH=/usr/bin:/bin quota-axi
...
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,unknown,unavailable,auth_required,none
  codex,fixture-pro,cache,stale,"2035-01-15T12:00:20.000Z"
windows[2]{provider,id,label,percentRemaining,resetsAt,state}:
  codex,five_hour,session,42,"2035-01-15T17:00:00.000Z",stale
  codex,weekly,week,88,"2035-01-22T12:00:00.000Z",stale
...
$ echo $?
0
```

## 8. Exit codes: all providers failed, and usage errors

```console
$ HOME=/tmp/fake-home CODEX_HOME=/tmp/fake-home/.codex PATH=/usr/bin:/bin XDG_CACHE_HOME=/tmp/fake-home/empty-cache quota-axi
...
providers[2]{provider,plan,source,status,refreshedAt}:
  claude,unknown,unavailable,auth_required,none
  codex,unknown,unavailable,error,none
windows[0]:
...
$ echo $?
1

$ quota-axi --bogus-flag
error: "unknown argument: --bogus-flag"
code: usage
help[1]:
  Run `quota-axi --help` for supported commands and flags
$ echo $?
2
```

## 9. Claude fresh path (hermetic, fixture credential, stubbed network)

This run drives the built `dist/src/cli.js` with a fixture credential file in a fake `$HOME` and a stubbed `fetch` returning the repository's `test/fixtures/claude/oauth.json` payload.
Credential file discovery, expiry validation, normalization, TOON rendering, and cache writing still exercise the shipped code.

```console
$ HOME=$HARNESS/home XDG_CACHE_HOME=$HARNESS/cache node run.mjs   # calls main(["--provider","claude"])
bin: quota-axi
description: Report local agent-provider quota windows for routing-aware agents
generatedAt: "2035-01-15T12:00:30.000Z"
providers[1]{provider,plan,source,status,refreshedAt}:
  claude,fixture-max,oauth,fresh,"2035-01-15T12:00:30.000Z"
windows[4]{provider,id,label,percentRemaining,resetsAt,state}:
  claude,five_hour,session,82,"2035-01-15T17:00:00.000Z",fresh
  claude,seven_day,week,64,"2035-01-22T12:00:00.000Z",fresh
  claude,seven_day_opus,opus week,93,"2035-01-23T09:30:00.000Z",fresh
  claude,extra_usage,extra usage,75,unknown,fresh
help[3]:
  ...
$ echo $?
0
```

## 10. npx install of the packed tarball (README Quick Start shape)

```console
$ npm pack
quota-axi-0.1.0.tgz
$ npx -y -p ./quota-axi-0.1.0.tgz quota-axi --version
quota-axi 0.1.0
$ HOME=$HARNESS/home CODEX_HOME=$HARNESS/home/.codex XDG_CACHE_HOME=$HARNESS/cache npx -y -p ./quota-axi-0.1.0.tgz quota-axi auth
bin: ~/.npm/_npx/fixture/node_modules/.bin/quota-axi
description: Inspect local quota auth sources without printing secret values
auth[4]{provider,source,path,status,error}:
  claude,oauth-file,~/.claude/.credentials.json,expired,none
  claude,keychain,none,skipped,keychain_prompt_required
  codex,auth-json,~/.codex/auth.json,available,none
  codex,cli-rpc,none,missing,none
help[1]:
  Run `quota-axi --allow-keychain-prompt auth` to permit macOS Keychain access
$ echo $?
0
```

## Not exercised

`--allow-keychain-prompt` was deliberately not run because this validation session is unattended and the flag can pop a macOS GUI Keychain prompt.
Its skip/timeout/denied handling is covered by unit tests (`test/providers/claude-auth.test.ts`) and the default-skip behavior is visible in sections 2, 3, and 5 above.
The codex `cli-rpc` fallback path is represented in the fixture auth output, and its JSON-RPC merge logic is covered by `test/providers/codex.test.ts`.
