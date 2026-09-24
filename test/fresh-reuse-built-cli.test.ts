import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/**
 * The rate-limit burst as a consumer produces it: separate `quota-axi --json`
 * processes back to back, as a dispatcher taking a fresh reading per decision
 * does. The vendor is a fake Codex app-server that counts how often it is
 * asked for rate limits, so the count is the number of vendor usage calls.
 */
function burst(reads: number, flags: string[] = []): number {
  root = mkdtempSync(join(tmpdir(), "quota-axi-fresh-reuse-cli-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const calls = join(root, "usage-calls");
  writeFileSync(calls, "");
  const codex = join(root, "codex-fixture");
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 86_400;
  writeFileSync(
    codex,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
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
    if (request.method === "account/read") {
      result = {
        account: { type: "chatgpt", email: "cli@example.invalid", planType: "plus" },
        requiresOpenaiAuth: true
      };
    }
    if (request.method === "account/rateLimits/read") {
      appendFileSync(${JSON.stringify(calls)}, "x");
      result = {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: ${resetsAt} },
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
  for (let read = 0; read < reads; read++) {
    const result = spawnSync(
      process.execPath,
      [BUILT_CLI_ENTRYPOINT, "--provider", "codex", "--json", ...flags],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          HOME: home,
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_CONFIG_HOME: join(root, "config"),
          QUOTA_AXI_CODEX_BINARY: codex,
          PATH: process.env.PATH ?? "",
        },
      },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    const provider = (
      JSON.parse(result.stdout) as {
        providers: { state: { status: string; reused?: true } }[];
      }
    ).providers[0]!;
    expect(provider.state.status).toBe("fresh");
    if (read > 0 && !flags.includes("0"))
      expect(provider.state.reused).toBe(true);
  }
  return readFileSync(calls, "utf8").length;
}

describe("fresh reuse through the built CLI", () => {
  it("makes one vendor usage call for eight back-to-back reads", () => {
    expect(burst(8)).toBe(1);
  }, 60_000);

  it("makes one per read with --max-age 0, the behavior before reuse", () => {
    expect(burst(8, ["--max-age", "0"])).toBe(8);
  }, 60_000);
});
