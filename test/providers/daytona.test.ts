import { afterEach, describe, expect, it } from "vitest";
import { fetchQuota } from "../../src/providers/daytona.js";

const original = process.env.DAYTONA_API_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.DAYTONA_API_TOKEN;
  else process.env.DAYTONA_API_TOKEN = original;
});

describe("Daytona provider", () => {
  it("fails closed without credentials", async () => {
    delete process.env.DAYTONA_API_TOKEN;
    expect(
      (await fetchQuota({ allowKeychainPrompt: false })).state.status,
    ).toBe("auth_required");
  });
});
