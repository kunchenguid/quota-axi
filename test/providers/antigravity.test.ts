import { describe, expect, it } from "vitest";
import { parseAntigravityQuota } from "../../src/providers/antigravity.js";

describe("Antigravity provider", () => {
  it("parses grouped session and weekly windows without inventing limits", () => {
    const result = parseAntigravityQuota(
      `GEMINI MODELS\nWeekly Limit\n79% remaining · Refreshes in 106h 41m\nFive Hour Limit\nQuota available`,
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.percentUsed).toBe(21);
    expect(result[1]?.percentRemaining).toBe(100);
  });
});
