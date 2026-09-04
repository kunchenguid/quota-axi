---
name: dev-local
description: Prepare quota-axi dependencies and safe local CLI validation.
user_invocable: true
---

# /dev-local — prepare the local development environment

quota-axi is a TypeScript ESM CLI. It has no application server, database, or
required background service. Provider quota reads use the local credentials and
first-party endpoints already owned by the installed agent tools; those are
not needed for the test suite.

## Requirements

- Node.js `>=22.19` (the version required by `package.json`)
- pnpm `11.1.1` (the repository package manager)
- git

Use the repository's existing package-manager installation or Corepack setup;
do not change lockfiles or install system packages as part of verification.

## Setup

From the repository root:

```bash
test "$(git rev-parse --show-toplevel)" = "$PWD"
pnpm install --frozen-lockfile
pnpm run build
```

No `.env` file or API key is required for development and tests. Keep real
provider credentials out of logs and fixtures. For a safe local quota smoke
check, select a provider explicitly and disable delegated refresh:

```bash
node dist/bin/quota-axi.js \
  --provider agy --no-credential-refresh --json
```

This may return exit status 1 when Antigravity is not running; that is an
expected unavailable-provider report, not a setup failure. Never use
`--allow-keychain-prompt` in automated verification.

## Development loop

Use `/verify` for the complete proof. The underlying commands are:

```bash
pnpm test
pnpm run lint
pnpm run format:check
pnpm run build:skill -- --check
```

The existing `.airlock/lint.sh` is also a maintained install/build/test
launcher. CI is defined in `.github/workflows/ci.yml` and adds lint, format,
and generated-skill validation. There is no local service lifecycle to start
or stop.
