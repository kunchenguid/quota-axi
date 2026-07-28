import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function writeCliAuth(payload: unknown): void {
  writeFileSync(process.env.CURSOR_CLI_AUTH_JSON!, JSON.stringify(payload), {
    mode: 0o600,
  });
}

const originalCursorStateDb = process.env.CURSOR_STATE_DB;
const originalCursorCliConfig = process.env.CURSOR_CLI_CONFIG;
const originalCliAuthJson = process.env.CURSOR_CLI_AUTH_JSON;
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
  // Isolated to a nonexistent-by-default path so tests never fall through to
  // the real ~/.config/cursor/auth.json (and its live API) on this machine.
  process.env.CURSOR_CLI_AUTH_JSON = join(tempDir, "cursor-cli-auth.json");
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
  if (originalCliAuthJson === undefined)
    delete process.env.CURSOR_CLI_AUTH_JSON;
  else process.env.CURSOR_CLI_AUTH_JSON = originalCliAuthJson;
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
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Cursor sign-in required");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "credentials_missing",
    });
  });

  it("falls through past a skipped sqlite discovery failure to cursor-cli-auth (G5)", async () => {
    // Before the CLI fallback existed, sqlite3-unavailable was a terminal
    // "error" state. G5 requires it to fall through instead; when the CLI
    // source is also unavailable, the combined outcome is now the generic
    // sign-in message, with both sources visible in attempts.
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => false),
      execFileText: vi.fn(),
    }));

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Cursor sign-in required");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "sqlite3_unavailable",
    });
    expect(result.attempts).toContainEqual({
      source: "cursor-cli-auth",
      status: "skipped",
      error: "credentials_missing",
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
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("sqlite_read_error");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "sqlite_read_error",
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
    const result = await inspectAuth({ allowKeychainPrompt: false });

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
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(result.plan).toBe("pro");
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
      const result = await inspectAuth({ allowKeychainPrompt: false });

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
      });
    });
  });

  it("falls back to cursor-cli-auth and succeeds when sqlite3 is absent (G5)", async () => {
    writeCliAuth({ accessToken: "opaque-cli-fixture-token" });
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => false),
      execFileText: vi.fn(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer opaque-cli-fixture-token",
        );
        if (String(url).includes("GetPlanInfo")) {
          return new Response(
            JSON.stringify({ planInfo: { planName: "pro" } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ planUsage: { totalPercentUsed: 5 } }),
          { status: 200 },
        );
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("api");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "sqlite3_unavailable",
    });
  });

  it("sends x-cursor-client-* headers for a CLI-origin request but not an editor-origin one", async () => {
    writeCliAuth({ accessToken: "opaque-cli-header-token" });
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(
        async (command: string) => command === "cursor-agent",
      ),
      execFileText: vi.fn(async () => "9.9.9\n"),
    }));
    const seenHeaders: Array<Headers> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({ planUsage: { totalPercentUsed: 1 } }),
          {
            status: 200,
          },
        );
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    for (const headers of seenHeaders) {
      expect(headers.get("x-cursor-client-type")).toBe("cli");
      expect(headers.get("x-cursor-client-version")).toBe("9.9.9");
    }
  });

  it("does not send x-cursor-client-* headers for an editor-origin (state-vscdb) request", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async (_command: string, args: string[]) => {
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken")) return '"editor-token"';
        return "";
      }),
    }));
    const seenHeaders: Array<Headers> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({ planUsage: { totalPercentUsed: 1 } }),
          {
            status: 200,
          },
        );
      }),
    );

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(seenHeaders.length).toBeGreaterThan(0);
    for (const headers of seenHeaders) {
      expect(headers.has("x-cursor-client-type")).toBe(false);
      expect(headers.has("x-cursor-client-version")).toBe(false);
    }
  });

  it("reports sign-in required on win32 where cursor-cli-auth is platform-skipped", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => {
        throw new Error("unable to open database file");
      }),
    }));

    await withPlatform("win32", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota({ allowKeychainPrompt: false });

      expect(result.state.status).toBe("auth_required");
      expect(result.state.error).toBe("Cursor sign-in required");
      expect(result.attempts).toContainEqual({
        source: "cursor-cli-auth",
        status: "skipped",
        error: "unsupported_platform",
      });
    });
  });

  it("reports auth_required with both sources listed when both are missing", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => {
        throw new Error("unable to open database file");
      }),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/cursor.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Cursor sign-in required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "credentials_missing",
    });
    expect(result.attempts).toContainEqual({
      source: "cursor-cli-auth",
      status: "skipped",
      error: "credentials_missing",
    });

    const authReport = await inspectAuth({ allowKeychainPrompt: false });
    expect(authReport.sources).toHaveLength(2);
    expect(authReport.sources.map((source) => source.source)).toEqual([
      "state-vscdb",
      "cursor-cli-auth",
    ]);
  });
});
