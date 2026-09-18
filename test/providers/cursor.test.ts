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
        label: "Cursor Models (includes Cursor Grok and Composer)",
        kind: "monthly",
        percentUsed: 12,
        percentRemaining: 88,
      },
      {
        id: "api_usage",
        label: "Other Models",
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

  it("labels included usage Included in Ultra when that is the plan heading", () => {
    const result = normalizeCursorUsage(
      {
        planUsage: {
          totalPercentUsed: 58,
          autoPercentUsed: 63,
          apiPercentUsed: 58,
        },
      },
      { planInfo: { planName: "ultra" } },
    );

    expect(result?.windows).toMatchObject([
      {
        id: "included_usage",
        label: "Included in Ultra",
        percentUsed: 58,
        percentRemaining: 42,
      },
      {
        id: "auto_usage",
        label: "Cursor Models (includes Cursor Grok and Composer)",
        percentUsed: 63,
        percentRemaining: 37,
      },
      {
        id: "api_usage",
        label: "Other Models",
        percentUsed: 58,
        percentRemaining: 42,
      },
    ]);
  });

  it("uses membershipType ultra when plan info is absent", () => {
    const result = normalizeCursorUsage(
      { planUsage: { totalPercentUsed: 63 } },
      undefined,
      { membershipType: "ultra" },
    );

    expect(result?.windows[0]).toMatchObject({
      id: "included_usage",
      label: "Included in Ultra",
    });
  });

  it("labels included usage Included in Ultra when membershipType is Ultra even if the plan heading is not", () => {
    const result = normalizeCursorUsage(
      { planUsage: { totalPercentUsed: 58 } },
      { planInfo: { planName: "pro", price: "pro" } },
      { membershipType: "ultra" },
    );

    expect(result?.plan).toBe("pro");
    expect(result?.windows[0]).toMatchObject({
      id: "included_usage",
      label: "Included in Ultra",
    });
  });

  it("labels included usage Included in Ultra when plan.price is Ultra even if planName is not", () => {
    const result = normalizeCursorUsage(
      { planUsage: { totalPercentUsed: 58 } },
      { planInfo: { planName: "pro", price: "ultra" } },
    );

    expect(result?.plan).toBe("pro");
    expect(result?.windows[0]).toMatchObject({
      id: "included_usage",
      label: "Included in Ultra",
    });
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

describe("Cursor Grok Bot weekly usage", () => {
  it("normalizes GetSandUsageStatus into a grok_bot weekly window", () => {
    const result = normalizeCursorUsage(
      {
        billingCycleStart: "2026-07-19T21:37:33.000Z",
        billingCycleEnd: "2026-08-19T21:37:33.000Z",
        planUsage: { totalPercentUsed: 15.2, autoPercentUsed: 13.9 },
      },
      undefined,
      undefined,
      {
        currentPeriodStart: "2026-08-19T21:37:33.239Z",
        nextResetTimestampUtc: "2026-08-26T21:37:33.239Z",
        usagePercent: 38.059383,
        hasAvailableUsage: true,
        hasNonZeroIncludedLimit: true,
        grokPlanLabel: "Grok Bot Plan",
      },
    );

    expect(result?.windows).toMatchObject([
      {
        id: "included_usage",
        label: "included usage",
        kind: "monthly",
        percentUsed: 15,
        startsAt: "2026-07-19T21:37:33.000Z",
      },
      {
        id: "auto_usage",
        label: "Cursor Models (includes Cursor Grok and Composer)",
        kind: "monthly",
        percentUsed: 14,
        startsAt: "2026-07-19T21:37:33.000Z",
      },
      {
        id: "grok_bot",
        label: "Grok Bot",
        kind: "weekly",
        percentUsed: 38,
        percentRemaining: 62,
        startsAt: "2026-08-19T21:37:33.239Z",
        resetsAt: "2026-08-26T21:37:33.239Z",
      },
    ]);
  });

  it("accepts snake_case GetSandUsageStatus fields", () => {
    const result = normalizeCursorUsage(
      { planUsage: { totalPercentUsed: 10 } },
      undefined,
      undefined,
      {
        current_period_start: "2026-08-19T21:37:33.239Z",
        next_reset_timestamp_utc: "2026-08-26T21:37:33.239Z",
        usage_percent: 12.4,
        uses_pooled_enterprise_allowance: false,
      },
    );

    expect(result?.windows).toContainEqual(
      expect.objectContaining({
        id: "grok_bot",
        percentUsed: 12,
        startsAt: "2026-08-19T21:37:33.239Z",
        resetsAt: "2026-08-26T21:37:33.239Z",
      }),
    );
  });

  it("omits grok_bot when the sand payload has no finite usage percent", () => {
    const result = normalizeCursorUsage(
      { planUsage: { totalPercentUsed: 10 } },
      undefined,
      undefined,
      { hasAvailableUsage: true, grokPlanLabel: "Grok Bot Plan" },
    );

    expect(result?.windows.map((window) => window.id)).toEqual([
      "included_usage",
    ]);
  });

  it("omits grok_bot for a pooled enterprise sand allowance", () => {
    const result = normalizeCursorUsage(
      { planUsage: { totalPercentUsed: 10 } },
      undefined,
      undefined,
      {
        usagePercent: 40,
        usesPooledEnterpriseAllowance: true,
        currentPeriodStart: "2026-08-19T21:37:33.239Z",
        nextResetTimestampUtc: "2026-08-26T21:37:33.239Z",
      },
    );

    expect(result?.windows.map((window) => window.id)).toEqual([
      "included_usage",
    ]);
  });

  it("reports grok_bot alone when Cursor exposes no IDE quota windows", () => {
    const result = normalizeCursorUsage(
      { planUsage: {} },
      undefined,
      undefined,
      {
        usagePercent: 5,
        currentPeriodStart: "2026-08-19T21:37:33.239Z",
        nextResetTimestampUtc: "2026-08-26T21:37:33.239Z",
      },
    );

    expect(result?.windows).toMatchObject([
      { id: "grok_bot", kind: "weekly", percentUsed: 5, percentRemaining: 95 },
    ]);
  });
});
