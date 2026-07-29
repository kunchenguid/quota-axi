import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCodexHome = process.env.CODEX_HOME;
const originalCodexBinary = process.env.QUOTA_AXI_CODEX_BINARY;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-home-"));
  process.env.CODEX_HOME = tempDir;
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
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
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
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

function piAuthFile(): string {
  return join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
}

function writePiAuth(entry: Record<string, unknown>): void {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(piAuthFile(), JSON.stringify({ "openai-codex": entry }), {
    mode: 0o600,
  });
}

function piOauthEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth",
    access: "pi-fixture-access-token",
    refresh: "pi-fixture-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "acct-pi-fixture",
    ...overrides,
  };
}

function successfulUsageResponse(): Response {
  return new Response(
    JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 27,
          limit_window_seconds: 604_800,
          reset_after_seconds: 1_000,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
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
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    await fetchQuota({ allowKeychainPrompt: false });

    expect(auth.sources[2]).toEqual({
      source: "cli-rpc",
      path: binary,
      status: "available",
    });
    expect(findCommandPath).toHaveBeenCalledWith(binary);
    expect(findCommandPath).not.toHaveBeenCalledWith("codex");
    expect(spawn).toHaveBeenCalledWith(
      binary,
      ["-s", "read-only", "-a", "untrusted", "app-server"],
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
    const auth = await inspectAuth({ allowKeychainPrompt: false });

    expect(auth.sources[2]).toEqual({
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
    const auth = await inspectAuth({ allowKeychainPrompt: false });

    expect(auth.sources[2]).toEqual({
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

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
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
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

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
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

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
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": retryAfter },
        }),
    );
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

  it("reports quota from Pi openai-codex OAuth with its account header", async () => {
    writePiAuth(piOauthEntry());
    const fetchMock = vi.fn(async () => successfulUsageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(auth.sources[1]).toEqual({
      source: "pi:openai-codex",
      path: piAuthFile(),
      status: "available",
    });
    expect(result).toMatchObject({
      provider: "codex",
      source: "pi:openai-codex",
      plan: "plus",
      windows: [{ id: "weekly", percentUsed: 27, percentRemaining: 73 }],
      state: {
        status: "fresh",
        sourcesTried: ["oauth", "pi:openai-codex"],
      },
      attempts: [
        {
          source: "oauth",
          status: "skipped",
          error: "credentials_missing",
        },
        { source: "pi:openai-codex", status: "success" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({
      authorization: "Bearer pi-fixture-access-token",
      "ChatGPT-Account-Id": "acct-pi-fixture",
    });
    expect(JSON.stringify({ auth, result })).not.toContain(
      "pi-fixture-access-token",
    );
    expect(JSON.stringify({ auth, result })).not.toContain(
      "pi-fixture-refresh-token",
    );
  });

  it("preserves native Codex auth-file precedence over Pi OAuth", async () => {
    const nativeToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    writeAuth({
      tokens: { access_token: nativeToken, account_id: "acct-native" },
    });
    writePiAuth(piOauthEntry());
    const fetchMock = vi.fn(async () => successfulUsageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/codex.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.source).toBe("oauth");
    expect(result.state.sourcesTried).toEqual(["oauth"]);
    expect(result.attempts).toEqual([{ source: "oauth", status: "success" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      authorization: `Bearer ${nativeToken}`,
      "ChatGPT-Account-Id": "acct-native",
    });
  });

  it("tries Pi OAuth after native OAuth rejection and before CLI RPC", async () => {
    const nativeToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    writeAuth({ tokens: { access_token: nativeToken } });
    writePiAuth(piOauthEntry());
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const authorization = (init?.headers as Record<string, string>)
          ?.authorization;
        return authorization === `Bearer ${nativeToken}`
          ? new Response(null, { status: 401 })
          : successfulUsageResponse();
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/codex.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.source).toBe("pi:openai-codex");
    expect(result.attempts).toEqual([
      { source: "oauth", status: "failed", error: "Codex sign-in required" },
      { source: "pi:openai-codex", status: "success" },
    ]);
  });

  it("keeps CLI RPC as the final fallback after both file sources", async () => {
    const binary = join(tempDir!, "codex-fixture");
    process.env.QUOTA_AXI_CODEX_BINARY = binary;
    const child = successfulChild();
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("../../src/lib/process.js", () => ({
      findCommandPath: vi.fn(async () => binary),
      terminateChild: vi.fn(),
    }));

    const { fetchQuota } = await import("../../src/providers/codex.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.source).toBe("cli-rpc");
    expect(result.state.sourcesTried).toEqual([
      "oauth",
      "pi:openai-codex",
      "cli-rpc",
    ]);
    expect(result.attempts).toEqual([
      { source: "oauth", status: "skipped", error: "credentials_missing" },
      {
        source: "pi:openai-codex",
        status: "skipped",
        error: "credentials_missing",
      },
      { source: "cli-rpc", status: "success" },
    ]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("reports refreshable Pi expiry without using or refreshing the token", async () => {
    writePiAuth(
      piOauthEntry({
        access: "expired-pi-access-token",
        refresh: "private-refresh-token",
        expires: Date.now() - 1,
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(auth.sources[1]).toMatchObject({
      source: "pi:openai-codex",
      status: "expired",
      error: "credentials_expired_refreshable",
    });
    expect(result.state.status).toBe("auth_required");
    expect(result.attempts).toContainEqual({
      source: "pi:openai-codex",
      status: "skipped",
      error: "credentials_expired_refreshable",
      credentialPresent: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify({ auth, result })).not.toContain(
      "expired-pi-access-token",
    );
    expect(JSON.stringify({ auth, result })).not.toContain(
      "private-refresh-token",
    );
  });

  it("exposes malformed and oversized Pi files as bounded auth diagnostics", async () => {
    mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    writeFileSync(piAuthFile(), "{malformed", { mode: 0o600 });
    const { inspectAuth } = await import("../../src/providers/codex.js");

    const malformedAuth = await inspectAuth({ allowKeychainPrompt: false });
    expect(malformedAuth.sources[1]).toMatchObject({
      source: "pi:openai-codex",
      status: "invalid",
      error: "invalid_credential",
    });

    writeFileSync(piAuthFile(), Buffer.alloc(64 * 1024 + 1, 0x61), {
      mode: 0o600,
    });
    const oversizedAuth = await inspectAuth({ allowKeychainPrompt: false });
    expect(oversizedAuth.sources[1]).toMatchObject({
      source: "pi:openai-codex",
      status: "invalid",
      error: "credential_file_too_large",
    });
  });

  it("maps unsupported API keys and non-refreshable expiry into source diagnostics", async () => {
    writePiAuth({ type: "api_key", key: "unsupported-api-key" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");

    const apiKeyAuth = await inspectAuth({ allowKeychainPrompt: false });
    const apiKeyResult = await fetchQuota({ allowKeychainPrompt: false });
    expect(apiKeyAuth.sources[1]).toMatchObject({
      source: "pi:openai-codex",
      status: "invalid",
      error: "unsupported_credential_type",
    });
    expect(apiKeyResult.attempts).toContainEqual({
      source: "pi:openai-codex",
      status: "skipped",
      error: "unsupported_credential_type",
    });

    writePiAuth(
      piOauthEntry({
        access: "expired-without-refresh",
        refresh: undefined,
        expires: Date.now() - 1,
      }),
    );
    const expiredAuth = await inspectAuth({ allowKeychainPrompt: false });
    const expiredResult = await fetchQuota({ allowKeychainPrompt: false });
    expect(expiredAuth.sources[1]).toMatchObject({
      source: "pi:openai-codex",
      status: "expired",
      error: "credentials_expired",
    });
    expect(expiredResult.attempts).toContainEqual({
      source: "pi:openai-codex",
      status: "skipped",
      error: "credentials_expired",
      credentialPresent: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      JSON.stringify({
        apiKeyAuth,
        apiKeyResult,
        expiredAuth,
        expiredResult,
      }),
    ).not.toMatch(/unsupported-api-key|expired-without-refresh/);
  });

  it("redacts Pi access tokens from transport failures and never retains refresh tokens", async () => {
    const accessToken = "pi-access-token-must-never-render";
    const refreshToken = "pi-refresh-token-must-never-render";
    writePiAuth(piOauthEntry({ access: accessToken, refresh: refreshToken }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`transport accidentally mentioned ${accessToken}`);
      }),
    );

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/codex.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });
    const rendered = JSON.stringify({ auth, result });

    expect(rendered).not.toContain(accessToken);
    expect(rendered).not.toContain(refreshToken);
    expect(rendered).toContain("[redacted]");
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

function successfulChild(): ChildProcessWithoutNullStreams {
  const child = failingChild();
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id: number; method: string };
      const result =
        request.method === "account/read"
          ? { account: { planType: "plus" } }
          : request.method === "account/rateLimits/read"
            ? {
                rateLimits: {
                  primary: {
                    usedPercent: 12,
                    windowDurationMins: 300,
                  },
                },
              }
            : {};
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    }
  });
  return child;
}
