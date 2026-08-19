import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
});
