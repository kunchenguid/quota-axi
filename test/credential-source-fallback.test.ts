import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaAxiResponse } from "../src/types.js";

/**
 * A provider with more than one credential source must report the source that
 * works. These cases drive the real Codex adapter through the public CLI
 * output a consumer reads, across the three shapes that matter: a working
 * sibling superseding a broken store, every source broken, and a first source
 * that answers on its own.
 */
const PI_ACCESS_TOKEN = "pi-openai-codex-access-token-fixture";
const FILE_ACCESS_TOKEN = "codex-auth-json-access-token-fixture";

const originalEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  QUOTA_AXI_CODEX_BINARY: process.env.QUOTA_AXI_CODEX_BINARY,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};
let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-source-fallback-"));
  process.env.CODEX_HOME = tempDir;
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.XDG_DATA_HOME = join(tempDir, "data");
  // Absent on purpose: the CLI fallback must never stand in for a credential source.
  process.env.QUOTA_AXI_CODEX_BINARY = join(tempDir, "no-such-codex");
  vi.doMock("../src/lib/process.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/process.js")>()),
    findCommandPath: vi.fn(async () => undefined),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/lib/process.js");
  vi.resetModules();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

/** The standalone `codex login` store, with an access token that already expired. */
function writeExpiredCodexAuthFile(): void {
  writeFileSync(
    join(tempDir, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 3_600 }),
        refresh_token: "refresh-token-must-not-be-used",
        account_id: "acct-auth-json-fixture",
      },
    }),
  );
}

function writeLiveCodexAuthFile(): void {
  writeFileSync(
    join(tempDir, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: FILE_ACCESS_TOKEN,
        refresh_token: "refresh-token-must-not-be-used",
        account_id: "acct-auth-json-fixture",
      },
    }),
  );
}

/** Pi's own credential store, holding a working `openai-codex` OAuth record. */
function writePiCodexCredential(overrides: Record<string, unknown> = {}): void {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: PI_ACCESS_TOKEN,
        refresh: "pi-refresh-token-must-not-be-used",
        expires: Date.now() + 3_600_000,
        accountId: "acct-pi-fixture",
        ...overrides,
      },
    }),
    { mode: 0o600 },
  );
}

/** Answers usage only for the listed bearers, so the report names its real source. */
function stubUsageApi(acceptedTokens: string[]): { bearers: string[] } {
  const bearers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      bearers.push(bearer);
      if (!acceptedTokens.some((token) => bearer === `Bearer ${token}`)) {
        return new Response(null, { status: 401 });
      }
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 30,
              limit_window_seconds: 604_800,
              reset_after_seconds: 200_000,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return { bearers };
}

async function runQuota(args: string[]): Promise<string> {
  const { quotaCommand } = await import("../src/commands.js");
  return quotaCommand(["--provider", "codex", ...args], {
    binPath: "quota-axi",
  });
}

