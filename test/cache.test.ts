import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteCachedProvider,
  readCachedProvider,
  writeCachedProviders,
} from "../src/cache.js";
import { cacheFilePath } from "../src/lib/fs.js";
import type { ProviderId, ProviderQuota } from "../src/types.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("quota cache", () => {
  it("ignores malformed matching entries", () => {
    useTempCache();
    const file = cacheFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        generatedAt: "x",
        schemaVersion: 1,
        providers: [{ provider: "claude" }],
      }),
    );

    expect(() => readCachedProvider("claude")).not.toThrow();
    expect(readCachedProvider("claude")).toBeUndefined();
  });

  it("invalidates Codex identities that do not exactly match duration", () => {
    useTempCache();
    const file = cacheFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const invalidWindows = [
      {
        id: "seven_day",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        windowSeconds: 600_000,
      },
      {
        id: "model:preview:7d",
        label: "Preview week",
        kind: "model",
        windowSeconds: 18_000,
      },
      {
        id: "weekly_2",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
    ];

    for (const window of invalidWindows) {
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          providers: [{ ...quota("codex", 20), windows: [window] }],
        }),
      );

      expect(readCachedProvider("codex")).toBeUndefined();
    }
  });

  it("retains exact known and unfamiliar Codex cache identities", () => {
    useTempCache();
    const codex = quota("codex", 20);
    codex.windows = [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        windowSeconds: 18_000,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
      {
        id: "weekly_2",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
      {
        id: "model:preview:window:166.67h",
        label: "Preview 166.67h window",
        kind: "model",
        windowSeconds: 600_000,
      },
    ];
    writeCachedProviders([codex]);

    expect(readCachedProvider("codex")?.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "weekly",
      "weekly_2",
      "model:preview:window:166.67h",
    ]);
  });

  it("merges fresh provider snapshots into existing cache", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("codex", 20)]);
    writeCachedProviders([quota("claude", 30)]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: ProviderQuota[];
    };

    expect(payload.providers.map((provider) => provider.provider)).toEqual([
      "claude",
      "codex",
    ]);
    expect(
      payload.providers.find((provider) => provider.provider === "claude")
        ?.windows[0].percentUsed,
    ).toBe(30);
    expect(
      payload.providers.find((provider) => provider.provider === "codex")
        ?.windows[0].percentUsed,
    ).toBe(20);
    expect(payload.providers.every((provider) => !provider.account)).toBe(true);
  });

  it("writes normalized cache data with mode 0600 and no attempts or sentinel secret", () => {
    useTempCache();
    const sentinel = "CACHE-SENTINEL-KIMI-612704";
    const kimi = {
      ...quota("kimi", 37.5),
      source: "api" as const,
      state: {
        ...quota("kimi", 37.5).state,
        untrustedWindowIds: ["limit:2"],
        sourcesTried: ["pi:kimi-coding"],
      },
      attempts: [
        {
          source: "pi:kimi-coding",
          status: "success" as const,
          error: sentinel,
        },
      ],
    };

    writeCachedProviders([kimi]);

    const bytes = readFileSync(cacheFilePath(), "utf8");
    expect(statSync(cacheFilePath()).mode & 0o777).toBe(0o600);
    expect(bytes).not.toContain(sentinel);
    expect(bytes).not.toContain("attempts");
    expect(bytes).not.toContain("account");
    expect(readCachedProvider("kimi")?.windows[0].percentUsed).toBe(37.5);
    expect(readCachedProvider("kimi")?.state.untrustedWindowIds).toEqual([
      "limit:2",
    ]);
  });

  it("retains trusted cycle evidence but never caches derived pace", () => {
    useTempCache();
    const claude = quota("claude", 40);
    claude.windows[0] = {
      ...claude.windows[0],
      percentRemaining: 60,
      startsAt: "2026-07-06T15:00:00Z",
      resetsAt: "2026-07-06T20:00:00Z",
      windowSeconds: 18_000,
      pace: {
        status: "ahead",
        reservePercentPoints: -20,
        projectionBasis: "cycle_average",
      },
    };

    writeCachedProviders([claude]);

    const bytes = readFileSync(cacheFilePath(), "utf8");
    const cachedWindow = readCachedProvider("claude")?.windows[0];
    expect(bytes).not.toContain('"pace"');
    expect(cachedWindow).toMatchObject({
      startsAt: "2026-07-06T15:00:00Z",
      resetsAt: "2026-07-06T20:00:00Z",
      windowSeconds: 18_000,
    });
    expect(cachedWindow?.pace).toBeUndefined();
  });

  it("deletes a definitive-auth provider while retaining other snapshots", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("kimi", 20)]);

    deleteCachedProvider("kimi");

    expect(readCachedProvider("kimi")).toBeUndefined();
    expect(readCachedProvider("claude")?.windows[0].percentUsed).toBe(10);
    expect(statSync(cacheFilePath()).mode & 0o777).toBe(0o600);
  });

  it("clears a stale snapshot after a fresh no-window report", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("copilot", 20)]);
    writeCachedProviders([quotaWithoutWindows("copilot")]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: ProviderQuota[];
    };

    expect(payload.providers.map((provider) => provider.provider)).toEqual([
      "claude",
    ]);
    expect(readCachedProvider("copilot")).toBeUndefined();
  });

  it("round-trips a normalized Antigravity cli-print snapshot without identity", () => {
    useTempCache();
    const antigravity: ProviderQuota = {
      provider: "antigravity",
      label: "Antigravity",
      source: "cli-print",
      windows: [
        {
          id: "group:consumer/bucket:session",
          label: "Session",
          kind: "session",
          percentRemaining: 75,
          resetsAt: "2026-08-09T12:00:00.000Z",
        },
      ],
      plan: "must-not-cache-plan",
      credits: { remaining: 12, unit: "credits" },
      account: { email: "must-not-cache@example.invalid" },
      attempts: [{ source: "cli-print", status: "success" }],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-08-09T08:00:00.000Z",
        sourcesTried: ["cli-print"],
      },
    };

    writeCachedProviders([antigravity]);

    const cached = readCachedProvider("antigravity");
    expect(cached?.source).toBe("cli-print");
    expect(cached?.windows[0]?.percentRemaining).toBe(75);
    expect(cached?.account).toBeUndefined();
    expect(cached?.attempts).toBeUndefined();
    expect(cached?.plan).toBeUndefined();
    expect(cached?.credits).toBeUndefined();
    const bytes = readFileSync(cacheFilePath(), "utf8");
    expect(bytes).not.toContain("must-not-cache-plan");
    expect(bytes).not.toContain("credits");
  });

  it("rejects Antigravity cache writes and entries with non-print provenance", () => {
    useTempCache();
    for (const source of ["api", "web", "cli-rpc", "cache"] as const) {
      writeCachedProviders([{ ...cachedAntigravity(), source }]);
      expect(readCachedProvider("antigravity")).toBeUndefined();
    }

    mkdirSync(dirname(cacheFilePath()), { recursive: true });
    writeFileSync(
      cacheFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        providers: [
          {
            ...cachedAntigravity(),
            source: "cli-print",
            state: {
              ...cachedAntigravity().state,
              status: "stale",
              stale: true,
            },
          },
          {
            ...cachedAntigravity(),
            source: "api",
          },
          {
            ...cachedAntigravity(),
            plan: "crafted-forbidden-plan",
          },
        ],
      }),
    );
    expect(readCachedProvider("antigravity")).toBeUndefined();
  });

  it("retires a prior Antigravity snapshot when a fresh report has only untrusted windows", () => {
    useTempCache();
    writeCachedProviders([antigravityWindow("trusted", false)]);
    writeCachedProviders([antigravityWindow("invalid", true)]);

    expect(readCachedProvider("antigravity")).toBeUndefined();
  });

  it("caches a mixed Antigravity report with trusted and diagnostic windows", () => {
    useTempCache();
    const trusted = antigravityWindow("trusted", false);
    const invalid = antigravityWindow("invalid", true);
    writeCachedProviders([
      {
        ...trusted,
        windows: [...trusted.windows, ...invalid.windows],
        state: { ...trusted.state, untrustedWindowIds: ["invalid"] },
      },
    ]);

    const cached = readCachedProvider("antigravity");
    expect(cached?.windows).toHaveLength(2);
    expect(
      cached?.windows.find(({ id }) => id === "invalid")?.percentRemaining,
    ).toBeUndefined();
    expect(cached?.state.untrustedWindowIds).toEqual(["invalid"]);
  });

  it("caches an Antigravity diagnostic window when its percentage is valid", () => {
    useTempCache();
    const diagnostic = antigravityWindow("unknown-period", true);
    diagnostic.windows[0] = {
      ...diagnostic.windows[0],
      percentRemaining: 65,
      percentUsed: 35,
    };

    writeCachedProviders([diagnostic]);

    const cached = readCachedProvider("antigravity");
    expect(cached?.windows).toHaveLength(1);
    expect(cached?.windows[0]?.kind).toBe("unknown");
    expect(cached?.windows[0]?.percentRemaining).toBe(65);
    expect(cached?.state.untrustedWindowIds).toEqual(["unknown-period"]);
  });
});

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

