import { spawn, spawnSync } from "node:child_process";
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

type Fixture = { env: NodeJS.ProcessEnv; calls: string };

/**
 * A synthetic home whose vendor is a fake Codex app-server that counts how
 * often it is asked for rate limits, so the count is the number of vendor
 * usage calls. It answers after `delayMs`, like a real vendor round trip.
 */
function fixture(delayMs = 0): Fixture {
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
    let delay = 0;
    if (request.method === "account/read") {
      result = {
        account: { type: "chatgpt", email: "cli@example.invalid", planType: "plus" },
        requiresOpenaiAuth: true
      };
    }
    if (request.method === "account/rateLimits/read") {
      appendFileSync(${JSON.stringify(calls)}, "x");
      delay = ${delayMs};
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
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
    }, delay);
  }
});
`,
    { mode: 0o700 },
  );
  return {
    calls,
    env: {
      HOME: home,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      QUOTA_AXI_CODEX_BINARY: codex,
      PATH: process.env.PATH ?? "",
    },
  };
}

const ARGS = [BUILT_CLI_ENTRYPOINT, "--provider", "codex", "--json"];

type Reading = { state: { status: string; reused?: true } };

function parseReading(stdout: string): Reading {
  return (JSON.parse(stdout) as { providers: Reading[] }).providers[0]!;
}

/**
 * The rate-limit burst as a consumer produces it: separate `quota-axi --json`
 * processes back to back, as a dispatcher taking a fresh reading per decision
 * does. Returns the number of vendor usage calls.
 */
function burst(reads: number, env: NodeJS.ProcessEnv = {}): number {
  const { env: base, calls } = fixture();
  for (let read = 0; read < reads; read++) {
    const result = spawnSync(process.execPath, ARGS, {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...base, ...env },
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    const provider = parseReading(result.stdout);
    expect(provider.state.status).toBe("fresh");
    if (read > 0 && env.QUOTA_AXI_MAX_AGE)
      expect(provider.state.reused).toBe(true);
  }
  return readFileSync(calls, "utf8").length;
}

/**
 * `processes` separate reads started together on a cold cache, as parallel
 * dispatch decisions produce. The vendor takes a second to answer, so every
 * process is waiting on it at once. Returns the vendor usage calls and each
 * process's reading.
 */
async function concurrent(
  processes: number,
  env: NodeJS.ProcessEnv,
): Promise<{ calls: number; readings: Reading[] }> {
  const { env: base, calls } = fixture(1_000);
  const readings = await Promise.all(
    Array.from(
      { length: processes },
      () =>
        new Promise<Reading>((resolvePromise, reject) => {
          const child = spawn(process.execPath, ARGS, {
            env: { ...base, ...env },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (status) => {
            if (status === 0) resolvePromise(parseReading(stdout));
            else reject(new Error(`exit ${status}: ${stderr}`));
          });
        }),
    ),
  );
  return { calls: readFileSync(calls, "utf8").length, readings };
}

describe("fresh reuse through the built CLI", () => {
  it("makes one vendor usage call for eight back-to-back reads with QUOTA_AXI_MAX_AGE=90", () => {
    expect(burst(8, { QUOTA_AXI_MAX_AGE: "90" })).toBe(1);
  }, 60_000);

  it("makes one per read without it, the behavior before reuse", () => {
    expect(burst(8)).toBe(8);
  }, 60_000);

  it("makes one vendor usage call for eight processes started together", async () => {
    const { calls, readings } = await concurrent(8, {
      QUOTA_AXI_MAX_AGE: "90",
    });
    expect(calls).toBe(1);
    expect(readings.every((reading) => reading.state.status === "fresh")).toBe(
      true,
    );
    expect(readings.filter((reading) => !reading.state.reused)).toHaveLength(1);
  }, 60_000);

  it("makes one per process without reuse, where no lock is taken", async () => {
    const { calls } = await concurrent(8, {});
    expect(calls).toBe(8);
  }, 60_000);
});
