# Credential naming contract

Provider API credentials use one canonical name in Infisical, Keychain, and
the process environment:

| Provider     | Canonical name         | Legacy/read-only aliases             |
| ------------ | ---------------------- | ------------------------------------ |
| TokenRouter  | `TOKENROUTER_MGMT_KEY` | none                                 |
| OpenRouter   | `OPENROUTER_API_KEY`   | none                                 |
| Pioneer      | `PIONEER_API_KEY`      | none                                 |
| Command Code | `COMMANDCODE_API_KEY`  | none                                 |
| RunPod       | `RUNPOD_API_KEY`       | none                                 |
| Fireworks    | `FIREWORKS_API_KEY`    | none                                 |
| Daytona      | `DAYTONA_API_KEY`      | `DAYTONA_API_TOKEN`, `daytona-token` |

Infisical paths are `/providers/<provider>/<canonical-name>`. Keychain entries
use service `bridge-secrets` and the canonical name as account. Legacy names are
read-only compatibility paths and must not be newly written.

CLI-authenticated providers (Inference.net and Antigravity) keep credentials in
their official CLI stores and are not copied into this contract. NVIDIA's local
40-RPM limiter has no account credential.

Migration is additive: read the canonical name first, then aliases, verify live
collection, and only then remove legacy entries. No secret value is printed or
persisted by the migration.
