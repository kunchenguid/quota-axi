import { afterEach, describe, expect, it } from "vitest";
import { fetchQuota, inspectAuth } from "../../src/providers/runpod.js";

const original = process.env.RUNPOD_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.RUNPOD_API_KEY;
  else process.env.RUNPOD_API_KEY = original;
});

describe("RunPod provider", () => {
  it("fails closed without credentials", async () => {
    delete process.env.RUNPOD_API_KEY;
    expect(
      (await fetchQuota({ allowKeychainPrompt: false })).state.status,
    ).toBe("auth_required");
    expect(
      (await inspectAuth({ allowKeychainPrompt: false })).sources[0]?.status,
    ).toBe("skipped");
  });
});
