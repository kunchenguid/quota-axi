import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These tests spawn a real shim binary rather than a mocked child, because the
 * defect they guard could only ever be seen by a process that parses argv: the
 * shipped `-a untrusted` was rejected by codex-cli before a single byte of
 * JSON-RPC was exchanged, and every mocked child answered happily regardless.
 *
 * The shim validates `--ask-for-approval` exactly the way codex-cli 0.151.0
 * does, so changing the provider's approval policy back to a value codex
 * rejects turns the first test red.
 */

const ACCEPTED_BY_CODEX = "on-request,never";

const ENV_KEYS = [
  "CODEX_HOME",
  "XDG_CACHE_HOME",
  "QUOTA_AXI_CODEX_BINARY",
  "QUOTA_AXI_SHIM_APPROVAL_VALUES",
  "QUOTA_AXI_SHIM_ARGV_LOG",
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-spawn-"));
  // No auth.json under CODEX_HOME, so the OAuth source is skipped as missing
  // and the cli-rpc source is the one under test. An empty cache home keeps a
  // stale snapshot from masking the outcome.
  process.env.CODEX_HOME = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.QUOTA_AXI_CODEX_BINARY = writeShim(tempDir);
  process.env.QUOTA_AXI_SHIM_ARGV_LOG = join(tempDir, "argv.json");
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Codex app-server spawn", () => {
  it("launches the app-server with an approval policy codex accepts", async () => {
    process.env.QUOTA_AXI_SHIM_APPROVAL_VALUES = ACCEPTED_BY_CODEX;

    const { fetchQuota } = await import("../../src/providers/codex.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      provider: "codex",
      source: "cli-rpc",
      plan: "pro",
      state: { status: "fresh", stale: false },
    });
    expect(result.windows).toMatchObject([
      { id: "weekly", kind: "weekly", percentUsed: 12, windowSeconds: 604_800 },
    ]);
    expect(result.attempts).toContainEqual({
      source: "cli-rpc",
      status: "success",
    });

    const argv = JSON.parse(
      readFileSync(process.env.QUOTA_AXI_SHIM_ARGV_LOG!, "utf8"),
    ) as string[];
    expect(argv).toEqual(["-s", "read-only", "-a", "never", "app-server"]);
  });

  it("reports the child's exit status and stderr when the flag is rejected", async () => {
    // The shim accepts neither of codex's real values, so whatever approval
    // policy the provider sends is rejected the way codex rejects `untrusted`.
    process.env.QUOTA_AXI_SHIM_APPROVAL_VALUES = "policy-no-provider-sends";

    const { fetchQuota } = await import("../../src/providers/codex.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    const attempt = result.attempts?.find((item) => item.source === "cli-rpc");
    expect(attempt?.status).toBe("failed");
    expect(attempt?.error).toContain("Codex app-server exited (exit 2)");
    expect(attempt?.error).toContain("--ask-for-approval");
    expect(attempt?.error).toContain("invalid value");
    expect(attempt?.error).not.toBe("Codex quota unavailable");
    // A rejected flag is a tool error, never a sign-out.
    expect(result.state.status).toBe("error");
  });
});

/**
 * Stands in for `codex`: rejects an unacceptable `--ask-for-approval` value
 * with codex-cli's own usage text and exit code 2, and otherwise answers the
 * three app-server RPCs the provider drives.
 */
function writeShim(root: string): string {
  const path = join(root, "codex-shim");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.QUOTA_AXI_SHIM_ARGV_LOG)
  fs.writeFileSync(process.env.QUOTA_AXI_SHIM_ARGV_LOG, JSON.stringify(argv));

const accepted = (process.env.QUOTA_AXI_SHIM_APPROVAL_VALUES ?? "").split(",");
const approval = argv[argv.indexOf("-a") + 1];
if (argv.includes("-a") && !accepted.includes(approval)) {
  process.stderr.write(
    "error: invalid value '" + approval + "' for '--ask-for-approval <APPROVAL_POLICY>'\\n" +
      "  [possible values: " + accepted.join(", ") + "]\\n\\n" +
      "For more information, try '--help'.\\n",
  );
  process.exit(2);
}

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
    if (request.method === "account/read")
      result = { account: { type: "chatgpt", planType: "pro" } };
    if (request.method === "account/rateLimits/read") {
      result = {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 10080 },
          secondary: null,
          planType: "pro",
        },
      };
    }
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  }
});
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}
