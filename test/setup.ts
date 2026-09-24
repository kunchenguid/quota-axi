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

// Native Copilot metadata must never come from the developer's real profile.
process.env.COPILOT_HOME = join(
  tmpdir(),
  `quota-axi-test-no-copilot-config-${process.pid}-${randomUUID()}`,
);

// Quota snapshots must never land in the developer's real ~/.cache/quota-axi.
// Commands such as `models` write the cache; without this, a suite run can
// stamp a fixture into the live Claude slot under the machine's real context.
process.env.XDG_CACHE_HOME = join(
  tmpdir(),
  `quota-axi-test-cache-${process.pid}-${randomUUID()}`,
);

// The user config file (the `--tui` direction preference) must never come
// from the developer's real ~/.config/quota-axi. Tests that exercise it write
// their own file.
process.env.XDG_CONFIG_HOME = join(
  tmpdir(),
  `quota-axi-test-config-${process.pid}-${randomUUID()}`,
);

// Devin's credentials file is `$XDG_DATA_HOME/devin/credentials.toml` when that
// variable is set, otherwise the developer's real ~/.local/share/devin. Point
// the variable at an empty directory and drop the environment token so a suite
// run cannot read or send the machine's signed-in session.
process.env.XDG_DATA_HOME = join(
  tmpdir(),
  `quota-axi-test-data-${process.pid}-${randomUUID()}`,
);
delete process.env.WINDSURF_API_KEY;
delete process.env.WINDSURF_API_SERVER_URL;

// A host may opt into fresh reuse or point at a snapshot fixture for every
// process; tests start from the default and opt in themselves.
delete process.env.QUOTA_AXI_MAX_AGE;
delete process.env.QUOTA_AXI_SNAPSHOT;
