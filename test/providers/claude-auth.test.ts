import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function useTempHome(): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-home-"));
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  return tempDir;
}

describe("Claude credential-state reporting", () => {
  it("surfaces expired file credentials as a skipped attempt and auth_required", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "expired-token", expiresAt: 1 } }),
    );

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Claude sign-in required");
    expect(result.attempts).toContainEqual({
      source: "oauth-file",
      status: "skipped",
      error: "credentials_expired",
    });
  });

  it("surfaces missing file credentials as a skipped attempt and auth_required", async () => {
    useTempHome();

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Claude sign-in required");
    expect(result.attempts).toContainEqual({
      source: "oauth-file",
      status: "skipped",
      error: "credentials_missing",
    });
  });

  it("surfaces malformed file credentials as invalid auth", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{not-json");

    const { inspectAuth } = await import("../../src/providers/claude.js");
    const result = await inspectAuth({ allowKeychainPrompt: false });

    expect(result.sources[0]).toMatchObject({
      source: "oauth-file",
      path: join(home, ".claude", ".credentials.json"),
      status: "invalid",
      error: "json_parse_error",
    });
  });
});
