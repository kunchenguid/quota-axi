# Codex Home Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add opt-in independent Codex quota lanes for absolute homes listed by `QUOTA_AXI_CODEX_HOMES`.

**Architecture:** Keep the current native `codex-home` path unchanged when the variable is unset. When set, validate and parse the list, then create one read-only `ProviderAccount` per listed home using a Codex credential broker bound to that home; the existing account collector publishes each lane independently.

**Tech Stack:** TypeScript, Vitest, pnpm, existing Codex broker/account collector.

**Spec:** `docs/superpowers/specs/2026-11-14-codex-homes-design.md`

## Global Constraints

- Absolute paths only; platform path delimiter; empty entries ignored.
- Never print, cache, or expose tokens.
- Listed lanes cannot delegate refresh and cannot use the selected process credential.
- Unset variable preserves current output and cache behavior.
- Do not touch `CHANGELOG.md`, generated skill output, Pi discovery, or `--profile-only`.

## Review Focus

- One listed home fails while another succeeds: both rows remain visible.
- Duplicate or selected-home entries: no duplicate lane or credential cross-read.
- Relative entry: deterministic `VALIDATION_ERROR` before provider I/O.
- Listed home with no credential: its own unavailable/auth state is retained.
- Cache identity: one home cannot reuse another home's snapshot.

---

### Task 1: Parse and validate Codex home list

**Files:**

- Create or modify: `src/lib/codex-home.ts`
- Test: `test/providers/codex-homes.test.ts`
- Modify: `src/commands.ts`, `src/cli.ts`

- [ ] Write failing tests for unset/blank parsing, delimiter-separated absolute entries, ignored empties, and relative-entry validation.
- [ ] Run the focused test and verify it fails because the env parser and validation do not exist.
- [ ] Implement `CODEX_HOMES_ENV`, `codexListedHomes`, and command validation matching Claude's list semantics.
- [ ] Run the focused parser/CLI tests and verify they pass.
- [ ] Commit the parser and validation changes.

### Task 2: Add isolated Codex home lanes

**Files:**

- Modify: `src/providers/pi-codex-credential.ts`
- Modify: `src/providers/codex.ts`
- Test: `test/providers/codex-homes.test.ts`

- [ ] Write failing behavioral tests using synthetic `auth.json` files and mocked HTTP for two homes, including distinct account identities and one failing home.
- [ ] Run the focused tests and verify the expected missing-lane failure.
- [ ] Add broker environment binding and Codex lane discovery with opaque home keys and `codex-home` locators.
- [ ] Make listed lanes read-only and keep the selected native lane's existing behavior.
- [ ] Run the focused tests and verify each home uses only its own bearer and failures do not suppress siblings.
- [ ] Add tests for duplicates, empty homes, and cache separation; run them green.
- [ ] Commit the provider implementation and tests.

### Task 3: Document and validate the user-facing option

**Files:**

- Modify: `README.md`, `src/cli.ts`
- Test: `test/cli.test.ts`, `test/providers/codex-homes.test.ts`

- [ ] Add help and README examples using neutral paths such as `/home/me/.codex-work`, plus full-output lane semantics.
- [ ] Run focused help/output tests and verify they fail before documentation wiring.
- [ ] Wire the exact help text and assertions without changing schema or TUI behavior.
- [ ] Run `pnpm run build`, `pnpm run lint`, `pnpm run format:check`, `pnpm test`, and `pnpm run build:skill -- --check`.
- [ ] Commit documentation and final tests.
