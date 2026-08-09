import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { PROVIDERS } from "../src/providers/index.js";
import type { ProviderAdapter, ProviderId } from "../src/types.js";
import { DEFAULT_PROVIDER_IDS, PROVIDER_IDS } from "../src/types.js";

describe("published package contract", () => {
  it("type-checks a consumer against the built package root", () => {
    const typecheck = spawnSync(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        "test/fixtures/public-contract-consumer.ts",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(typecheck.status, `${typecheck.stdout}${typecheck.stderr}`).toBe(0);
  });

  it("invokes only the six default providers for a bare `auth` call, never antigravity", async () => {
    const originalProviders = { ...PROVIDERS };
    const inspected: ProviderId[] = [];
    for (const id of PROVIDER_IDS) {
      const stub: ProviderAdapter = {
        id,
        label: id,
        async fetchQuota() {
          throw new Error(`unexpected quota fetch for ${id}`);
        },
        async inspectAuth() {
          inspected.push(id);
          return { provider: id, sources: [] };
        },
      };
      PROVIDERS[id] = stub;
    }
    try {
      const chunks: string[] = [];
      await main({
        argv: ["auth", "--json"],
        binPath: "quota-axi",
        stdout: {
          write(chunk) {
            chunks.push(String(chunk));
            return true;
          },
        },
      });
      const parsed = JSON.parse(chunks.join("")) as {
        auth: { provider: ProviderId }[];
      };
      expect(parsed.auth.map((entry) => entry.provider).sort()).toEqual(
        [...DEFAULT_PROVIDER_IDS].sort(),
      );
      expect(inspected.sort()).toEqual([...DEFAULT_PROVIDER_IDS].sort());
      expect(inspected).not.toContain("antigravity");
    } finally {
      Object.assign(PROVIDERS, originalProviders);
    }
  });
});
