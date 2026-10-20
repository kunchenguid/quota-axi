import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
const FIXED_NOW = Date.parse("2026-08-07T00:00:00.000Z");
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

type Run = { status: number | null; stdout: string; stderr: string };

/**
 * Runs the built CLI with a frozen clock against a snapshot holding two Claude
 * profile lanes, so two runs that differ only in the user config file can be
 * compared byte for byte. `config` is that file's contents; left out, no file
 * exists. The lanes live under the synthetic home, as `~/.claude` and
 * `~/.claude-work`.
 */
function builtCli(): {
  home: string;
  run: (flags: string[], config?: string) => Run;
} {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-account-labels-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const clock = join(root, "fixed-clock.mjs");
  writeFileSync(
    clock,
    `const RealDate = Date;
const FIXED_NOW = ${FIXED_NOW};
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }
  static now() {
    return FIXED_NOW;
  }
}
globalThis.Date = FixedDate;
`,
  );
  // A cache record keeps a profile lane's locator on its reuse stamp; a
  // claude-swap lane has none.
  const lane = (
    directory: string | undefined,
    accountKey: string,
    remaining: number,
    index: number,
  ) => ({
    provider: "claude",
    label: "Claude",
    source: "oauth",
    accountKey,
    windows: [
      {
        id: "seven_day",
        label: "week",
        kind: "weekly",
        percentUsed: 100 - remaining,
        percentRemaining: remaining,
        windowSeconds: 604_800,
        resetsAt: new Date(FIXED_NOW + 2 * 86_400_000).toISOString(),
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(FIXED_NOW - 60_000).toISOString(),
      sourcesTried: ["oauth-file"],
    },
    reuse: {
      context: "c".repeat(64),
      inputs: [],
      inputsDigest: "d".repeat(64),
      readingAt: new Date(FIXED_NOW - 60_000).toISOString(),
      lanes: 3,
      lane: index,
      ...(directory && {
        accountLocator: {
          kind: "config-dir",
          path: join(home, directory),
          delegateEligible: index === 0,
        },
      }),
    },
  });
  const snapshot = join(root, "snapshot.json");
  writeFileSync(
    snapshot,
    JSON.stringify({
      schemaVersion: 3,
      providers: [
        lane(".claude", "profile:aaaaaaaaaaaaaaaaaaaaaaaa", 70, 0),
        lane(".claude-work", "profile:bbbbbbbbbbbbbbbbbbbbbbbb", 40, 1),
        lane(undefined, "claude-swap:9a1c20d6b88a9bcec745fb70", 20, 2),
      ],
    }),
  );

  return {
    home,
    run: (flags, config) => {
      const configHome = join(root, "config");
      rmSync(configHome, { recursive: true, force: true });
      if (config !== undefined) {
        mkdirSync(join(configHome, "quota-axi"), { recursive: true });
        writeFileSync(join(configHome, "quota-axi", "config.json"), config);
      }
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(clock).href,
          BUILT_CLI_ENTRYPOINT,
          "--provider",
          "claude",
          ...flags,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            HOME: home,
            XDG_CACHE_HOME: join(root, "cache"),
            XDG_CONFIG_HOME: configHome,
            QUOTA_AXI_SNAPSHOT: snapshot,
            PATH: process.env.PATH ?? "",
            TZ: "UTC",
          },
        },
      );
      if (result.error) throw result.error;
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

describe("--tui account labels", () => {
  it("names each Claude profile lane's card from the user config file", () => {
    const cli = builtCli();
    const labelled = cli.run(
      ["--tui", "--once"],
      JSON.stringify({
        tui: {
          accountLabels: {
            "~/.claude": "personal",
            [`${join(cli.home, ".claude-work")}/`]: "posam",
          },
        },
      }),
    );

    expect(labelled.status, labelled.stderr).toBe(0);
    expect(labelled.stdout).toMatch(/╭─ ● claude · personal ─+ oauth · reused/);
    expect(labelled.stdout).toMatch(/╭─ ● claude · posam ─+ oauth · reused/);
    // The label sits beside the account key, never in place of it.
    expect(labelled.stdout).toContain(
      "account profile:bbbbbbbbbbbbbbbbbbbbbbbb",
    );
  }, 30_000);

  it("names a claude-swap lane, which has no locator, by its account key", () => {
    const cli = builtCli();
    const labelled = cli.run(
      ["--tui", "--once"],
      '{"tui":{"accountLabels":{"claude-swap:9a1c20d6b88a9bcec745fb70":"team"}}}',
    );

    expect(labelled.status, labelled.stderr).toBe(0);
    expect(labelled.stdout).toMatch(/╭─ ● claude · team ─+ oauth · reused/);
    expect(labelled.stdout.match(/claude · /g)).toHaveLength(1);
  }, 30_000);

  it("keeps the --tui report unchanged without a usable setting", () => {
    const cli = builtCli();
    const baseline = cli.run(["--tui", "--once"]);
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(baseline.stdout).toMatch(/╭─ ● claude ─+ oauth · reused/);
    for (const config of [
      "not json",
      '{"tui":{"accountLabels":["~/.claude"]}}',
      '{"tui":{"accountLabels":{".claude":"relative","~/.claude-work":" "}}}',
    ]) {
      expect(cli.run(["--tui", "--once"], config), config).toEqual(baseline);
    }
  }, 30_000);

  it("leaves TOON and JSON byte-identical whatever it says", () => {
    const cli = builtCli();
    const config = JSON.stringify({
      tui: {
        accountLabels: {
          "~/.claude": "personal",
          "claude-swap:9a1c20d6b88a9bcec745fb70": "team",
        },
      },
    });
    for (const flags of [[], ["--full"], ["--json"], ["--json", "--full"]]) {
      const baseline = cli.run(flags);
      expect(baseline.status, baseline.stderr).toBe(0);
      expect(baseline.stdout).toContain("profile:aaaaaaaaaaaaaaaaaaaaaaaa");
      expect(baseline.stdout).not.toContain("personal");
      expect(cli.run(flags, config), flags.join(" ")).toEqual(baseline);
    }
  }, 60_000);
});
