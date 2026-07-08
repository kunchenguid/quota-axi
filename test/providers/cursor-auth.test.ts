import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCursorStateDb = process.env.CURSOR_STATE_DB;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
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
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

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
});
