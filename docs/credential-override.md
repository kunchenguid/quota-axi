# Uniform credential override contract

quota-axi is read-only against local provider state. Some callers, however,
hold a provider token of their own (for example a token pasted into a wrapper
application) and need an answer computed from THAT credential - not from
whatever the local machine happens to be signed in with, and not from a stale
cache. The uniform credential override exists for those callers.

The contract is uniform and provider-blind: one envelope shape covers every
provider, the caller needs zero per-vendor knowledge, and a provider added to
quota-axi later is covered automatically.

This document is the normative specification. A plain-language summary lives
in the README under [Credential overrides](../README.md#credential-overrides).

## Envelope (schema 1)

A single JSON document, delivered over one of the two transports below:

```json
{
  "schema": 1,
  "credentials": {
    "<provider>": { "kind": "bearer", "token": "<token bytes>" }
  }
}
```

- `schema` must be the number `1`.
- `credentials` must be an object with at least one entry. Keys must be
  supported provider ids (`claude`, `codex`, `cursor`, `copilot`, `grok`,
  `kimi`). An envelope may carry entries for providers the current invocation
  does not query; those entries are inactive and ignored.
- Each entry carries exactly `kind` and `token`. `kind` must be `"bearer"`.
- `token` is the literal credential: a non-empty string of at most 4096
  characters, without surrounding whitespace, without control characters, and
  never an environment, template, or command reference (a leading `!` or any
  `$` is rejected rather than resolved). quota-axi sends it as the
  `Authorization: Bearer` value to the provider's first-party quota endpoint -
  the same endpoint the provider's adapter already calls for local
  credentials.
- Unknown fields anywhere in the envelope are rejected (fail-closed
  typo-safety). A future schema version may add fields.

## Transports

### stdin (preferred)

Write the envelope to quota-axi's inherited stdin and close the pipe. This is
the standard Unix filter contract (the same shape as `jq .`): quota-axi reads
stdin to end-of-stream, so the sender must close the write side. Interactive
terminals never carry an envelope; when stdin is a TTY, quota-axi does not
read it at all.

With this transport, token bytes travel: caller memory -> pipe -> quota-axi
memory -> the provider's HTTPS request. Nothing else ever holds them.

### File (`QUOTA_AXI_CREDENTIALS_FILE`)

If operability demands a file, name it with the
`QUOTA_AXI_CREDENTIALS_FILE` environment variable. The file must be a regular
file, at most 64 KiB, and on POSIX systems must have mode bits permitting no
group or other access (`0600`, or stricter); anything looser is rejected with
a validation error. The caller owns creating the file with those permissions,
its parent directory, and deleting it after the flight.

### Transport rules

- At most one transport may carry an envelope per invocation. If both stdin
  and the named file contain envelope bytes, invocation fails closed with exit
  code 2.
- Token bytes are NEVER placed in argv (no such flag exists) and NEVER copied
  into the environment of any child process quota-axi spawns. In particular,
  the Codex adapter's read-only `codex app-server` fallback inherits this
  process's environment when it runs - but it never runs during an override
  flight, and override tokens are never stored in `process.env` in the first
  place.
- A non-empty stdin or file that does not parse as a valid schema-1 envelope
  is a validation error (exit code 2), never silently ignored: silently
  falling back to local credentials would report local quota to a caller that
  believes an override is active.

## Flight semantics

When the envelope names the provider being queried, that provider's adapter
flies the request with ONLY the override credential:

- **Exclusivity.** No local credential source is read: no OAuth files, no
  macOS Keychain access, no SQLite state database, no Pi or vendor CLI auth
  files, no vendor CLI fallback process.
- **Attribution.** A successful flight reports `source: "override"` and
  `state.sourcesTried: ["override"]`; with `--full`, the single source attempt
  is `{source: "override", status: "success"}`. If the flight fails, there is
  no quota data to attribute, so `source` is `unavailable` while
  `state.sourcesTried` and `--full` attempts still record the override flight
  truthfully.
- **No stale-cache answers.** A failed override flight never answers from the
  quota cache, and it neither retires nor rewrites cached local-source
  snapshots: the override's verdict says nothing about local credential
  validity.
- **Nothing override-flavored is cached.** A successful override snapshot is
  never written to the quota cache; cache writes skip `source: "override"`
  reports, and cache reads reject them.
- **Truthful rejection.** A definitive HTTP 401/403 from the provider surfaces
  as `state.status: "auth_required"` with `state.error: "override_rejected"`.
  Transient failures (timeouts, network, 5xx) and rate limiting surface as
  they do for local credentials, with `rate_limited` flights still honoring
  `Retry-After`. quota-axi never retries an override flight against a
  different credential.
- **No local authStatus claim.** `state.authStatus` describes local credential
  usability and is left unset for override flights: the flight proves the
  override token worked, not anything about the local machine.

The remaining output pipeline is unchanged: interpretation, pace, runway,
redaction, TOON/JSON/TUI rendering, and exit codes behave exactly as they do
for local-source flights. `auth`, `quota`, and `models` all honor the
envelope; the `auth` report adds a `{source: "override", status: "available",
credentialPresent: true}` row for each provider the envelope names, without
probing the token remotely.

## Absent-envelope parity

When stdin is a TTY, empty, or unreadable, and no override file is named,
invocation behavior is byte-for-byte identical to a quota-axi build without
this contract. The envelope is the only trigger; there are no flags and no
other activation surfaces.

## Capability advertisement and version floor

`quota-axi auth --json` carries a `capabilities` object (an additive minor
extension of the schema-1 auth report):

```json
{
  "capabilities": {
    "credentialOverride": { "schema": 1, "transports": ["stdin", "file"] }
  }
}
```

Consumers MUST feature-detect this field before sending an envelope, and MUST
treat its absence as "override unsupported": builds that predate this contract
do not read stdin at all, so an envelope sent to them would be silently
ignored and the answer would misleadingly come from local sources. The minimum
supported quota-axi version is therefore "the first release whose
`auth --json` advertises `capabilities.credentialOverride`" - pin the floor by
detection, not by comparing version strings. `schema` tells the consumer which
envelope schemas the installed build accepts; `transports` tells it which
delivery channels are available.

Sending an envelope to a detected-unsupported build, or continuing as though
the override applied, is a contract violation: fail closed and surface that
the installed quota-axi is too old.

## Error catalog

Validation errors (exit code 2, before any provider work; messages never
contain token bytes):

- envelope is not valid JSON / not an object / exceeds 64 KiB
- `schema` is not 1
- unknown top-level or credential-entry field
- unknown provider id
- `credentials` empty, entry not an object, kind not `"bearer"`
- token empty, oversized, whitespace-padded, control characters, or
  reference-shaped (`!`/`$`)
- both transports carry envelope bytes
- file transport: file missing, not a regular file, oversized, or
  group/other-readable

Runtime states (exit code 1 when every queried provider fails):

- `override_rejected` / `auth_required` - the provider definitively refused
  the token (HTTP 401/403)
- truthful transient states (`rate_limited` with `retryAfter`, network and
  server errors) mirroring local-source flights

## Security analysis

- Token bytes exist in exactly two process memories (the caller's and
  quota-axi's) and one TLS request. They never touch argv, environment blocks
  (quota-axi's own or any child's), the quota cache, logs, stdout, or stderr.
  Test coverage asserts that rendered output and error text never contain
  token bytes.
- The stdin transport strictly dominates alternatives: argv is
  process-list-visible, environment values are visible to same-uid processes
  and are inherited by child processes, and files leave residue windows.
- The file transport exists for operability only; the 0600 requirement is
  enforced (POSIX) and fail-closed.
- quota-axi uses an override token for exactly one provider request chain
  (usage plus, where already established, the provider's first-party identity
  endpoint). It never forwards the token elsewhere, never stores it, and never
  refreshes it.
