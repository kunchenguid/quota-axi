import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuota } from "../src/types.js";

/**
 * Opt-in claude-swap lanes (`QUOTA_AXI_CLAUDE_SWAP`), exercised through the
 * public command against a `cswap` stub on PATH that prints synthetic
 * `cswap list --json` output, plus a stubbed Anthropic endpoint for the native
 * lane. No real claude-swap, credential, or network is touched. The stubs are
 * `#!/bin/sh` scripts, so Windows skips them.
 */

let home: string;
let ran: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "quota-claude-swap-"));
  ran = join(home, "cswap-ran");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("USER", "fixture-user");
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("PATH", join(home, "bin"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", undefined);
  vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", undefined);
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-14T13:00:00.000Z");
  // The native selected lane: one stored login answering 30% used
  mkdirSync(join(home, ".claude"));
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-native" } }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/profile")
        ? new Response("", { status: 404 })
        : new Response(
            JSON.stringify({
              five_hour: { utilization: 30, resets_at: "2026-10-14T15:00:00Z" },
            }),
          ),
    ),
  );
});

afterEach(() => {
  vi.doUnmock("../src/lib/process.js");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

/** A `cswap` on PATH that records it ran, prints `stdout`, and exits `code`. */
function cswap(stdout: string, code = 0): void {
  const file = join(home, "bin", "cswap");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `[ "$*" = "list --json" ] || exit 64`,
      `: > '${ran}'`,
      `printf '%s\\n' '${stdout}'`,
      `exit ${code}`,
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

function environmentCheckingCswap(stdout: string): void {
  const file = join(home, "bin", "cswap");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `[ "$*" = "list --json" ] || exit 64`,
      `[ "$HOME" = '${home}' ] || exit 65`,
      `[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 66`,
      `[ -z "$ANTHROPIC_API_KEY" ] || exit 67`,
      `[ -z "$QUOTA_AXI_UNRELATED" ] || exit 68`,
      `printf '%s\\n' '${stdout}'`,
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

function oversizedCswap(done: string): void {
  const file = join(home, "bin", "cswap");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(
    file,
    [
      `#!${process.execPath}`,
      `const { writeFileSync } = require("node:fs");`,
      `process.stdout.write(Buffer.alloc(1_100_000, "x"), () => writeFileSync(${JSON.stringify(done)}, "done"));`,
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

function delayedCswap(done: string): void {
  const file = join(home, "bin", "cswap");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(
    file,
    [
      `#!${process.execPath}`,
      `const { writeFileSync } = require("node:fs");`,
      `setTimeout(() => process.stdout.write(${JSON.stringify(list())}, () => writeFileSync(${JSON.stringify(done)}, "done")), 100);`,
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !existsSync(file); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(file)).toBe(true);
}

async function waitForNoSwapOutput(directory: string): Promise<void> {
  for (
    let attempt = 0;
    attempt < 200 &&
    readdirSync(directory).some((name) => name.startsWith("quota-axi-cswap-"));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(
    readdirSync(directory).filter((name) =>
      name.startsWith("quota-axi-cswap-"),
    ),
  ).toEqual([]);
}

/** claude-swap's schema 1, shaped as observed from claude-swap 0.26. */
function list(accounts: unknown[] = [personal(), team()]): string {
  return JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts });
}

function personal(): Record<string, unknown> {
  return {
    number: 1,
    email: "personal@example.invalid",
    organizationName: "Personal Org",
    organizationUuid: "00000000-0000-4000-8000-000000000001",
    active: true,
    usageStatus: "ok",
    usage: {
      fiveHour: { pct: 9, resetsAt: "2026-10-14T18:00:00.431135+00:00" },
      sevenDay: { pct: 93, resetsAt: "2026-10-15T17:00:00Z", expectedPct: 83 },
    },
    usageFetchedAt: "2026-10-14T12:58:00Z",
  };
}

function team(): Record<string, unknown> {
  return {
    number: 2,
    email: "team@example.invalid",
    organizationName: "Team Org",
    organizationUuid: "00000000-0000-4000-8000-000000000002",
    active: false,
    usageStatus: "ok",
    usage: {
      fiveHour: { pct: 37, resetsAt: "2026-10-14T16:30:00Z" },
      sevenDay: { pct: 41, resetsAt: "2026-10-18T21:00:00Z" },
      scoped: [{ pct: 12, resetsAt: "2026-10-18T21:00:00Z", name: "Fable" }],
    },
    usageFetchedAt: "2026-10-14T12:59:00Z",
  };
}

type QuotaReport = { schemaVersion: number; providers: ProviderQuota[] };

async function quota(args: string[] = ["--json"]): Promise<QuotaReport> {
  // Imported per test: vi.resetModules lets each read see its stubbed env
  const { quotaCommand } = await import("../src/commands.js");
  return JSON.parse(
    await quotaCommand(["--provider", "claude", ...args], undefined),
  ) as QuotaReport;
}

function remaining(provider: ProviderQuota): string[] {
  return provider.windows.map((w) => `${w.id}=${w.percentRemaining}`);
}

/** The native selected lane, exactly as an unconfigured run reports it. */
function expectNativeLane(report: QuotaReport): void {
  expect(report.schemaVersion).toBe(5);
  expect(report.providers.map((p) => [p.accountKey, remaining(p)])).toEqual([
    [undefined, ["five_hour=70"]],
  ]);
}

describe.skipIf(process.platform === "win32")("claude-swap lanes", () => {
  it("never runs cswap without the opt-in", async () => {
    cswap(list());
    for (const value of [undefined, "", "0", "false", "yes"]) {
      vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", value);
      expectNativeLane(await quota());
    }
    expect(existsSync(ran)).toBe(false);
  });

  it("reports one attributed lane per account with used percent mapped to remaining", async () => {
    cswap(list());
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "true");
    // The claude-swap source takes precedence over profile lanes
    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", join(home, ".claude"));

    const report = await quota();
    expect(report.schemaVersion).toBe(6);
    expect(report.providers.map(remaining)).toEqual([
      ["five_hour=91", "seven_day=7"],
      ["five_hour=63", "seven_day=59"],
    ]);
    expect(report.providers[0].windows[0].resetsAt).toBe(
      "2026-10-14T18:00:00.431135+00:00",
    );
    const keys = report.providers.map((p) => p.accountKey!);
    for (const key of keys) expect(key).toMatch(/^claude-swap:[a-f0-9]{24}$/);
    expect(new Set(keys).size).toBe(2);
    expect(JSON.stringify(report)).not.toMatch(/example\.invalid|Org/);
    // claude-swap measured the usage; quota-axi sent no vendor request
    expect(fetch).not.toHaveBeenCalled();

    const [first] = (await quota(["--full", "--json"])).providers;
    expect(first).toMatchObject({
      source: "cli",
      attempts: [{ source: "claude-swap", status: "success" }],
      account: {
        email: "personal@example.invalid",
        organization: "Personal Org",
        identityStatus: "unverified",
      },
      state: { refreshedAt: "2026-10-14T12:58:00Z" },
    });

    // A slot renumbering in claude-swap does not move a lane's key
    cswap(
      list([
        { ...team(), number: 1 },
        { ...personal(), number: 2 },
      ]),
    );
    expect((await quota()).providers.map((p) => p.accountKey)).toEqual([
      keys[1],
      keys[0],
    ]);
  });

  it("ignores an invalid profile list when claude-swap owns the quota read", async () => {
    cswap(list());
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");
    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", "relative-work");

    const report = await quota();
    expect(report.providers.map(remaining)).toEqual([
      ["five_hour=91", "seven_day=7"],
      ["five_hour=63", "seven_day=59"],
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes only the approved environment to cswap", async () => {
    environmentCheckingCswap(list());
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "secret-claude-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "secret-anthropic-key");
    vi.stubEnv("QUOTA_AXI_UNRELATED", "not-for-the-child");

    const report = await quota();
    expect(report.providers).toHaveLength(2);
    expect(report.providers.map(remaining)).toEqual([
      ["five_hour=91", "seven_day=7"],
      ["five_hour=63", "seven_day=59"],
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an account without usable usage as its own unavailable lane", async () => {
    cswap(
      list([
        { ...personal(), usageStatus: "relogin_required", usage: null },
        // Every window's reset passed after claude-swap measured it
        {
          ...team(),
          usage: { fiveHour: { pct: 37, resetsAt: "2026-10-14T12:30:00Z" } },
        },
      ]),
    );
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");

    const report = await quota();
    expect(
      report.providers.map((p) => [p.windows, p.state.status, p.state.error]),
    ).toEqual([
      [[], "unavailable", "claude_swap_relogin_required"],
      [[], "unavailable", "claude_swap_usage_unavailable"],
    ]);
  });

  it("keeps an idle window that claude-swap reports without a reset", async () => {
    cswap(
      list([
        {
          ...personal(),
          usage: { ...personal().usage, fiveHour: { pct: 0 } },
        },
      ]),
    );
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");

    const report = await quota();
    expect(report.providers.map(remaining)).toEqual([
      ["five_hour=100", "seven_day=7"],
    ]);
    expect(report.providers[0].windows[0].resetsAt).toBeUndefined();
  });

  it("does not run cswap for auth or refresh-disabled quota", async () => {
    cswap(list());
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");
    const { authCommand } = await import("../src/commands.js");

    const auth = JSON.parse(
      await authCommand(["--provider", "claude", "--json"], undefined),
    ) as { auth: Array<{ sources: Array<{ source: string }> }> };
    expect(
      auth.auth[0].sources.some((source) => source.source === "claude-swap"),
    ).toBe(false);
    expect(existsSync(ran)).toBe(false);

    const report = await quota(["--no-credential-refresh", "--json"]);
    expect(report.providers[0]).toMatchObject({
      windows: [],
      state: { status: "unavailable", error: "claude_swap_refresh_disabled" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(ran)).toBe(false);
  });

  it("rejects oversized completed output after letting cswap finish", async () => {
    const done = join(home, "cswap-finished");
    oversizedCswap(done);
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");

    const report = await quota();
    expect(report.providers[0].state.error).toBe(
      "claude_swap_output_too_large",
    );
    await waitForFile(done);
  });

  it("walks away on timeout without closing the child's output", async () => {
    const done = join(home, "cswap-finished-after-timeout");
    const outputRoot = join(home, "tmp");
    mkdirSync(outputRoot);
    vi.stubEnv("TMPDIR", outputRoot);
    delayedCswap(done);
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");
    const realSetTimeout = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler, timeout, ...args) =>
        realSetTimeout(handler, timeout === 30_000 ? 0 : timeout, ...args),
      );

    const report = await quota();
    timer.mockRestore();
    expect(report.providers[0].state.error).toBe("claude_swap_timed_out");
    await waitForFile(done);
    await waitForNoSwapOutput(outputRoot);
  });

  it.each([
    ["a non-object row", [personal(), null]],
    ["a missing email", [personal(), { ...team(), email: undefined }]],
    [
      "a missing organization UUID",
      [personal(), { ...team(), organizationUuid: undefined }],
    ],
    [
      "a non-string organization name",
      [personal(), { ...team(), organizationName: 42 }],
    ],
    [
      "a missing usage status",
      [personal(), { ...team(), usageStatus: undefined }],
    ],
    ["a missing usage field", [personal(), { ...team(), usage: undefined }]],
    ["a non-object usage", [personal(), { ...team(), usage: [] }]],
    [
      "an invalid fetched-at date",
      [personal(), { ...team(), usageFetchedAt: "not-a-date" }],
    ],
    [
      "a non-finite window percentage",
      [
        personal(),
        {
          ...team(),
          usage: {
            fiveHour: {
              pct: "37",
              resetsAt: "2026-10-14T16:30:00Z",
            },
          },
        },
      ],
    ],
    [
      "an invalid reset date",
      [
        personal(),
        {
          ...team(),
          usage: { fiveHour: { pct: 37, resetsAt: "not-a-date" } },
        },
      ],
    ],
    ["a repeated account key", [personal(), personal()]],
  ])("rejects every account when one row has %s", async (_case, accounts) => {
    cswap(list(accounts));
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");

    const report = await quota();
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]).toMatchObject({
      windows: [],
      state: { status: "unavailable", error: "claude_swap_malformed" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["is not installed", undefined, "claude_swap_unavailable"],
    ["exits nonzero", () => cswap(list(), 1), "claude_swap_exit_status"],
    [
      "prints malformed JSON",
      () => cswap("{not json"),
      "claude_swap_malformed",
    ],
    [
      "prints another schema",
      () => cswap('{"schemaVersion":2,"accounts":[]}'),
      "claude_swap_malformed",
    ],
    ["lists no account", () => cswap(list([])), "claude_swap_malformed"],
    [
      "lists no keyable account",
      () => cswap(list([{ usageStatus: "ok" }])),
      "claude_swap_malformed",
    ],
  ])(
    "reports unavailable without native fallback when cswap %s",
    async (_case, install, error) => {
      install?.();
      vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");
      const report = await quota();
      expect(report.providers[0]).toMatchObject({
        windows: [],
        state: { status: "unavailable", error },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("claude-swap launcher boundary", () => {
  it.each([".cmd", ".bat"])(
    "rejects a Windows %s launcher without spawning it",
    async (extension) => {
      vi.doMock("../src/lib/process.js", async () => {
        const actual = await vi.importActual<
          typeof import("../src/lib/process.js")
        >("../src/lib/process.js");
        return {
          ...actual,
          findCommandPath: async (command: string) =>
            command === "cswap"
              ? `C:\\tools\\cswap${extension}`
              : actual.findCommandPath(command),
        };
      });
      vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");

      const report = await quota();
      expect(report.providers[0]).toMatchObject({
        windows: [],
        state: {
          status: "unavailable",
          error: "claude_swap_unavailable",
          remedyCommand: "pipx install claude-swap",
        },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
