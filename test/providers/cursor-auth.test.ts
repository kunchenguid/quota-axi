import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCursorStateDb = process.env.CURSOR_STATE_DB;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cursor-auth-"));
  process.env.CURSOR_STATE_DB = join(tempDir, "state.vscdb");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  if (originalCursorStateDb === undefined) delete process.env.CURSOR_STATE_DB;
  else process.env.CURSOR_STATE_DB = originalCursorStateDb;
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

  it("preserves skipped sqlite discovery failures", async () => {
    vi.doMock("../../src/lib/process.js", () => ({
      commandExists: vi.fn(async () => false),
      execFileText: vi.fn(),
    }));

    const { fetchQuota } = await import("../../src/providers/cursor.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("sqlite3_unavailable");
    expect(result.attempts).toContainEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "sqlite3_unavailable",
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
});
