---
name: verify
description: Prove quota-axi through its real build, tests, and CLI runtime.
user_invocable: true
---

# /verify — prove the change before the PR

Run this from the repository root on a feature branch. This is the proof layer
ahead of the existing no-mistakes review and CI gates; it does not replace
them. Keep all logs and temporary proof under the gitignored `evidence/`
directory. Never record credentials, tokens, or raw provider responses.

## Preconditions

Confirm the checkout and branch before running validation:

```bash
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
test "$repo" = "$PWD"
branch="$(git branch --show-current)"
test "$branch" != main
test "$branch" != master
mkdir -p evidence
git check-ignore -q evidence/verify.log
```

Use `/dev-local` first when dependencies are not installed. This project has
no required background service for its test or CLI smoke checks.

## 1. Run the complete maintained gate locally

Run the same substantive checks maintained by `package.json` and CI, saving
their output as proof. `pnpm test` includes a build before running Vitest.

```bash
set -o pipefail
{
  echo '=== pnpm install --frozen-lockfile ==='
  pnpm install --frozen-lockfile
  echo '=== pnpm test ==='
  pnpm test
  echo '=== pnpm run lint ==='
  pnpm run lint
  echo '=== pnpm run format:check ==='
  pnpm run format:check
  echo '=== pnpm run build:skill -- --check ==='
  pnpm run build:skill -- --check
} 2>&1 | tee evidence/verify.log
```

Do not turn a failed check into a pass by skipping it or weakening an
assertion. Fix task-caused failures, then run `/verify` again.

## 2. Exercise the real built CLI

The runtime check must use the compiled entry point, not a mocked provider or
test helper. This probe is deliberately read-only: `agy` uses its local
loopback/process discovery path, and `--no-credential-refresh` prevents any
vendor CLI delegation. The provider may be unavailable; a quota report with
exit status 1 is still valid when its JSON is well formed.

```bash
set -euo pipefail
node dist/bin/quota-axi.js --version | tee evidence/verify-version.log
node dist/bin/quota-axi.js --help > evidence/verify-help.log

set +e
node dist/bin/quota-axi.js \
  --provider agy --no-credential-refresh --json \
  > evidence/verify-runtime.json 2> evidence/verify-runtime.stderr
exit_code=$?
set -e
test "$exit_code" -eq 0 -o "$exit_code" -eq 1

node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync("evidence/verify-runtime.json", "utf8"));
  if (report.schemaVersion !== 5 || !Array.isArray(report.providers)) process.exit(1);
'
```

The runtime output must parse as the published normalized JSON shape. Inspect
`evidence/verify-runtime.stderr` if the probe fails; it must not contain a
credential or raw provider payload.

## Result

Report the exact commands, their pass/fail status, and the evidence paths.
Only claim success when the full suite and the real CLI probe pass. Afterward,
run `/no-mistakes` with the complete task intent; no-mistakes remains
authoritative for review, fixes, push, PR, and CI.
