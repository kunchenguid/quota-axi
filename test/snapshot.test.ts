import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCachedProviders } from "../src/cache.js";
import { normalizeAgyQuotaSummary } from "../src/providers/agy.js";
import {
  buildWatchSnapshot,
  deriveBurnRate,
  getWatchSnapshot,
  levelForRemaining,
  selectPrimaryWindow,
  toSnapshotWindow,
} from "../src/snapshot.js";
import type { ProviderId, ProviderQuota, QuotaWindow } from "../src/types.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("buildWatchSnapshot", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("maps agy fixture windows into render-ready fields", () => {
    const normalized = normalizeAgyQuotaSummary(
      fixture("agy/quota-summary.json"),
    );
    expect(normalized?.windows.length).toBeGreaterThan(0);

    const provider = quota("agy", {
      plan: "Google AI Pro",
      windows: normalized!.windows,
      status: "stale",
      source: "cache",
      stale: true,
      refreshedAt: "2026-07-09T10:00:00.000Z",
    });

    const snapshot = buildWatchSnapshot([provider], {
      mode: "cache",
      now,
      generatedAt: "2026-07-09T12:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      mode: "cache",
      generatedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(snapshot.providers).toHaveLength(1);
    const agy = snapshot.providers[0];
    expect(agy.trust).toBe("stale");
    expect(agy.windows.map((window) => window.id)).toEqual(
      normalized!.windows.map((window) => window.id),
    );
    expect(agy.primary?.kind).toBe("session");
    for (const window of agy.windows) {
      expect(window.level).toMatch(/^(ok|warn|critical)$/);
      expect(window.resetInSeconds === null || window.resetInSeconds > 0).toBe(
        true,
      );
      // Fixture resets are historical relative to `now`, so burn stays honest.
      if (window.resetsAt && Date.parse(window.resetsAt) <= now.getTime()) {
        expect(window.burnRate).toEqual({
          available: false,
          reason: "insufficient_data",
        });
        expect(window.resetInSeconds).toBeNull();
      }
    }
  });

  it("marks missing remaining levels and burn honestly", () => {
    const provider = quota("claude", {
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          kind: "session",
          percentRemaining: 5,
          percentUsed: 95,
        },
        {
          id: "weekly",
          label: "weekly",
          kind: "weekly",
          percentRemaining: 20,
          percentUsed: 80,
          resetsAt: "not-a-date",
        },
      ],
      status: "fresh",
      source: "oauth",
    });

    const snapshot = buildWatchSnapshot([provider], {
      mode: "refresh",
      now,
    });
    const [critical, warn] = snapshot.providers[0].windows;
    expect(critical.level).toBe("critical");
    expect(critical.burnRate).toEqual({
      available: false,
      reason: "insufficient_data",
    });
    expect(critical.resetInSeconds).toBeNull();
    expect(warn.level).toBe("warn");
    expect(warn.burnRate).toEqual({
      available: false,
      reason: "insufficient_data",
    });
    expect(snapshot.providers[0].trust).toBe("fresh");
    expect(snapshot.providers[0].primary?.id).toBe("five_hour");
  });

  it("returns unavailable trust for auth failures with empty windows", () => {
    const provider = quota("codex", {
      windows: [],
      status: "auth_required",
      source: "unavailable",
      error: "credentials_missing",
    });
    const snapshot = buildWatchSnapshot([provider], { mode: "cache", now });
    expect(snapshot.providers[0]).toMatchObject({
      trust: "unavailable",
      status: "auth_required",
      windows: [],
      error: "credentials_missing",
    });
    expect(snapshot.providers[0].primary).toBeUndefined();
  });
});

