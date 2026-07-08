# quota-axi Claude Keychain Default Read Evidence

This evidence runs the actual CLI entrypoint with a fake macOS `security` command and a fake Claude OAuth usage API.
The fake Keychain value contains a sentinel token, and the harness checks that the token is not rendered in CLI output or cache files.

## CLI flow

| Step | Command                                                             | Exit | Provider status | Advice                   | Cache percent |
| ---- | ------------------------------------------------------------------- | ---: | --------------- | ------------------------ | ------------: |
| 1    | `quota-axi --provider claude --json --full`                         |    1 | auth_required   | keychain_access_required |           n/a |
| 2    | `quota-axi --provider claude --json --full --allow-keychain-prompt` |    0 | fresh           | none                     |            12 |
| 3    | `quota-axi --provider claude --json --full`                         |    0 | fresh           | none                     |             7 |

## Security command calls

```text
find-generic-password -s Claude Code-credentials
find-generic-password -s Claude Code-credentials -w
find-generic-password -s Claude Code-credentials -w
```

## Checks

- The first plain call had no marker and only ran the non-secret presence check.
- The first plain call emitted `keychain_access_required` advice with the `quota-axi --allow-keychain-prompt` remedy.
- The bootstrap call used `security find-generic-password -w`, returned fresh quota, and created the marker with mode `0600`.
- The later plain call reused the marker, used `security find-generic-password -w`, returned fresh quota, and refreshed the cache to `7` percent used.
- The sentinel token was observed in OAuth authorization headers but was not rendered in CLI output or cache files: `true`.
