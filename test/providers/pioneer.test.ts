import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQuota } from "../../src/providers/pioneer.js";

const originalKey = process.env.PIONEER_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.PIONEER_API_KEY;
  else process.env.PIONEER_API_KEY = originalKey;
});

describe("Pioneer provider", () => {
  it("normalizes the prepaid credit pool", async () => {
    process.env.PIONEER_API_KEY = "secret-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            payment_plan: "pro",
            credit_limit: 10000,
            total_usage: 2500,
            remaining_credits: 7500,
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await fetchQuota({ allowKeychainPrompt: false });
    expect(result.state.status).toBe("fresh");
    expect(result.plan).toBe("pro");
    expect(result.credits).toEqual({ remaining: 75, unit: "usd" });
    expect(result.windows[0]).toMatchObject({
      id: "credit_pool",
      percentUsed: 25,
      percentRemaining: 75,
    });
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });
});
