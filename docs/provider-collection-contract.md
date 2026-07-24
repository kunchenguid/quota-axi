# Provider collection contract

quota-axi is the read-only provider collection layer. It does not route work,
spend quota, or choose a model. Bridge consumes its normalized result and owns
opportunity-cost decisions.

## Caveman rule

Every provider starts with one authoritative source, one adapter, one fixture,
and one proof command. A provider may add fallbacks only when the primary
source is documented and the fallback is explicitly lower confidence.

## Ponytail capability gate

Before an adapter lands, record:

1. the official API or CLI;
2. its credential source and required user action;
3. the fields that are actually authoritative;
4. timeout, rate-limit, and schema-drift behavior;
5. a fixture and a prove command.

No percentage may be derived from a count or monetary value unless the source
also provides the corresponding limit. Otherwise the result is telemetry or
`UNKNOWN`, never routing capacity.

## Parallel execution

Providers are independent fan-out tasks. One timeout or authentication failure
must not cancel other providers. Each result carries `sourcesTried`,
`refreshedAt`, `status`, and a redacted error. Browser/CDP sources are bounded
and serialized per browser profile; ordinary HTTP and local-file sources may
run concurrently.

## Learning loop

The system learns from evidence, not model prose:

```text
source response -> normalized fixture -> adapter proof -> freshness history
                 -> Bridge routing decision -> outcome/latency/error ledger
```

Repeated failures identify broken credentials or endpoint drift. Repeated stale
results identify a source that needs a better first-party API. Routing outcomes
show whether opportunity-cost rules are actually saving subscription quota.

## Borrowed ideas

- SuperPlane: durable workflow steps, approvals, retries, and audit history.
- PDD: versioned prompts/specs, narrow modules, regeneration and verification.
- E²GraphRAG: staged extraction, graph retrieval, and cache-aware incremental
  work. These are design lessons; none becomes a second runtime authority.
