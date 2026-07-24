import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQuota } from "../../src/providers/openrouter.js";

const originalKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("OpenRouter provider", () => {
  it("normalizes credits and usage windows", async () => {
    process.env.OPENROUTER_API_KEY = "secret-test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { total_credits: 100, total_usage: 25 } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { usage_daily: 10, usage_weekly: 20, usage_monthly: 30 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });
    expect(result.state.status).toBe("fresh");
    expect(result.credits).toEqual({ remaining: 75, unit: "usd" });
    expect(result.windows.map((window) => window.id)).toEqual([
      "daily",
      "weekly",
      "monthly",
      "credit_pool",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });
});
