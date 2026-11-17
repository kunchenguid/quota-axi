# Claude limit reset evidence

This contribution is based on facts supplied in the task about Claude Code
**2.1.326** and claude.ai. They are the implementation's input contract, not an
independently inspected client excerpt or a captured provider response. No Claude
installation, authentication store, real credential, or live account was inspected
to produce this change. The fixtures are synthetic, not redacted live recordings.

## Supplied client contract

The supplied request is the existing
`GET https://api.anthropic.com/api/oauth/usage` with
`cedar_ember=1&skip_spend=1`, using the same OAuth bearer and `anthropic-beta`
construction already present in quota-axi.

The task supplied these field names:

| Object        | Fields                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cedar_ember` | `eligible`, `ineligible_reason`, `at_limit`, `exhausted[]`, `grants[]`, `next_grant_id`, `weekly_resets_at`, `cooldown_until`, `event_props`                                                                                                                                    |
| Each grant    | `id`, `label`, `resets_total`, `resets_left`, `starts_at`, `ends_at`, `clears[]` (`five_hour`, `seven_day`, ...), `paused`, `usable_now`, `use_requires_limit`, `percent_used{}`, `blocking[]`, `type` (`session`, `weekly`, `full`), `gives_back_weekly`, `unavailable_reason` |

The supplied display rule is: `gives_back_weekly: true` gives kind `fable`;
otherwise use `type`; otherwise derive the kind from `clears`. `ends_at` supplies
the displayed expiry date.

The task also supplied a claude.ai example with two available resets: a Fable
reset expiring March 9, 2027 at 08:59 GMT+1 and a Weekly reset expiring December 10
at 23:00 GMT+1. This is an owner-supplied observation, not an observation made by
the contributor or an independent proof of the wire contract.

The supplied redemption route is
`POST /api/organizations/{org}/reset_rate_limits`. It is outside this contribution:
quota-axi does not implement or call it.

## Shape rationale

The existing default-branch Codex provider had no manual-reset field when this
work started. The pending Codex contributions
[available reset count](https://github.com/kunchenguid/quota-axi/pull/379) and
[banked resets](https://github.com/kunchenguid/quota-axi/pull/292) both proposed
`resetsAvailable`, so Claude uses that name too.

The normalized count sums nonnegative integer `resets_left` values. This is an
implementation choice to describe the supplied inventory, not a claim that every
remaining reset can be redeemed immediately. It does not reinterpret `paused`,
`usable_now`, limit requirements or cooldowns as a different count, and it does not
change quota windows or selection signals.

Compact JSON carries the count, including a valid zero. Compact TOON names only a
positive count in an attention row. `--full` adds positive-remaining grant details
with only `kind`, `remaining`, and optional `expiresAt` from `ends_at`. Unknown
types display as `unknown`. Grant identifiers, labels, event properties, and raw
grant payloads are omitted. Inventory is never cached.

Reports containing normalized inventory use quota schema 7 (single account) or 8
(account-expanded), including zero inventory. Missing, ineligible, and malformed
blocks retain schemas 5/6 and the previous output bytes. Compact and full JSON
agree; auth/models/cache versions and TOON format are unchanged by that version
decision. The [README schema contract](../README.md#normalized-schema-contract)
defines the complete mapping.

## Synthetic validation

The six fixtures cover [two grants](../test/fixtures/claude/resets-two-grants.json),
[empty inventory](../test/fixtures/claude/resets-empty.json),
[ineligibility](../test/fixtures/claude/resets-ineligible.json),
[missing data](../test/fixtures/claude/resets-missing.json),
[an unknown type](../test/fixtures/claude/resets-unknown-type.json), and
[malformed data](../test/fixtures/claude/resets-malformed.json).

[The executable tests](../test/claude-resets.test.ts) drive the built public CLI
with fake profile stores, fixed time, an empty PATH, and a mock transport that
rejects unexpected traffic. They check the exact GET/query/header contract,
single/multiple accounts, positive/zero/omitted inventory, both JSON tiers, and
output compatibility. [Output snapshots](../test/__snapshots__/claude-resets.test.ts.snap)
record the absent and two-grant cases. These tests prove behavior against the
supplied contract; they do not prove the service currently implements it.

## Remaining verification

The undocumented flags and field meanings have **not** been independently
verified against the vendor client or a live account. A green test suite or a
no-mistakes attestation cannot supply that missing evidence. Live verification
remains the owner's responsibility after release, and shipping the undocumented
extension remains the maintainer's decision.

If the maintainer needs independent evidence before proceeding, the owner must
provide one of the following without sharing credentials:

- A version-identifiable, public client source/schema reference, or a shareable
  excerpt with its source and version, establishing the request flags, returned
  field names, remaining-count meaning, display-kind precedence, and expiry field.
- An owner-captured response from the vendor's own client, with the client version
  and capture context, retaining the relevant eligibility/count/type/expiry fields.
  Remove credentials, headers, cookies, account/organization identifiers, grant
  identifiers, unrelated event data, and other private account metadata before
  sharing it.

No primary-source excerpt or live capture was supplied with this task, and none is
invented here. The contributor will not obtain one by reading a Claude installation
or credential store, or by making a provider request.
