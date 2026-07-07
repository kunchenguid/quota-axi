import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCodexHome = process.env.CODEX_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-home-"));
  process.env.CODEX_HOME = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  vi.doMock("../../src/lib/process.js", () => ({
    commandExists: vi.fn(async () => false),
    terminateChild: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function authFile(): string {
  return join(tempDir!, "auth.json");
}

function writeAuth(value: unknown): void {
  writeFileSync(authFile(), typeof value === "string" ? value : JSON.stringify(value));
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("Codex credential-state reporting", () => {
  it("does not send OPENAI_API_KEY to ChatGPT OAuth usage endpoints", async () => {
    writeAuth({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } = await import("../../src/providers/codex.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(auth.sources[0]).toMatchObject({
      source: "auth-json",
      path: authFile(),
      status: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.attempts).toContainEqual({
      source: "oauth",
      status: "skipped",
      error: "credentials_invalid",
    });
  });

  it("surfaces expired JWT credentials without probing OAuth usage", async () => {
    writeAuth({ tokens: { access_token: jwt({ exp: 1 }) } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } = await import("../../src/providers/codex.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(auth.sources[0]).toMatchObject({
      source: "auth-json",
      path: authFile(),
      status: "expired",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state.status).toBe("auth_required");
    expect(result.attempts).toContainEqual({
      source: "oauth",
      status: "skipped",
      error: "credentials_expired",
    });
  });

  it("surfaces malformed auth JSON as invalid", async () => {
    writeAuth("{not-json");

    const { inspectAuth } = await import("../../src/providers/codex.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });

    expect(auth.sources[0]).toMatchObject({
      source: "auth-json",
      path: authFile(),
      status: "invalid",
      error: "json_parse_error",
    });
  });

  it("preserves retry metadata when OAuth usage is rate limited", async () => {
    const retryAfter = "2030-01-01T00:00:00.000Z";
    writeAuth({
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      },
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": retryAfter } }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/codex.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.state.status).toBe("rate_limited");
    expect(result.state.error).toBe("Codex quota endpoint rate limited");
    expect(result.state.retryAfter).toBe(retryAfter);
    expect(result.attempts).toContainEqual({
      source: "oauth",
      status: "failed",
      error: "Codex quota endpoint rate limited",
    });
  });
});
