import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQuota } from "../../src/providers/commandcode.js";

const originalKey = process.env.COMMANDCODE_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.COMMANDCODE_API_KEY;
  else process.env.COMMANDCODE_API_KEY = originalKey;
});

describe("Command Code provider", () => {
  it("normalizes five-hour, weekly, and credit windows", async () => {
    process.env.COMMANDCODE_API_KEY = "secret-test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            credits: { monthlyCredits: 75 },
            windowLimits: {
              fiveHour: { used: 1, cap: 4, resetAt: 1760000000000 },
              weekly: { used: 2, cap: 10, resetAt: 1760100000000 },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ totalMonthlyCredits: 25 }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });
    expect(result.state.status).toBe("fresh");
    expect(result.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "weekly",
      "credit_pool",
    ]);
    expect(result.windows[0]).toMatchObject({
      percentUsed: 25,
      percentRemaining: 75,
    });
    expect(result.credits).toEqual({ remaining: 75, unit: "credits" });
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });
});
