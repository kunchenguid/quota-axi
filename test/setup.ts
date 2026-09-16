import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const name of [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]) {
  delete process.env[name];
}

// No test may read this machine's real GitHub CLI login: point `gh`'s own
// configuration directory at a path that never exists. Tests that exercise the
// store set their own sandbox directory.
process.env.GH_CONFIG_DIR = join(
  tmpdir(),
  `quota-axi-test-no-gh-config-${process.pid}-${randomUUID()}`,
);