/** The indented rows of one TOON block, so an empty block reads as empty. */
function blockRows(report: string, block: string): string[] {
  const rows: string[] = [];
  let inside = false;
  for (const line of report.split("\n")) {
    if (line.startsWith(`${block}[`)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (!line.startsWith("  ")) break;
    rows.push(line.trim());
  }
  return rows;
}

const attentionRows = (report: string): string[] =>
  blockRows(report, "attention");
const quotaRows = (report: string): string[] => blockRows(report, "quota");

// Every case reloads the provider graph so the fixture environment is read
// fresh, which costs more than the default per-test budget on a cold cache.
describe("per-provider credential source fallback", { timeout: 30_000 }, () => {
  it("reports live quota from the Pi credential when the standalone Codex sign-in is broken", async () => {
    writeExpiredCodexAuthFile();
    writePiCodexCredential();
    const api = stubUsageApi([PI_ACCESS_TOKEN]);

    const report = await runQuota([]);

    expect(quotaRows(report)).toContainEqual(
      expect.stringContaining("codex,all_models,70,"),
    );
    expect(report).not.toContain("sign-in required");
    expect(api.bearers).toContain(`Bearer ${PI_ACCESS_TOKEN}`);
  });

  it("keeps the superseded Codex sign-in visible as a degraded source", async () => {
    writeExpiredCodexAuthFile();
    writePiCodexCredential();
    stubUsageApi([PI_ACCESS_TOKEN]);

    const report = await runQuota([]);

    expect(attentionRows(report)).toContain(
      "codex,all,degraded_source,oauth · credentials_expired,none",
    );
  });

  it("names the superseded source in --json without demoting it to --full", async () => {
    writeExpiredCodexAuthFile();
    writePiCodexCredential();
    stubUsageApi([PI_ACCESS_TOKEN]);

    const parsed = JSON.parse(await runQuota(["--json"])) as QuotaAxiResponse;
    const codex = parsed.providers[0];

    expect(codex.state.status).toBe("fresh");
    expect(codex.state.stale).toBe(false);
    expect(codex.state.degradedSources).toEqual([
      { source: "oauth", error: "credentials_expired" },
    ]);
  });

  it("still reports the auth problem when every source is broken", async () => {
    writeExpiredCodexAuthFile();
    // No Pi entry and no Codex binary: nothing is left to supersede the store.
    const api = stubUsageApi([]);

    const report = await runQuota([]);

    expect(quotaRows(report)).toEqual([]);
    expect(attentionRows(report)).toContainEqual(
      expect.stringContaining("codex,all,auth_required"),
    );
    expect(report).toContain("Codex sign-in required");
    expect(report).not.toMatch(/codex,all_models/);
    expect(api.bearers).toEqual([]);
  });

  it("adds no degraded row when the first source answers on its own", async () => {
    writeLiveCodexAuthFile();
    writePiCodexCredential();
    const api = stubUsageApi([FILE_ACCESS_TOKEN]);

    const report = await runQuota([]);

    expect(quotaRows(report)).toContainEqual(
      expect.stringContaining("codex,all_models,70,"),
    );
    expect(report).not.toContain("degraded_source");
    expect(api.bearers).not.toContain(`Bearer ${PI_ACCESS_TOKEN}`);
  });

  it("still explains a fresh provider that reports no measurable scope", async () => {
    const { quotaCommand } = await import("../src/commands.js");
    const { PROVIDERS } = await import("../src/providers/index.js");
    const original = PROVIDERS.copilot;
    PROVIDERS.copilot = {
      id: "copilot",
      label: "Copilot",
      async fetchQuota() {
        return {
          provider: "copilot" as const,
          label: "Copilot",
          source: "api" as const,
          windows: [],
          state: {
            status: "fresh" as const,
            stale: false,
            refreshedAt: "2026-01-01T00:00:00.000Z",
          },
          attempts: [
            {
              source: "apps-json",
              status: "skipped" as const,
              error: "credentials_expired",
              credentialPresent: true,
            },
            { source: "device-token", status: "success" as const },
          ],
        };
      },
      async inspectAuth() {
        return { provider: "copilot" as const, sources: [] };
      },
    };
    try {
      const report = await quotaCommand(["--provider", "copilot"], {
        binPath: "quota-axi",
      });

      expect(attentionRows(report)).toEqual([
        "copilot,all,no_quota,no measurable scope,none",
        "copilot,all,degraded_source,apps-json · credentials_expired,none",
      ]);
    } finally {
      PROVIDERS.copilot = original;
    }
  });

  it("leaves a single-source provider's report unchanged", async () => {
    const { quotaCommand } = await import("../src/commands.js");
    const report = await quotaCommand(["--provider", "zai"], {
      binPath: "quota-axi",
    });

    expect(report).not.toContain("degraded_source");
    expect(attentionRows(report)).toContainEqual(
      expect.stringContaining("zai,all,auth_required"),
    );
  });
});
