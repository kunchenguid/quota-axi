import { describe, expect, it } from "vitest";
import { preferredSources, SOURCE_CATALOG } from "../src/source-registry.js";
import { PROVIDER_IDS } from "../src/types.js";

describe("provider source registry", () => {
  it("has a source plan for every supported provider", () => {
    for (const provider of PROVIDER_IDS) {
      expect(SOURCE_CATALOG[provider].length, provider).toBeGreaterThan(0);
      expect(
        SOURCE_CATALOG[provider].every((item) => item.provider === provider),
      ).toBe(true);
    }
  });

  it("orders authoritative sources before fallbacks", () => {
    for (const provider of PROVIDER_IDS) {
      const sources = preferredSources(provider);
      expect(sources[0].confidence, provider).toBe("authoritative");
      expect(sources.map((item) => item.order)).toEqual(
        [...sources].map((item) => item.order).sort((a, b) => a - b),
      );
    }
  });

  it("does not make interception a normal provider source", () => {
    for (const sources of Object.values(SOURCE_CATALOG)) {
      expect(sources.some((item) => item.method === "interception")).toBe(
        false,
      );
    }
  });
});