function quota(provider: ProviderId, percentUsed: number): ProviderQuota {
  return {
    provider,
    label: providerLabel(provider),
    source: "oauth",
    windows: [
      { id: "five_hour", label: "session", kind: "session", percentUsed },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["oauth"],
    },
    account: {
      email: "person@example.invalid",
      accountId: "fixture-account",
      identityStatus: "verified",
    },
    attempts: [{ source: "oauth", status: "success" }],
  };
}

function quotaWithoutWindows(provider: ProviderId): ProviderQuota {
  return {
    ...quota(provider, 0),
    windows: [],
  };
}

function antigravityWindow(id: string, untrusted: boolean): ProviderQuota {
  return {
    provider: "antigravity",
    label: "Antigravity",
    source: "cli-print",
    windows: [
      {
        id,
        label: id,
        kind: "unknown",
        ...(untrusted ? {} : { percentRemaining: 80, percentUsed: 20 }),
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      sourcesTried: ["cli-print"],
      ...(untrusted ? { untrustedWindowIds: [id] } : {}),
    },
  };
}

function cachedAntigravity(): ProviderQuota {
  return {
    provider: "antigravity",
    label: "Antigravity",
    source: "cli-print",
    windows: [
      {
        id: "consumer/session",
        label: "Session",
        kind: "session",
        percentRemaining: 75,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-08-09T08:00:00.000Z",
      sourcesTried: ["cli-print"],
    },
  };
}

function providerLabel(provider: ProviderId): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "cursor") return "Cursor";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "grok") return "Grok";
  if (provider === "antigravity") return "Antigravity";
  return "Kimi";
}
