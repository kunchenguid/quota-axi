import { describe, expect, it } from "vitest";
import { createZaiApiKeyCredentialSource } from "../../src/providers/zai-api-key-credential.js";

describe("Z.ai API key credential source", () => {
  it("resolves a literal ZAI_API_KEY from the environment", async () => {
    const source = createZaiApiKeyCredentialSource({
      environment: () => ({ ZAI_API_KEY: "synthetic-env-key-204" }),
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "synthetic-env-key-204",
    });
    await expect(source.inspect()).resolves.toBe("available");
  });

  it("trims surrounding whitespace", async () => {
    const source = createZaiApiKeyCredentialSource({
      environment: () => ({ ZAI_API_KEY: "  synthetic-env-key-with-space  " }),
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "synthetic-env-key-with-space",
    });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("reports a %s ZAI_API_KEY as missing", async (_label, value) => {
    const source = createZaiApiKeyCredentialSource({
      environment: () => ({ ZAI_API_KEY: value }),
    });

    await expect(source.resolve()).resolves.toEqual({ status: "missing" });
    await expect(source.inspect()).resolves.toBe("missing");
  });

  it("rejects a value containing control bytes without exposing it", async () => {
    const source = createZaiApiKeyCredentialSource({
      environment: () => ({ ZAI_API_KEY: "bad\tkey" }),
    });

    const resolution = await source.resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain("bad");
  });

  it("defaults to reading process.env when no override is given", async () => {
    const original = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = "default-env-source-key-511";
    try {
      const source = createZaiApiKeyCredentialSource();
      await expect(source.resolve()).resolves.toEqual({
        status: "available",
        apiKey: "default-env-source-key-511",
      });
    } finally {
      if (original === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = original;
    }
  });
});
