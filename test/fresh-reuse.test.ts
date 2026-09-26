import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quotaCommand } from "../src/commands.js";
import type { QuotaAxiResponse } from "../src/types.js";

// No installed Codex CLI may answer for the synthetic Codex logins
vi.mock("../src/lib/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/process.js")>();
  return { ...actual, findCommandPath: vi.fn(async () => undefined) };
});

/**
 * Fresh reuse, end to end through the quota command against a synthetic Claude
 * profile. The vendor is a stub that counts usage calls, so every assertion is
 * about how often quota-axi would have asked the vendor.
 */

const START = "2026-09-23T01:25:00.000Z";
const USAGE = {
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 30,
      resets_at: "2026-09-23T03:00:00Z",
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 40,
      resets_at: "2026-09-29T21:00:00Z",
    },
  ],
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const saved = Object.fromEntries(
  [
    "HOME",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_HOME",
    "PI_CODING_AGENT_DIR",
    "QUOTA_AXI_SNAPSHOT",
    "QUOTA_AXI_MAX_AGE",
  ].map((name) => [name, process.env[name]]),
);
let root: string;
let usageCalls: number;
let usagePercent: number;
/** The lock files present while the vendor was being asked */
let locksDuringUsage: string[];

beforeEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "linux",
  });
  root = mkdtempSync(join(tmpdir(), "quota-axi-fresh-reuse-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.XDG_CACHE_HOME = join(root, "cache");
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.QUOTA_AXI_SNAPSHOT;
  // Reuse is opt-in; these tests enable it the way a host does
  process.env.QUOTA_AXI_MAX_AGE = "90s";
  useProfile("a");
  usageCalls = 0;
  locksDuringUsage = [];
  usagePercent = 30;
  // Faking only Date leaves the Response body stream on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(START));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/oauth/profile")) {
        return new Response(JSON.stringify({ account: { uuid: "fixture" } }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/oauth/usage")) {
        usageCalls++;
        locksDuringUsage = existsSync(locksDir())
          ? readdirSync(locksDir())
          : [];
        const payload = structuredClone(USAGE);
        payload.limits[0]!.percent = usagePercent;
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

function useProfile(name: string, token = `synthetic-${name}-token`): void {
  const configDir = join(root, `profile-${name}`);
  mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;
  writeCredentials(configDir, token);
}

function writeCredentials(configDir: string, token: string): void {
  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        expiresAt: "2035-01-01T00:00:00.000Z",
        subscriptionType: "max",
      },
    }),
  );
}

/** The documented cache location under `XDG_CACHE_HOME` */
function cacheFilePath(): string {
  return join(root, "cache", "quota-axi", "quotas.json");
}

function locksDir(): string {
  return join(root, "cache", "quota-axi", "locks");
}

function advance(seconds: number): void {
  vi.setSystemTime(new Date(Date.now() + seconds * 1_000));
}

async function readJson(
  ...flags: string[]
): Promise<QuotaAxiResponse["providers"][number]> {
  const output = await quotaCommand(
    ["--provider", "claude", "--json", "--no-credential-refresh", ...flags],
    undefined,
  );
  return (JSON.parse(output) as QuotaAxiResponse).providers[0]!;
}

async function readToon(...flags: string[]): Promise<string> {
  return quotaCommand(
    ["--provider", "claude", "--no-credential-refresh", ...flags],
    undefined,
  );
}

