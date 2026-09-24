import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCachedProvider,
  readReusableProviders,
  stampReadingInputs,
  writeCachedProviders,
} from "../src/cache.js";
import { quotaCommand } from "../src/commands.js";
import { cacheFilePath } from "../src/lib/fs.js";
import { inputsDigest } from "../src/lib/input-trace.js";
import type { ProviderQuota, QuotaAxiResponse } from "../src/types.js";

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
    "QUOTA_AXI_SNAPSHOT",
  ].map((name) => [name, process.env[name]]),
);
let root: string;
let usageCalls: number;
let usagePercent: number;

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
  useProfile("a");
  usageCalls = 0;
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
});

describe("reuse stamps across account lanes", () => {
  function lane(accountKey: string, fresh = true): ProviderQuota {
    return {
      provider: "codex",
      accountKey,
      accountKeys: [accountKey],
      label: "Codex",
      source: "oauth",
      windows: fresh
        ? [
            {
              id: "weekly",
              label: "week",
              kind: "weekly",
              percentUsed: 10,
              percentRemaining: 90,
              windowSeconds: 604_800,
              resetsAt: "2026-09-29T00:00:00Z",
            },
          ]
        : [],
      state: fresh
        ? {
            status: "fresh",
            stale: false,
            refreshedAt: START,
            sourcesTried: ["auth-json"],
          }
        : {
            status: "error",
            stale: false,
            error: "network_unavailable",
            sourcesTried: ["auth-json"],
          },
    };
  }

  function traced(lanes: ProviderQuota[]): ProviderQuota[] {
    const inputs = { paths: [], digest: inputsDigest([]) };
    for (const reading of lanes) stampReadingInputs(reading, inputs);
    return lanes;
  }

  it("serves every lane of a complete reading in declaration order", () => {
    writeCachedProviders(traced([lane("pi:b"), lane("codex-home")]), START);
    const reused = readReusableProviders("codex", 90);
    expect(reused?.map((reading) => reading.accountKey)).toEqual([
      "pi:b",
      "codex-home",
    ]);
    expect(reused?.[0]).toMatchObject({
      accountKeys: ["pi:b"],
      state: { status: "fresh", reused: true },
    });
  });

  it("never serves part of a reading when one lane failed", () => {
    writeCachedProviders(
      traced([lane("pi:b"), lane("codex-home", false)]),
      START,
    );
    expect(readReusableProviders("codex", 90)).toBeUndefined();
  });

  it("never serves a reading nothing traced", () => {
    writeCachedProviders([lane("pi:b")], START);
    expect(readReusableProviders("codex", 90)).toBeUndefined();
  });

  it("keeps the stale-fallback snapshot free of reuse-only state", () => {
    const reading = lane("pi:b");
    reading.state.authStatus = "usable";
    writeCachedProviders(traced([reading]), START);
    expect(readCachedProvider("codex", "pi:b")?.state).not.toHaveProperty(
      "authStatus",
    );
    expect(readCachedProvider("codex", "pi:b")?.state).not.toHaveProperty(
      "reused",
    );
  });
});
