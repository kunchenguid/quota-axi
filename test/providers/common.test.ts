import { describe, expect, it } from "vitest";
import {
  servableStaleWindows,
  staleFromCache,
  statusFromError,
} from "../../src/providers/common.js";
import type { ProviderQuota, QuotaWindow } from "../../src/types.js";

describe("shared statusFromError", () => {
  it("keeps access-token-expired phrasing on the shared auth_required path", () => {
    // Grok soft-expiry must not change this shared helper; provider-specific
    // classification belongs in the Grok adapter (grokStatusForAuthFailure).
    expect(statusFromError("Grok access token expired")).toBe("auth_required");
    expect(statusFromError("OAuth access token expired")).toBe("auth_required");
    expect(statusFromError("Codex sign-in required")).toBe("auth_required");
    expect(statusFromError("provider rate limited")).toBe("rate_limited");
    expect(statusFromError("quota unavailable")).toBe("error");
  });
});

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function window(
  id: string,
  kind: QuotaWindow["kind"],
  extra: Partial<QuotaWindow> = {},
): QuotaWindow {
  return {
    id,
    label: id,
    kind,
    percentUsed: 40,
    percentRemaining: 60,
    ...extra,
  };
}

function cached(
  windows: QuotaWindow[],
  refreshedAt: number | null = NOW - HOUR_MS,
): ProviderQuota {
  return {
    provider: "grok",
    label: "Grok",
    source: "web",
    windows,
    state: {
      status: "fresh",
      stale: false,
      sourcesTried: ["web"],
      ...(refreshedAt === null
        ? {}
        : { refreshedAt: new Date(refreshedAt).toISOString() }),
    },
  };
}

function servedIds(
  windows: QuotaWindow[],
  refreshedAt?: number | null,
  resetless?: "age_bound" | "never",
): string[] {
  return servableStaleWindows(cached(windows, refreshedAt), NOW, resetless).map(
    ({ id }) => id,
  );
}

describe("shared stale cache bound", () => {
  it("drops a window whose own reset is at or before now", () => {
    const windows = [
      window("past", "weekly", { resetsAt: new Date(NOW - 1).toISOString() }),
      window("at", "weekly", { resetsAt: new Date(NOW).toISOString() }),
      window("ahead", "weekly", { resetsAt: new Date(NOW + 1).toISOString() }),
    ];
    expect(servedIds(windows)).toEqual(["ahead"]);
  });

  it("keeps a window whose reset is ahead however old the snapshot", () => {
    const windows = [
      window("monthly", "monthly", {
        resetsAt: new Date(NOW + DAY_MS).toISOString(),
      }),
    ];
    expect(servedIds(windows, NOW - 25 * DAY_MS)).toEqual(["monthly"]);
  });

  it("ages a resetless window by its declared duration first", () => {
    const windows = [window("hourly", "unknown", { windowSeconds: 3_600 })];
    expect(servedIds(windows, NOW - HOUR_MS + 1)).toEqual(["hourly"]);
    expect(servedIds(windows, NOW - HOUR_MS)).toEqual([]);
  });

  it("ages a resetless window by the shortest cycle its kind admits", () => {
    const windows = [
      window("session", "session"),
      window("weekly", "weekly"),
      window("monthly", "monthly"),
    ];
    expect(servedIds(windows, NOW - 5 * HOUR_MS + 1)).toEqual([
      "session",
      "weekly",
      "monthly",
    ]);
    expect(servedIds(windows, NOW - 5 * HOUR_MS)).toEqual([
      "weekly",
      "monthly",
    ]);
    expect(servedIds(windows, NOW - 7 * DAY_MS)).toEqual(["monthly"]);
    expect(servedIds(windows, NOW - 28 * DAY_MS + 1)).toEqual(["monthly"]);
    expect(servedIds(windows, NOW - 28 * DAY_MS)).toEqual([]);
  });

  it("never serves a resetless window with no known cycle", () => {
    const windows = [
      window("credits", "credits"),
      window("model", "model"),
      window("unknown", "unknown"),
    ];
    expect(servedIds(windows, NOW - 1)).toEqual([]);
  });

  it("uses the declared duration over a malformed reset", () => {
    const windows = [window("session", "session", { resetsAt: "not a date" })];
    expect(servedIds(windows, NOW - HOUR_MS)).toEqual(["session"]);
    expect(servedIds(windows, NOW - 5 * HOUR_MS)).toEqual([]);
  });

  it("drops every resetless window when the snapshot's age is unknown", () => {
    const windows = [
      window("session", "session"),
      window("ahead", "weekly", { resetsAt: new Date(NOW + 1).toISOString() }),
    ];
    expect(servedIds(windows, null)).toEqual(["ahead"]);
  });

  it("serves nothing when the snapshot was written in the future", () => {
    // A clock that ran ahead at write time and was later corrected leaves the
    // snapshot's age unknowable, so even a reset-bearing window is withheld.
    const windows = [
      window("monthly", "monthly"),
      window("ahead", "weekly", { resetsAt: new Date(NOW + 1).toISOString() }),
    ];
    expect(servedIds(windows, NOW + 30 * DAY_MS)).toEqual([]);
    expect(
      staleFromCache(
        cached(windows, NOW + 1),
        "fetch failed",
        ["web"],
        [],
        NOW,
      ),
    ).toBe(undefined);
  });

  it("serves only reset-bearing windows under the never policy", () => {
    const windows = [
      window("session", "session"),
      window("ahead", "weekly", { resetsAt: new Date(NOW + 1).toISOString() }),
    ];
    expect(servedIds(windows, NOW - 1, "never")).toEqual(["ahead"]);
  });

  it("returns no stale report when no cached window survives", () => {
    const expired = cached([
      window("weekly", "weekly", { resetsAt: new Date(NOW).toISOString() }),
    ]);
    expect(staleFromCache(expired, "fetch failed", ["web"], [], NOW)).toBe(
      undefined,
    );
  });

  it("serves the surviving windows as a stale reading", () => {
    const report = staleFromCache(
      cached([
        window("expired", "weekly", { resetsAt: new Date(NOW).toISOString() }),
        window("ahead", "weekly", {
          resetsAt: new Date(NOW + DAY_MS).toISOString(),
        }),
      ]),
      "fetch failed",
      ["web"],
      [],
      NOW,
    );
    expect(report).toMatchObject({
      source: "cache",
      windows: [{ id: "ahead", percentRemaining: 60 }],
      state: {
        status: "stale",
        stale: true,
        error: "fetch failed",
        sourcesTried: ["web", "cache"],
      },
    });
    expect(report?.windows).toHaveLength(1);
  });

  it("drops untrusted ids only for the windows the filter removed", () => {
    const snapshot = cached([
      window("limit:1", "unknown"),
      window("ahead", "weekly", {
        resetsAt: new Date(NOW + DAY_MS).toISOString(),
      }),
    ]);
    snapshot.state.untrustedWindowIds = ["limit:1", "usages:limit_5h"];
    const report = staleFromCache(snapshot, "fetch failed", ["web"], [], NOW);
    expect(report?.windows.map(({ id }) => id)).toEqual(["ahead"]);
    expect(report?.state.untrustedWindowIds).toEqual(["usages:limit_5h"]);

    snapshot.state.untrustedWindowIds = ["limit:1"];
    const pruned = staleFromCache(snapshot, "fetch failed", ["web"], [], NOW);
    expect(pruned?.state).not.toHaveProperty("untrustedWindowIds");
  });
});
