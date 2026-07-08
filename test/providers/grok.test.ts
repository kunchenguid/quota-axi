import { describe, expect, it } from "vitest";
import { normalizeGrokBilling } from "../../src/providers/grok.js";

describe("Grok quota parsing", () => {
  it("normalizes credit, on-demand, and product windows", () => {
    const result = normalizeGrokBilling(
      {
        config: {
          billingPeriodEnd: "2026-08-02T00:00:00Z",
          creditUsagePercent: 40,
          onDemandCap: { val: "1000" },
          onDemandUsed: { val: 250 },
          prepaidBalance: { val: 12.5 },
          subscriptionTier: "supergrok",
          productUsage: [
            { product: "Grok Build", usagePercent: "55" },
            { product: "Voice", usagePercent: 105 },
          ],
        },
      },
      {
        email: "person@example.invalid",
        teamId: "team_fixture",
      },
    );

    expect(result?.plan).toBe("supergrok");
    expect(result?.account).toMatchObject({
      email: "person@example.invalid",
      organization: "team_fixture",
    });
    expect(result?.credits).toEqual({ remaining: 12.5, unit: "credits" });
    expect(result?.windows).toMatchObject([
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: 40,
        percentRemaining: 60,
        resetsAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "on_demand",
        label: "on-demand credits",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
      },
      {
        id: "product:grok_build",
        label: "Grok Build",
        kind: "credits",
        percentUsed: 55,
        percentRemaining: 45,
      },
      {
        id: "product:voice",
        label: "Voice",
        kind: "credits",
        percentUsed: 100,
        percentRemaining: 0,
      },
    ]);
  });

  it("returns undefined when Grok exposes no numeric quota windows", () => {
    expect(normalizeGrokBilling({ config: {} })).toBeUndefined();
  });
});
