import { afterEach, describe, expect, it } from "vitest";
import { fetchQuota } from "../../src/providers/fireworks.js";

const original = process.env.FIREWORKS_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.FIREWORKS_API_KEY;
  else process.env.FIREWORKS_API_KEY = original;
});

describe("Fireworks provider", () => {
  it("fails closed without credentials", async () => {
    delete process.env.FIREWORKS_API_KEY;
    expect(
      (await fetchQuota({ allowKeychainPrompt: false })).state.status,
    ).toBe("auth_required");
  });
});
