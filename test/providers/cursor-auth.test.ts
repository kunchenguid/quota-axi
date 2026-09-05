import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCursorStateDb = process.env.CURSOR_STATE_DB;
const originalCursorCliConfig = process.env.CURSOR_CLI_CONFIG;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cursor-auth-"));
  process.env.CURSOR_STATE_DB = join(tempDir, "state.vscdb");
  // Keeps these editor-source cases independent of any local Cursor CLI sign-in.
  process.env.CURSOR_CLI_CONFIG = join(tempDir, "cli-config.json");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  if (originalCursorStateDb === undefined) delete process.env.CURSOR_STATE_DB;
  else process.env.CURSOR_STATE_DB = originalCursorStateDb;
  if (originalCursorCliConfig === undefined)
    delete process.env.CURSOR_CLI_CONFIG;
  else process.env.CURSOR_CLI_CONFIG = originalCursorCliConfig;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function withPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

describe("Cursor credential-state reporting", () => {
  it("reports a missing access token as auth required", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => ""),
    }));

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Cursor sign-in required");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "credentials_missing",
    });
  });

  it("preserves skipped sqlite discovery failures", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => false),
      execFileText: vi.fn(),
    }));

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("sqlite3_unavailable");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "sqlite3_unavailable",
      credentialPresent: true,
    });
  });

  it("preserves sqlite read errors", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => {
        throw new Error("SQLITE_ERROR: database is locked");
      }),
    }));

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("sqlite_read_error");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "sqlite_read_error",
      credentialPresent: true,
    });
  });

  it("reports a missing state database as missing auth", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => {
        throw new Error("unable to open database file");
      }),
    }));

    const { inspectAuth } = await import("../../src/providers/cursor.js");
    const result = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.sources).toContainEqual({
      source: "state-vscdb",
      path: process.env.CURSOR_STATE_DB,
      status: "missing",
    });
  });

  it("parses JSON string values from Cursor state storage", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async (_command: string, args: string[]) => {
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken")) return '"valid-token"';
        if (query.includes("cursorAuth/cachedEmail"))
          return '"person@example.invalid"';
        if (query.includes("cursorAuth/stripeMembershipType")) return '"pro"';
        return "";
      }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer valid-token",
        );
        if (String(url).includes("GetPlanInfo")) {
          return new Response(
            JSON.stringify({ planInfo: { planName: "pro" } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            billingCycleEnd: "1783036800000",
            planUsage: { totalPercentUsed: 10 },
          }),
          { status: 200 },
        );
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(result.plan).toBe("pro");
  });

  it("requests GetSandUsageStatus and reports grok_bot beside IDE windows", async () => {
    const requested = new Set<string>();
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async (_command: string, args: string[]) => {
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken")) return '"valid-token"';
        return "";
      }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const href = String(url);
        requested.add(href.slice(href.lastIndexOf("/") + 1));
        if (href.includes("GetPlanInfo")) {
          return new Response(
            JSON.stringify({ planInfo: { planName: "ultra" } }),
            { status: 200 },
          );
        }
        if (href.includes("GetSandUsageStatus")) {
          return new Response(
            JSON.stringify({
              currentPeriodStart: "2026-08-19T21:37:33.239Z",
              nextResetTimestampUtc: "2026-08-26T21:37:33.239Z",
              usagePercent: 38.059383,
              hasNonZeroIncludedLimit: true,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            billingCycleEnd: "1783036800000",
            planUsage: { totalPercentUsed: 10 },
          }),
          { status: 200 },
        );
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect([...requested].sort()).toEqual([
      "GetCurrentPeriodUsage",
      "GetPlanInfo",
      "GetSandUsageStatus",
    ]);
    expect(result.state.status).toBe("fresh");
    expect(result.windows.map((window) => window.id)).toEqual([
      "included_usage",
      "grok_bot",
    ]);
  });

  it("keeps IDE windows when GetSandUsageStatus fails", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async (_command: string, args: string[]) => {
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken")) return '"valid-token"';
        return "";
      }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("GetSandUsageStatus")) {
          return new Response("{}", { status: 500 });
        }
        if (String(url).includes("GetPlanInfo")) {
          return new Response("{}", { status: 200 });
        }
        return new Response(
          JSON.stringify({ planUsage: { totalPercentUsed: 10 } }),
          { status: 200 },
        );
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.windows.map((window) => window.id)).toEqual([
      "included_usage",
    ]);
  });

  it("reports grok_bot when GetCurrentPeriodUsage has no IDE windows", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async (_command: string, args: string[]) => {
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken")) return '"valid-token"';
        return "";
      }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("GetSandUsageStatus")) {
          return new Response(JSON.stringify({ usagePercent: 7 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ planUsage: {} }), { status: 200 });
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.windows).toMatchObject([
      { id: "grok_bot", percentUsed: 7, percentRemaining: 93 },
    ]);
  });

  it("fails the provider when GetCurrentPeriodUsage errors, even though GetSandUsageStatus succeeds", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async (_command: string, args: string[]) => {
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken")) return '"valid-token"';
        return "";
      }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("GetCurrentPeriodUsage")) {
          return new Response("{}", { status: 500 });
        }
        if (String(url).includes("GetSandUsageStatus")) {
          return new Response(JSON.stringify({ usagePercent: 7 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ planInfo: {} }), {
          status: 200,
        });
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).not.toBe("fresh");
    expect(result.windows).toEqual([]);
  });

  it("resolves the Linux state database under XDG config home", async () => {
    delete process.env.CURSOR_STATE_DB;
    const xdgConfigHome = join(tempDir!, "xdg-config");
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.HOME = join(tempDir!, "home");
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => false),
      execFileText: vi.fn(),
    }));

    await withPlatform("linux", async () => {
      const { inspectAuth } = await import("../../src/providers/cursor.js");
      const result = await inspectAuth({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.sources).toContainEqual({
        source: "state-vscdb",
        path: join(
          xdgConfigHome,
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb",
        ),
        status: "skipped",
        error: "sqlite3_unavailable",
        credentialPresent: true,
      });
    });
  });
});
