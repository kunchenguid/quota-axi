import { describe, expect, it } from "vitest";
import { fetchQuota } from "../../src/providers/inference.js";

describe("Inference.net provider", () => {
  it("fails closed when the official CLI is unavailable", async () => {
    const result = await fetchQuota({ allowKeychainPrompt: false });
    expect(["fresh", "error", "auth_required"]).toContain(result.state.status);
    expect(result.source).toBe("official-cli");
  });
});
