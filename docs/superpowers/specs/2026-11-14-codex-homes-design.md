# Codex Home Lanes Design

## Intent

When `QUOTA_AXI_CODEX_HOMES` is set, quota-axi reports each listed absolute Codex home as an independent Codex lane. Each lane reads only its own `auth.json`, keeps its own quota and cache identity, and cannot hide failures in sibling lanes. When unset, existing single-account behavior is unchanged.

## Scope and constraints

- Codex only; Claude's existing profile-list shape is the model.
- The value is a platform path-delimiter-separated list of absolute home directories.
- Listed homes are opt-in, read-only sibling lanes. The selected native Codex home remains the existing lane.
- No secrets, tokens, or file contents appear in output.
- `--profile-only`, TUI design, other providers, generalized account framework, and Pi directory discovery are out of scope.

## Approaches

1. **Codex-specific lane per home (selected):** bind each listed directory to a `ProviderAccount` and reuse Codex's existing native credential reader and quota selection logic for that lane. This mirrors Claude's profile lanes, limits the diff, and avoids process-environment mutation.
2. **Generalize credential brokers into a multi-home framework:** flexible, but expands scope and risks changing unrelated providers.
3. **Temporarily mutate process environment while reading each home:** small surface, but unsafe for concurrent reads and difficult to reason about.

The first approach is selected because it gives isolated reads with the smallest provider-local change and preserves the existing unset path.

## Open implementation choices

Use an opaque `codex-home:<sha256(real home identity).slice(0,24)>` account key for listed lanes, attach an `accountLocator` of kind `codex-home` only in expanded/full output, validate relative entries as `VALIDATION_ERROR`, and keep the selected home as the legacy `codex-home` lane. Listed lanes use no delegated refresh and no environment-selected credential.