describe("getWatchSnapshot", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("defaults to cache mode and never fetches providers", async () => {
    useTempCache();
    writeCachedProviders([
      quota("claude", {
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            kind: "session",
            percentUsed: 40,
            percentRemaining: 60,
            resetsAt: "2026-07-09T15:00:00.000Z",
            windowSeconds: 18000,
          },
        ],
        status: "fresh",
        source: "oauth",
        refreshedAt: "2026-07-09T11:00:00.000Z",
      }),
    ]);

    const fetchProvider = vi.fn();
    const snapshot = await getWatchSnapshot(
      { providers: ["claude", "agy"], now },
      { fetchProvider },
    );

    expect(fetchProvider).not.toHaveBeenCalled();
    expect(snapshot.mode).toBe("cache");
    expect(snapshot.providers.map((item) => item.provider)).toEqual([
      "claude",
      "agy",
    ]);
    expect(snapshot.providers[0].trust).toBe("cached");
    expect(snapshot.providers[1]).toMatchObject({
      provider: "agy",
      trust: "unavailable",
      error: "cache_miss",
      windows: [],
    });
  });

  it("refresh mode fetches, writes cache, and marks trust fresh", async () => {
    useTempCache();
    const live = quota("agy", {
      windows: [
        {
          id: "gemini_5h",
          label: "Gemini 5-hour",
          kind: "session",
          percentUsed: 10,
          percentRemaining: 90,
          resetsAt: "2026-07-09T16:00:00.000Z",
          windowSeconds: 18000,
        },
      ],
      status: "fresh",
      source: "api",
      refreshedAt: "2026-07-09T12:00:00.000Z",
    });
    const fetchProvider = vi.fn().mockResolvedValue(live);
    const writeCache = vi.fn();

    const snapshot = await getWatchSnapshot(
      { providers: ["agy"], refresh: true, now },
      { fetchProvider, writeCache, nowIso: () => "2026-07-09T12:00:00.000Z" },
    );

    expect(fetchProvider).toHaveBeenCalledOnce();
    expect(writeCache).toHaveBeenCalledWith([live]);
    expect(snapshot).toMatchObject({
      mode: "refresh",
      generatedAt: "2026-07-09T12:00:00.000Z",
      providers: [{ provider: "agy", trust: "fresh", status: "fresh" }],
    });
  });
});

describe("snapshot helpers", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("derives burn rate only with elapsed window data", () => {
    const window: QuotaWindow = {
      id: "session",
      label: "session",
      kind: "session",
      percentUsed: 9,
      resetsAt: "2026-07-09T17:00:00.000Z",
      windowSeconds: 36000,
    };
    expect(deriveBurnRate(window, now)).toEqual({
      available: true,
      percentPerHour: 1.8,
    });
    expect(
      deriveBurnRate({ ...window, windowSeconds: undefined }, now),
    ).toEqual({ available: false, reason: "insufficient_data" });
    expect(deriveBurnRate({ ...window, windowSeconds: 18000 }, now)).toEqual({
      available: false,
      reason: "insufficient_data",
    });
  });

  it("classifies remaining thresholds", () => {
    expect(levelForRemaining(undefined)).toBe("ok");
    expect(levelForRemaining(50)).toBe("ok");
    expect(levelForRemaining(25)).toBe("warn");
    expect(levelForRemaining(10)).toBe("critical");
    expect(levelForRemaining(0)).toBe("critical");
  });

  it("selects the most urgent session window as primary", () => {
    const windows = [
      toSnapshotWindow(
        {
          id: "weekly",
          label: "weekly",
          kind: "weekly",
          percentRemaining: 5,
        },
        now,
      ),
      toSnapshotWindow(
        {
          id: "session_ok",
          label: "session ok",
          kind: "session",
          percentRemaining: 40,
        },
        now,
      ),
      toSnapshotWindow(
        {
          id: "session_low",
          label: "session low",
          kind: "session",
          percentRemaining: 12,
        },
        now,
      ),
    ];
    expect(selectPrimaryWindow(windows)?.id).toBe("session_low");
  });
});

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-snapshot-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"),
  ) as unknown;
}

function quota(
  provider: ProviderId,
  args: {
    windows: QuotaWindow[];
    status: ProviderQuota["state"]["status"];
    source: ProviderQuota["source"];
    plan?: string;
    stale?: boolean;
    refreshedAt?: string;
    error?: string;
  },
): ProviderQuota {
  return {
    provider,
    label: providerLabel(provider),
    source: args.source,
    plan: args.plan,
    windows: args.windows,
    state: {
      status: args.status,
      stale: args.stale ?? false,
      refreshedAt: args.refreshedAt,
      error: args.error,
      sourcesTried: [args.source],
    },
  };
}

function providerLabel(provider: ProviderId): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "cursor") return "Cursor";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "agy") return "Antigravity";
  return "Grok";
}
