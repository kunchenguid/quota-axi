import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { QuotaAxiResponse } from "../src/types.js";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
const TSC_ENTRYPOINT = resolve("node_modules/typescript/bin/tsc");
let temporaryDirectories: string[] = [];

beforeAll(() => {
  const result = spawnSync(
    process.execPath,
    [TSC_ENTRYPOINT, "--pretty", "false"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(existsSync(BUILT_CLI_ENTRYPOINT)).toBe(true);
});

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("built Codex CLI weekly window", () => {
  it("renders a primary-only seven-day app-server window as weekly in TOON and JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-axi-codex-weekly-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const cacheHome = join(root, "cache");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(cacheHome, { mode: 0o700 });
    const codex = join(root, "codex-fixture");
    writeFileSync(
      codex,
      `#!${process.execPath}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    let result = {};
    if (request.method === "account/read") result = { account: null };
    if (request.method === "account/rateLimits/read") {
      result = {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 0, windowDurationMins: 10080 },
          secondary: null
        },
        rateLimitsByLimitId: {}
      };
    }
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  }
});
`,
      { mode: 0o700 },
    );
    chmodSync(codex, 0o700);

    const run = (json: boolean) => {
      const args = [BUILT_CLI_ENTRYPOINT, "--provider", "codex"];
      if (json) args.push("--json");
      const result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          HOME: home,
          XDG_CACHE_HOME: cacheHome,
          QUOTA_AXI_CODEX_BINARY: codex,
          PATH: process.env.PATH ?? "",
        },
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };

    const toon = run(false);
    expect(toon).toContain("codex,weekly,week,100");
    expect(toon).not.toContain("codex,five_hour,session");

    const json = JSON.parse(run(true)) as QuotaAxiResponse;
    expect(json.providers[0]).toMatchObject({
      provider: "codex",
      source: "cli-rpc",
      windows: [
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          windowSeconds: 604_800,
        },
      ],
      state: { status: "fresh", stale: false },
    });
  });
});
