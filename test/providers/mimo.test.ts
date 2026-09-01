import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createMimoAdapter,
  resolveMimoCredential,
} from "../../src/providers/mimo.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };

describe("MiMo provider", () => {
  it("reports local model authentication as usable without fabricating dashboard quota", async () => {
    const auth = JSON.parse(
      readFileSync("test/fixtures/mimo/auth.json", "utf8"),
    );
    const report = await createMimoAdapter({
      credential: () => resolveMimoCredential({ MIMO_API_KEY: auth.key }),
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "mimo",
      source: "api",
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        sourcesTried: ["env:MIMO_API_KEY"],
      },
    });
  });

  it("treats template and missing API keys as unavailable", async () => {
    expect(resolveMimoCredential({ MIMO_API_KEY: "${MIMO_API_KEY}" })).toEqual({
      status: "missing",
      source: "env:MIMO_API_KEY",
    });
    const report = await createMimoAdapter({
      credential: () => resolveMimoCredential({}),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "auth_required", error: "mimo_credential_unavailable" },
    });
  });
});
