import { describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { normalizeCursorUsage } from "../../src/providers/cursor.js";
import type { ProviderQuota, QuotaWindow } from "../../src/types.js";

function cursorProvider(windows: QuotaWindow[]): ProviderQuota {
  return {
    provider: "cursor",
    label: "Cursor",
    source: "api",
    windows,
    state: { status: "fresh", stale: false, sourcesTried: ["api"] },
  };
}

describe("Cursor quota parsing", () => {
  it("normalizes current-period plan usage windows", () => {
    const result = normalizeCursorUsage(
      {
        billingCycleEnd: "1783036800000",
        planUsage: {
          totalPercentUsed: 42.5,
          autoPercentUsed: 12,
          apiPercentUsed: "7",
        },
        spendLimitUsage: {
          individualLimit: 2500,
          individualUsed: 625,
        },
      },
      {
        planInfo: {
          planName: "pro",
        },
      },
      {
        email: "person@example.invalid",
      },
    );

    expect(result?.plan).toBe("pro");
    expect(result?.account?.email).toBe("person@example.invalid");
    expect(result?.windows).toMatchObject([
      {
        id: "included_usage",
        label: "included usage",
        kind: "monthly",
        percentUsed: 43,
        percentRemaining: 57,
        resetsAt: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "auto_usage",
        label: "auto usage",
        kind: "monthly",
        percentUsed: 12,
        percentRemaining: 88,
      },
      {
        id: "api_usage",
        label: "API usage",
        kind: "monthly",
        percentUsed: 7,
        percentRemaining: 93,
      },
      {
        id: "spend_limit",
        label: "spend limit",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        spentUsd: 6.25,
        limitUsd: 25,
      },
    ]);
  });

  it("returns undefined when Cursor exposes no numeric quota windows", () => {
    expect(normalizeCursorUsage({ planUsage: {} })).toBeUndefined();
  });
});

describe("Cursor monthly billing cycle", () => {
  it("uses a reported billing cycle start for the monthly windows", () => {
    const result = normalizeCursorUsage({
      billingCycleStart: "2026-06-03T00:00:00.000Z",
      billingCycleEnd: "2026-07-03T00:00:00.000Z",
      planUsage: { totalPercentUsed: 40, autoPercentUsed: 3 },
    });

    for (const window of result?.windows ?? []) {
      expect(window.startsAt, window.id).toBe("2026-06-03T00:00:00.000Z");
    }
  });

  it("derives the previous renewal date from the billing cycle end", () => {
    const result = normalizeCursorUsage({
      billingCycleEnd: "2026-07-03T00:00:00.000Z",
      planUsage: { totalPercentUsed: 40 },
    });

    expect(result?.windows[0]?.startsAt).toBe("2026-06-03T00:00:00.000Z");
  });

  it("clamps a renewal day that the previous month does not have", () => {
    const result = normalizeCursorUsage({
      billingCycleEnd: "2026-03-31T09:30:00.000Z",
      planUsage: { totalPercentUsed: 40 },
    });

    expect(result?.windows[0]?.startsAt).toBe("2026-02-28T09:30:00.000Z");
  });

  it("leaves the cycle unresolved when neither billing cycle field is present", () => {
    const result = normalizeCursorUsage({
      planUsage: { totalPercentUsed: 40 },
    });

    expect(result?.windows[0]?.startsAt).toBeUndefined();
    expect(result?.windows[0]?.windowSeconds).toBeUndefined();
  });

  it("resolves pace and usable runway for a monthly window", () => {
    const usage = normalizeCursorUsage({
      billingCycleEnd: "2026-07-03T00:00:00.000Z",
      planUsage: { autoPercentUsed: 97 },
    });
    const report = withQuotaSemantics(
      cursorProvider(usage?.windows ?? []),
      "2026-06-20T00:00:00.000Z",
    );

    expect(report.windows[0]?.pace).toMatchObject({
      cycleBasis: "starts_at_resets_at",
      cycleSeconds:
        (Date.parse("2026-07-03T00:00:00.000Z") -
          Date.parse("2026-06-03T00:00:00.000Z")) /
        1000,
      status: "ahead",
    });
    const runway = report.quotaSemantics?.effectiveAvailability[0]?.runway;
    expect(runway?.status).toBe("projected_exhaustion");
    expect(runway?.usableRunwaySeconds).toBeGreaterThan(0);
  });

  it("keeps runway unknown when the payload carries no billing cycle", () => {
    const usage = normalizeCursorUsage({ planUsage: { autoPercentUsed: 97 } });
    const report = withQuotaSemantics(
      cursorProvider(usage?.windows ?? []),
      "2026-06-20T00:00:00.000Z",
    );

    expect(report.windows[0]?.pace?.status).toBe("unknown");
    expect(
      report.quotaSemantics?.effectiveAvailability[0]?.runway?.status,
    ).toBe("unknown");
  });
});
