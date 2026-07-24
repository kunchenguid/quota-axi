import { describe, expect, it } from "vitest";
import { fetchQuota } from "../../src/providers/nvidia.js";

describe("NVIDIA provider", () => {
  it("reports the configured diagnostic limit without inventing usage", async () => {
    const result = await fetchQuota({ allowKeychainPrompt: false });
    expect(result.plan).toBe("free-tier-40-rpm");
    expect(result.windows).toEqual([]);
  });
});