describe("fresh reuse is opt-in", () => {
  it("asks the vendor on every read when neither --max-age nor QUOTA_AXI_MAX_AGE is set", async () => {
    delete process.env.QUOTA_AXI_MAX_AGE;
    for (let read = 0; read < 3; read++) {
      expect((await readJson()).state.reused).toBeUndefined();
      advance(5);
    }
    expect(usageCalls).toBe(3);
    expect(locksDuringUsage).toEqual([]);

    await readJson("--max-age", "90s");
    expect(usageCalls).toBe(3);
  });

  it("lets --max-age win over QUOTA_AXI_MAX_AGE", async () => {
    process.env.QUOTA_AXI_MAX_AGE = "10s";
    await readJson();
    advance(30);
    await readJson();
    expect(usageCalls).toBe(2);
    advance(30);
    expect((await readJson("--max-age", "2m")).state.reused).toBe(true);
    expect(usageCalls).toBe(2);
  });

  it("fails clearly on a QUOTA_AXI_MAX_AGE that does not parse", async () => {
    for (const value of ["soon", "61m"]) {
      process.env.QUOTA_AXI_MAX_AGE = value;
      await expect(readJson()).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("QUOTA_AXI_MAX_AGE"),
      });
    }
    expect(usageCalls).toBe(0);
  });

  it("treats a blank QUOTA_AXI_MAX_AGE as unset", async () => {
    process.env.QUOTA_AXI_MAX_AGE = " ";
    await readJson();
    await readJson();
    expect(usageCalls).toBe(2);
  });
});

describe("single-flight lock", () => {
  it("holds a lock only while it reads the vendor", async () => {
    await readJson();
    expect(locksDuringUsage).toHaveLength(1);
    expect(readdirSync(locksDir())).toEqual([]);
  });

  it("takes over a lock whose holder exited", async () => {
    await readJson();
    const [lock] = locksDuringUsage;
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(
      join(locksDir(), lock!),
      JSON.stringify({
        pid: exited,
        host: (await import("node:os")).hostname(),
        token: "crashed-holder",
      }),
    );
    // Judged by the holder, not by age
    const now = Date.now() / 1000;
    utimesSync(join(locksDir(), lock!), now, now);
    advance(100);

    const started = performance.now();
    const read = await readJson();
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(read.state.status).toBe("fresh");
    expect(usageCalls).toBe(2);
    expect(readdirSync(locksDir())).toEqual([]);
  });
});

