import { describe, expect, it } from "vitest";
import { normalizeCopilotUser } from "../../src/providers/copilot.js";

describe("GitHub Copilot quota parsing", () => {
  it("normalizes quota snapshots without inventing comparable percentages", () => {
    const result = normalizeCopilotUser({
      login: "fixture-user",
      copilot_plan: "individual",
      quota_reset_date_utc: "2026-08-01T00:00:00Z",
      quota_snapshots: {
        chat: {
          percent_remaining: 80,
          quota_reset_at: 1785542400,
        },
        premium_interactions: {
          percent_remaining: "25",
        },
      },
    });

    expect(result?.plan).toBe("individual");
    expect(result?.account?.accountId).toBe("fixture-user");
    expect(result?.windows).toMatchObject([
      {
        id: "chat",
        label: "chat",
        kind: "monthly",
        percentUsed: 20,
        percentRemaining: 80,
        resetsAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "premium_interactions",
        label: "premium interactions",
        kind: "monthly",
        percentUsed: 75,
        percentRemaining: 25,
        resetsAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("can return a fresh entitlement report with no numeric windows", () => {
    const result = normalizeCopilotUser({
      login: "fixture-user",
      access_type_sku: "business",
    });

    expect(result).toMatchObject({
      plan: "business",
      account: { accountId: "fixture-user" },
      windows: [],
    });
  });
});
