import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCodexHome = process.env.CODEX_HOME;
const originalCodexBinary = process.env.QUOTA_AXI_CODEX_BINARY;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-home-"));
  process.env.CODEX_HOME = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  vi.doMock("../../src/lib/process.js", () => ({
    findCommandPath: vi.fn(async () => undefined),
    terminateChild: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.doUnmock("node:child_process");
  vi.resetModules();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalCodexBinary === undefined)
    delete process.env.QUOTA_AXI_CODEX_BINARY;
  else process.env.QUOTA_AXI_CODEX_BINARY = originalCodexBinary;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function authFile(): string {
  return join(tempDir!, "auth.json");
}

function writeAuth(value: unknown): void {
  writeFileSync(
    authFile(),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("Codex credential-state reporting", () => {
  it("uses the configured absolute executable for auth inspection and RPC fallback", async () => {
    const binary = join(tempDir!, "pinned", "codex");
    process.env.QUOTA_AXI_CODEX_BINARY = binary;
    const findCommandPath = vi.fn(async (command: string) => command);
    const terminateChild = vi.fn();
    vi.doMock("../../src/lib/process.js", () => ({
      findCommandPath,
      terminateChild,
    }));
    const child = failingChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("fixture stop")));
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn }));

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: false });

    expect(auth.sources[1]).toEqual({
      source: "cli-rpc",
      path: binary,
      status: "available",
    });
    expect(findCommandPath).toHaveBeenCalledWith(binary);
    expect(findCommandPath).not.toHaveBeenCalledWith("codex");
    expect(spawn).toHaveBeenCalledWith(
      binary,
      ["-s", "read-only", "-a", "never", "app-server"],
      expect.any(Object),
    );
  });

  it("fails closed instead of consulting PATH for a non-absolute override", async () => {
    process.env.QUOTA_AXI_CODEX_BINARY = "codex-from-path";
    const findCommandPath = vi.fn(async () => "/unexpected/codex");
    vi.doMock("../../src/lib/process.js", () => ({
      findCommandPath,
      terminateChild: vi.fn(),
    }));

    const { inspectAuth } = await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[1]).toEqual({
      source: "cli-rpc",
      path: undefined,
      status: "missing",
      error: "codex_binary_override_not_absolute",
    });
    expect(findCommandPath).not.toHaveBeenCalled();
  });

  it("reports an absolute override that is not executable without falling back", async () => {
    const binary = join(tempDir!, "missing", "codex");
    process.env.QUOTA_AXI_CODEX_BINARY = binary;
    const findCommandPath = vi.fn(async () => undefined);
    vi.doMock("../../src/lib/process.js", () => ({
      findCommandPath,
      terminateChild: vi.fn(),
    }));

    const { inspectAuth } = await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[1]).toEqual({
      source: "cli-rpc",
      path: binary,
      status: "missing",
      error: "codex_binary_override_not_executable",
    });
    expect(findCommandPath).toHaveBeenCalledOnce();
    expect(findCommandPath).toHaveBeenCalledWith(binary);
  });

  it("does not send OPENAI_API_KEY to ChatGPT OAuth usage endpoints", async () => {
    writeAuth({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

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

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

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

  it("treats access-token usability as authoritative when id_token is expired", async () => {
    // Counterfactual: the previous OR-expiry check treated id_token exp as
    // credential expiry and skipped OAuth even with a valid access token.
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    writeAuth({
      tokens: {
        id_token: jwt({ exp: 1, email: "codex-fixture@example.invalid" }),
        access_token: jwt({ exp: futureExp }),
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 10,
                reset_after_seconds: 1000,
                limit_window_seconds: 18_000,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[0]).toMatchObject({
      source: "auth-json",
      path: authFile(),
      status: "available",
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(result.source).toBe("oauth");
    expect(result.state.status).toBe("fresh");
    expect(result.attempts).toContainEqual({
      source: "oauth",
      status: "success",
    });
    expect(JSON.stringify(result)).not.toContain(
      "codex-fixture@example.invalid",
    );
  });

  it("still skips OAuth when the access token JWT itself is expired", async () => {
    writeAuth({
      tokens: {
        id_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        access_token: jwt({ exp: 1 }),
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[0]?.status).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.attempts).toContainEqual({
      source: "oauth",
      status: "skipped",
      error: "credentials_expired",
    });
  });

  it("surfaces malformed auth JSON as invalid", async () => {
    writeAuth("{not-json");

    const { inspectAuth } = await import("../../src/providers/codex.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

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
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": retryAfter },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/codex.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

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

function failingChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  return child;
}