describe("fresh reuse", () => {
  it("answers a burst of reads with one vendor call, where --max-age 0 makes one per read", async () => {
    for (let read = 0; read < 8; read++) {
      await readJson();
      advance(5);
    }
    expect(usageCalls).toBe(1);

    // The pre-reuse behavior, for comparison: every read asks the vendor.
    usageCalls = 0;
    for (let read = 0; read < 8; read++) await readJson("--max-age", "0");
    expect(usageCalls).toBe(8);
  });

  it("serves a reused reading as fresh, with its fetch time kept in default --json", async () => {
    const first = await readJson();
    advance(42);
    const reused = await readJson();

    expect(usageCalls).toBe(1);
    expect(first.state.reused).toBeUndefined();
    expect(first.state.refreshedAt).toBeUndefined();
    expect(reused.state).toMatchObject({
      status: "fresh",
      stale: false,
      reused: true,
      refreshedAt: START,
    });
    const figures = (provider: typeof first) =>
      provider.windows.map(({ id, percentRemaining, resetsAt }) => ({
        id,
        percentRemaining,
        resetsAt,
      }));
    expect(figures(reused)).toEqual(figures(first));
    expect(reused.quotaSemantics?.effectiveAvailability).toMatchObject(
      first.quotaSemantics!.effectiveAvailability.map(({ scope }) => ({
        scope,
      })),
    );
    expect(
      reused.quotaSemantics?.effectiveAvailability.every(
        (scope) => scope.status !== "unknown",
      ),
    ).toBe(true);
  });

  it("names a reused reading in TOON attention and keeps its quota rows", async () => {
    await readToon();
    advance(30);
    const toon = await readToon();

    expect(usageCalls).toBe(1);
    expect(toon).toMatch(/\n {2}claude,all_models,\d+/);
    expect(toon).toContain(`claude,all,reused,"last refreshed ${START}",none`);
    expect(toon).not.toContain(",stale,");
  });

  it("asks the vendor again once the reading is older than the bound", async () => {
    await readJson();
    advance(89);
    await readJson();
    expect(usageCalls).toBe(1);

    advance(2);
    const refreshed = await readJson();
    expect(usageCalls).toBe(2);
    expect(refreshed.state.reused).toBeUndefined();
  });

  it("honors an explicit --max-age", async () => {
    await readJson();
    advance(100);
    await readJson("--max-age", "2m");
    expect(usageCalls).toBe(1);
    await readJson("--max-age=30s");
    expect(usageCalls).toBe(2);
  });

  it("never serves one profile's reading to another", async () => {
    await readJson();
    useProfile("b");
    usagePercent = 75;
    const other = await readJson();

    expect(usageCalls).toBe(2);
    expect(other.state.reused).toBeUndefined();
    expect(other.windows[0]).toMatchObject({ percentRemaining: 25 });

    // One cache slot per lane: returning to a profile reads it again, and
    // that profile then reuses its own reading.
    useProfile("a");
    const back = await readJson();
    expect(usageCalls).toBe(3);
    expect(back.state.reused).toBeUndefined();
    expect((await readJson()).state.reused).toBe(true);
    expect(usageCalls).toBe(3);
  });

  it("reads again after a login rewrites the credential store in place", async () => {
    await readJson();
    advance(10);
    writeCredentials(process.env.CLAUDE_CONFIG_DIR!, "synthetic-new-login");
    usagePercent = 90;
    const relogged = await readJson();

    expect(usageCalls).toBe(2);
    expect(relogged.state.reused).toBeUndefined();
    expect(relogged.windows[0]).toMatchObject({ percentRemaining: 10 });
  });

  it("reads again when an environment credential now selects another account", async () => {
    await readJson();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "synthetic-env-token";
    const selected = await readJson();

    expect(usageCalls).toBe(2);
    expect(selected.state.reused).toBeUndefined();
  });

  it("never reuses a reading once one of its windows has reached its reset", async () => {
    vi.setSystemTime(new Date("2026-09-23T02:59:30.000Z"));
    await readJson();
    advance(45);
    const afterReset = await readJson();

    expect(usageCalls).toBe(2);
    expect(afterReset.state.reused).toBeUndefined();
  });

  it("never reuses a failed read, and never lets a failure retire the reading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        usageCalls++;
        throw new TypeError("network unavailable");
      }),
    );
    const failed = await readJson();
    expect(failed.state.status).not.toBe("fresh");
    await readJson();
    expect(usageCalls).toBeGreaterThan(1);
  });

  it("reads the vendor for --full, whose account and attempts are never cached", async () => {
    await readJson();
    const full = await readJson("--full");
    expect(usageCalls).toBe(2);
    expect(full.state.reused).toBeUndefined();
    expect(full.attempts?.length).toBeGreaterThan(0);

    await readJson("--full", "--max-age", "90s");
    expect(usageCalls).toBe(2);
  });

  it("does not restamp a reused reading's age when it writes the cache", async () => {
    await readJson();
    const written = readFileSync(cacheFilePath(), "utf8");
    advance(20);
    await readJson();
    expect(readFileSync(cacheFilePath(), "utf8")).toBe(written);
  });

  it("stores only a hashed selection and file state, never a credential", async () => {
    await readJson();
    const cache = readFileSync(cacheFilePath(), "utf8");
    expect(cache).not.toContain("synthetic-a-token");
    const record = (
      JSON.parse(cache) as {
        providers: { reuse?: { context: string; inputsDigest: string } }[];
      }
    ).providers[0]!;
    expect(record.reuse?.context).toMatch(/^[a-f0-9]{64}$/);
    expect(record.reuse?.inputsDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("live --tui", () => {
  const ttys = [process.stdout, process.stdin].map((stream) => ({
    stream,
    descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
  }));

  afterEach(() => {
    for (const { stream, descriptor } of ttys) {
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
      else delete (stream as { isTTY?: boolean }).isTTY;
    }
    process.stdin.pause();
    vi.restoreAllMocks();
  });

  it("reads the vendor on every scheduled frame at --refresh 30s", async () => {
    for (const { stream } of ttys)
      Object.defineProperty(stream, "isTTY", {
        configurable: true,
        value: true,
      });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const realSetTimeout = globalThis.setTimeout;
    const ticks: Array<() => void> = [];
    vi.stubGlobal("setTimeout", ((callback: () => void, ms?: number) =>
      ms === 30_000
        ? (ticks.push(callback), 0)
        : realSetTimeout(callback, ms)) as typeof setTimeout);
    const nextTick = async (): Promise<() => void> => {
      while (ticks.length === 0)
        await new Promise((resolve) => realSetTimeout(resolve, 5));
      return ticks.shift()!;
    };

    const report = quotaCommand(
      [
        "--provider",
        "claude",
        "--tui",
        "--refresh",
        "30s",
        "--no-credential-refresh",
      ],
      undefined,
    );
    for (let frame = 0; frame < 2; frame++) {
      const tick = await nextTick();
      advance(30);
      tick();
    }
    await nextTick();
    process.stdin.emit("data", "q");
    await report;

    expect(usageCalls).toBe(3);
  });
});

describe("QUOTA_AXI_SNAPSHOT", () => {
  function writeSnapshot(resetsAt: string): string {
    const file = join(root, "snapshot.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 3,
        providers: [
          {
            provider: "claude",
            label: "Claude",
            source: "oauth",
            windows: [
              {
                id: "seven_day",
                label: "week",
                kind: "weekly",
                percentUsed: 25,
                percentRemaining: 75,
                windowSeconds: 604_800,
                resetsAt,
              },
            ],
            state: {
              status: "fresh",
              stale: false,
              refreshedAt: "2026-09-20T00:00:00.000Z",
              sourcesTried: ["oauth-file"],
            },
          },
        ],
      }),
    );
    return file;
  }

  it("answers from the supplied file without a credential, vendor call, or cache write", async () => {
    process.env.QUOTA_AXI_SNAPSHOT = writeSnapshot("2026-09-26T00:00:00Z");
    rmSync(join(root, "profile-a"), { recursive: true, force: true });

    const claude = await readJson("--full");

    expect(usageCalls).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(claude).toMatchObject({
      source: "oauth",
      windows: [{ id: "seven_day", percentRemaining: 75 }],
      state: {
        status: "fresh",
        reused: true,
        refreshedAt: "2026-09-20T00:00:00.000Z",
        sourcesTried: ["snapshot"],
      },
    });
    expect(() => readFileSync(cacheFilePath())).toThrow();
  });

  it("reports a provider the file does not name as unavailable instead of reading it", async () => {
    process.env.QUOTA_AXI_SNAPSHOT = writeSnapshot("2026-09-26T00:00:00Z");
    const output = JSON.parse(
      await quotaCommand(["--provider", "codex", "--json"], undefined),
    ) as QuotaAxiResponse;

    expect(output.providers[0]).toMatchObject({
      provider: "codex",
      windows: [],
      state: { status: "unavailable", error: "not_in_snapshot" },
    });
    expect(process.exitCode).toBe(1);
  });

  it("never serves a snapshot window whose reset has passed", async () => {
    process.env.QUOTA_AXI_SNAPSHOT = writeSnapshot("2026-09-22T00:00:00Z");
    const claude = await readJson();

    expect(usageCalls).toBe(0);
    expect(claude).toMatchObject({
      windows: [],
      state: { status: "unavailable", error: "snapshot_expired" },
    });
  });

  it("cannot be combined with --profile-only", async () => {
    process.env.QUOTA_AXI_SNAPSHOT = writeSnapshot("2026-09-26T00:00:00Z");
    await expect(readJson("--profile-only")).rejects.toThrow(
      /--profile-only cannot be combined with QUOTA_AXI_SNAPSHOT/,
    );
  });

  it("rejects a snapshot path that does not exist", async () => {
    process.env.QUOTA_AXI_SNAPSHOT = join(root, "missing.json");
    await expect(readJson()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/QUOTA_AXI_SNAPSHOT is not a readable/),
    });
    expect(usageCalls).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a snapshot file that is not a quota cache file", async () => {
    const file = join(root, "snapshot.json");
    writeFileSync(file, "{ not json");
    process.env.QUOTA_AXI_SNAPSHOT = file;
    await expect(readJson()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/QUOTA_AXI_SNAPSHOT is not a readable/),
    });
    writeFileSync(file, JSON.stringify({ providers: "none" }));
    await expect(readJson()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(usageCalls).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a snapshot file holding a provider record that does not parse", async () => {
    const file = writeSnapshot("2026-09-26T00:00:00Z");
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as {
      providers: Record<string, unknown>[];
    };
    const [claude] = snapshot.providers;
    process.env.QUOTA_AXI_SNAPSHOT = file;

    writeFileSync(
      file,
      JSON.stringify({ ...snapshot, providers: [{ ...claude, windows: [] }] }),
    );
    await expect(readJson()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/QUOTA_AXI_SNAPSHOT is not a readable/),
    });

    writeFileSync(
      file,
      JSON.stringify({
        ...snapshot,
        providers: [claude, { ...claude, provider: "codex", label: 7 }],
      }),
    );
    await expect(readJson()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(usageCalls).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("reuse across account lanes", () => {
  let usage: Record<string, number | "fail">;
  let codexCalls: number;

  beforeEach(() => {
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
      JSON.stringify({
        "openai-codex": piEntry("acct-personal"),
        "openai-codex-work": piEntry("acct-work"),
      }),
    );
    usage = { "acct-personal": 20, "acct-work": 80 };
    codexCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        codexCalls++;
        const account = new Headers(init?.headers).get("ChatGPT-Account-Id");
        const used = account ? usage[account] : undefined;
        if (used === undefined) return new Response("{}", { status: 404 });
        if (used === "fail") return new Response("{}", { status: 503 });
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            account_id: account,
            rate_limit: {
              primary_window: {
                used_percent: used,
                limit_window_seconds: 604_800,
                reset_after_seconds: 86_400,
              },
            },
          }),
          { status: 200 },
        );
      }),
    );
  });

  function piEntry(accountId: string) {
    return {
      type: "oauth",
      access: `synthetic-${accountId}-token`,
      refresh: `synthetic-${accountId}-refresh`,
      expires: Date.parse("2035-01-01T00:00:00Z"),
      accountId,
    };
  }

  async function readCodex(
    ...flags: string[]
  ): Promise<QuotaAxiResponse["providers"]> {
    const output = await quotaCommand(
      ["--provider", "codex", "--json", "--no-credential-refresh", ...flags],
      undefined,
    );
    return (JSON.parse(output) as QuotaAxiResponse).providers;
  }

  it("serves every lane of a complete reading in declaration order", async () => {
    await readCodex();
    expect(codexCalls).toBe(2);
    advance(10);

    const reused = await readCodex();

    expect(codexCalls).toBe(2);
    expect(reused.map((reading) => reading.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(reused).toMatchObject([
      { windows: [{ percentRemaining: 80 }], state: { reused: true } },
      { windows: [{ percentRemaining: 20 }], state: { reused: true } },
    ]);
  });

  it("never serves part of a reading when one lane failed", async () => {
    usage["acct-work"] = "fail";
    await readCodex();
    usage["acct-work"] = 85;
    codexCalls = 0;
    advance(10);

    const read = await readCodex();

    expect(codexCalls).toBe(2);
    expect(read.map((reading) => reading.state.reused)).toEqual([
      undefined,
      undefined,
    ]);
    expect(read[1]).toMatchObject({ windows: [{ percentRemaining: 15 }] });
  });

  it("never serves a cached reading that carries no reuse record", async () => {
    await readCodex();
    const cache = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: Record<string, unknown>[];
    };
    for (const record of cache.providers) delete record.reuse;
    writeFileSync(cacheFilePath(), JSON.stringify(cache));
    advance(10);

    const read = await readCodex();

    expect(codexCalls).toBe(4);
    expect(read.map((reading) => reading.state.reused)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keeps a later stale fallback free of reuse-only state", async () => {
    await readCodex();
    usage["acct-personal"] = "fail";
    advance(120);

    const [personal] = await readCodex();

    expect(personal).toMatchObject({
      accountKey: "openai-codex",
      windows: [{ percentRemaining: 80 }],
      state: { status: "stale", stale: true },
    });
    expect(personal!.state).not.toHaveProperty("reused");
  });
});
