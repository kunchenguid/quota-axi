import { describe, expect, it } from "vitest";
import { normalizeCursorUsage } from "../../src/providers/cursor.js";

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

  it("tolerates missing email/membershipType from a CLI-origin credential", () => {
    // cursor-cli-auth has no cachedEmail/stripeMembershipType (those come
    // only from state.vscdb); plan must still resolve from GetPlanInfo and
    // the function must not throw when credentials omit both fields.
    const result = normalizeCursorUsage(
      { planUsage: { totalPercentUsed: 15 } },
      { planInfo: { planName: "pro" } },
      {},
    );

    expect(result?.plan).toBe("pro");
    expect(result?.account?.email).toBeUndefined();
    expect(result?.windows).toMatchObject([
      { id: "included_usage", percentUsed: 15, percentRemaining: 85 },
    ]);
  });
});
