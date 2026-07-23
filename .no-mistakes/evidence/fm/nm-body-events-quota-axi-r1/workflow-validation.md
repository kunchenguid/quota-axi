# PR body compliance workflow validation

Validated target commit `b4ca4b61aba2c7b6def255ddd4ae521d60457c0b`
against base `f0cce7f2499b152d0bc1272e8c69b242308ce261`.

## End-user signature check

The workflow's actual embedded shell step was parsed from
`.github/workflows/no-mistakes-required.yml` and executed with representative
PR event data.

```text
=== signed opened/edited body ===
Found no-mistakes signature in PR #42 body.
exit_status=0
=== unsigned opened/edited body ===
::error::This PR was not raised through no-mistakes.

Contributions to this repository must be submitted via 'git push no-mistakes'.
That pipeline runs the required review/test/lint/CI steps and writes a
deterministic '## Pipeline' section into the PR body containing:

    Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)

See CONTRIBUTING.md for setup and the full workflow.

PR author: test-user
exit_status=1
```

## Event concurrency matrix

The configured group expression was checked across successive events for the
same PR:

```text
event | run_id | concurrency group
opened | 101 | no-mistakes-required-42-101
opened | 102 | no-mistakes-required-42-102
edited | 103 | no-mistakes-required-42-103
edited | 104 | no-mistakes-required-42-104
synchronize | 105 | no-mistakes-required-42-head-change
reopened | 106 | no-mistakes-required-42-head-change

Workflow contract: PASS
```

This demonstrates immutable per-run groups for every body-bearing event and
preserved coalescing for head-change events.

## Preserved workflow contract

Focused structural assertions confirmed:

- `pull_request` remains the trigger boundary, targeting `main`.
- Event types remain `opened`, `edited`, `synchronize`, and `reopened`.
- Permissions remain exactly `contents: read`.
- `cancel-in-progress` remains `true`.
- The stable check name remains `PR must be raised via no-mistakes`.
- All three existing bot exemptions remain present.
- No step uses an action or checks out or executes fork code.
- The canonical run name includes PR number, action, run number, and run ID.

## Minimal rollout scope

```text
commit=b4ca4b61aba2c7b6def255ddd4ae521d60457c0b
subject=fix: execute every PR body compliance event
parents=f0cce7f2499b152d0bc1272e8c69b242308ce261
.github/workflows/no-mistakes-required.yml
6       1       .github/workflows/no-mistakes-required.yml
```

The diff contains exactly two hunks: the canonical `run-name` addition and the
concurrency policy update with its rationale comment. No documentation or
unrelated project files changed.
