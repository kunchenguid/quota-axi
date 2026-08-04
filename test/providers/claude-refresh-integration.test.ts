import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

const originalHome = process.env.HOME;
const originalUser = process.env.USER;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  usePlatform("linux");
  process.env.USER = "fixture-user";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.useRealTimers();
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
  restoreEnv("HOME", originalHome);
  restoreEnv("USER", originalUser);
  restoreEnv("USERPROFILE", originalUserProfile);
  restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
  restoreEnv("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
  process.exitCode = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function useTempHome(): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-home-"));
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  return tempDir;
}

function writeClaudeCredential(
  configDir: string,
  oauth: Record<string, unknown>,
): string {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, ".credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }), {
    mode: 0o600,
  });
  return path;
}

function readOauth(path: string): Record<string, unknown> {
  return (
    JSON.parse(readFileSync(path, "utf8")) as {
      claudeAiOauth: Record<string, unknown>;
    }
  ).claudeAiOauth;
}

function usageResponse(): Response {
  return new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
    status: 200,
  });
}

/**
 * A fetch router keyed by URL. `usage` is an array of responders consumed in
 * order across successive usage calls; `token` handles the refresh endpoint.
 */
function router(opts: {
  usage: Array<() => Promise<Response>>;
  token?: () => Promise<Response>;
  profile?: () => Promise<Response>;
}): { fetch: ReturnType<typeof vi.fn>; usageCalls: () => number } {
  let usageIndex = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      if (!opts.token) throw new Error(`unexpected token call`);
      return opts.token();
    }
    if (url === PROFILE_URL) {
      return opts.profile
        ? opts.profile()
        : new Response(
            JSON.stringify({
              account: { uuid: "11111111-2222-4333-8444-555555555555" },
            }),
            { status: 200 },
          );
    }
    if (url === USAGE_URL) {
      const responder = opts.usage[Math.min(usageIndex, opts.usage.length - 1)];
      usageIndex += 1;
      return responder();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetch: fetchMock, usageCalls: () => usageIndex };
}

const EXPIRED = "2000-01-01T00:00:00.000Z";

describe("Claude quota refresh integration", () => {
  it("refreshes once and retries usage once when the access token is rejected", async () => {
    const home = useTempHome();
    const path = writeClaudeCredential(join(home, ".claude"), {
      accessToken: "expired-access",
      refreshToken: "refresh-1",
      expiresAt: EXPIRED,
      subscriptionType: "max",
    });
    const { fetch: fetchMock } = router({
      usage: [
        async () => new Response(null, { status: 401 }),
        async () => usageResponse(),
      ],
      token: async () =>
        new Response(
          JSON.stringify({
            access_token: "renewed-access",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("oauth");
    // exactly one refresh, exactly one usage retry (two usage calls total)
    expect(fetchMock.mock.calls.filter(([u]) => u === TOKEN_URL)).toHaveLength(
      1,
    );
    expect(fetchMock.mock.calls.filter(([u]) => u === USAGE_URL)).toHaveLength(
      2,
    );
    // the retry used the renewed bearer
    const retry = fetchMock.mock.calls.filter(([u]) => u === USAGE_URL)[1];
    expect((retry?.[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer renewed-access",
    });
    // renewed credential persisted back to the same file
    const written = readOauth(path);
    expect(written.accessToken).toBe("renewed-access");
    expect(written.refreshToken).toBe("refresh-2");
    expect(written.subscriptionType).toBe("max");
    // the refresh attempt is surfaced without secrets
    expect(result.attempts).toContainEqual({
      source: "oauth-refresh",
      status: "success",
    });
    expect(result.state.sourcesTried).toContain("oauth-refresh");
  });

  it("does not attempt a refresh when the expired credential has no refresh token", async () => {
    const home = useTempHome();
    writeClaudeCredential(join(home, ".claude"), {
      accessToken: "expired-access",
      expiresAt: EXPIRED,
    });
    const { fetch: fetchMock } = router({
      usage: [async () => new Response(null, { status: 401 })],
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Claude sign-in required");
    expect(fetchMock.mock.calls.filter(([u]) => u === TOKEN_URL)).toHaveLength(
      0,
    );
    expect(fetchMock.mock.calls.filter(([u]) => u === USAGE_URL)).toHaveLength(
      1,
    );
    expect(result.attempts).not.toContainEqual(
      expect.objectContaining({ source: "oauth-refresh" }),
    );
  });

  it("refreshes at most once even when the retried usage also rejects", async () => {
    const home = useTempHome();
    const path = writeClaudeCredential(join(home, ".claude"), {
      accessToken: "expired-access",
      refreshToken: "refresh-1",
      expiresAt: EXPIRED,
    });
    const originalOauth = readOauth(path);
    const { fetch: fetchMock } = router({
      usage: [
        async () => new Response(null, { status: 401 }),
        async () => new Response(null, { status: 401 }),
      ],
      token: async () =>
        new Response(
          JSON.stringify({ access_token: "renewed-access", expires_in: 3600 }),
          { status: 200 },
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(fetchMock.mock.calls.filter(([u]) => u === TOKEN_URL)).toHaveLength(
      1,
    );
    expect(fetchMock.mock.calls.filter(([u]) => u === USAGE_URL)).toHaveLength(
      2,
    );
    // the renewed token was written (the refresh itself succeeded)
    expect(readOauth(path).accessToken).toBe("renewed-access");
    expect(originalOauth.accessToken).toBe("expired-access");
  });

  it("treats a rejected refresh token as a definitive sign-in and preserves the file", async () => {
    const home = useTempHome();
    const path = writeClaudeCredential(join(home, ".claude"), {
      accessToken: "expired-access",
      refreshToken: "refresh-1",
      expiresAt: EXPIRED,
    });
    const before = readFileSync(path, "utf8");
    const { fetch: fetchMock } = router({
      usage: [async () => new Response(null, { status: 401 })],
      token: async () => new Response("invalid_grant", { status: 400 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Claude sign-in required");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(result.attempts).toContainEqual({
      source: "oauth-refresh",
      status: "failed",
      error: "refresh_rejected",
    });
  });

  it("keeps the valid session on a transient refresh failure and serves stale cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    const home = useTempHome();
    const path = writeClaudeCredential(join(home, ".claude"), {
      accessToken: "expired-access",
      refreshToken: "refresh-1",
      expiresAt: EXPIRED,
    });
    const before = readFileSync(path, "utf8");
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([
      {
        provider: "claude",
        label: "Claude",
        source: "oauth",
        windows: [
          {
            id: "five_hour",
            label: "session",
            kind: "session",
            percentUsed: 34,
            percentRemaining: 66,
          },
        ],
        state: {
          status: "fresh",
          stale: false,
          refreshedAt: "2026-07-06T18:10:00Z",
          sourcesTried: ["oauth"],
        },
      },
    ]);
    const { fetch: fetchMock } = router({
      usage: [async () => new Response(null, { status: 401 })],
      token: async () => {
        throw new TypeError("network down");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.source).toBe("cache");
    expect(result.state.status).toBe("stale");
    // credential untouched, refresh attempt surfaced transiently
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(result.attempts).toContainEqual({
      source: "oauth-refresh",
      status: "failed",
      error: "refresh_unreachable",
    });
  });

  it("refreshes and writes back to the selected profile's credential file only", async () => {
    const home = useTempHome();
    const profileDir = join(home, "managed-claude");
    process.env.CLAUDE_CONFIG_DIR = profileDir;
    const path = writeClaudeCredential(profileDir, {
      accessToken: "expired-access",
      refreshToken: "refresh-1",
      expiresAt: EXPIRED,
    });
    // a default-profile credential that must never be touched
    const defaultPath = writeClaudeCredential(join(home, ".claude"), {
      accessToken: "default-access",
      refreshToken: "default-refresh",
      expiresAt: EXPIRED,
    });
    const defaultBefore = readFileSync(defaultPath, "utf8");
    const { fetch: fetchMock } = router({
      usage: [
        async () => new Response(null, { status: 401 }),
        async () => usageResponse(),
      ],
      token: async () =>
        new Response(
          JSON.stringify({ access_token: "renewed-access", expires_in: 3600 }),
          { status: 200 },
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(readOauth(path).accessToken).toBe("renewed-access");
    // the unrelated default profile is never written
    expect(readFileSync(defaultPath, "utf8")).toBe(defaultBefore);
  });

  it("refreshes a Keychain credential and updates the exact pinned item", async () => {
    usePlatform("darwin");
    useTempHome();
    const { claudeKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const marker = claudeKeychainAccessMarkerPath("fixture-user");
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "granted\n", { mode: 0o600 });

    const keychainBlob = JSON.stringify({
      claudeAiOauth: {
        accessToken: "expired-access",
        refreshToken: "refresh-1",
        expiresAt: 0,
      },
    });
    const execFileText = vi.fn(async (_cmd: string, args: string[]) =>
      args[0] === "find-generic-password" && args.includes("-w")
        ? keychainBlob
        : "",
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const { fetch: fetchMock } = router({
      usage: [
        async () => new Response(null, { status: 401 }),
        async () => usageResponse(),
      ],
      token: async () =>
        new Response(
          JSON.stringify({ access_token: "renewed-access", expires_in: 3600 }),
          { status: 200 },
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    const write = execFileText.mock.calls.find(
      ([, args]) => args[0] === "add-generic-password",
    );
    expect(write?.[1].slice(0, 6)).toEqual([
      "add-generic-password",
      "-U",
      "-a",
      "fixture-user",
      "-s",
      "Claude Code-credentials",
    ]);
  });

  it("never refreshes a Keychain credential that was not read (no access marker)", async () => {
    usePlatform("darwin");
    useTempHome();
    // Keychain item present but no access marker: the value is never read, so
    // no refresh handle exists and no token endpoint call can occur.
    const execFileText = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("-w")) throw new Error("value read must not happen");
      return "";
    });
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const { fetch: fetchMock } = router({ usage: [] });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(fetchMock.mock.calls.filter(([u]) => u === TOKEN_URL)).toHaveLength(
      0,
    );
    expect(result.attempts).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_prompt_required",
      credentialPresent: true,
    });
  });

  it("never exposes tokens or refresh tokens in full JSON output", async () => {
    const home = useTempHome();
    writeClaudeCredential(join(home, ".claude"), {
      accessToken: "expired-access",
      refreshToken: "super-secret-refresh",
      expiresAt: EXPIRED,
    });
    const { fetch: fetchMock } = router({
      usage: [
        async () => new Response(null, { status: 401 }),
        async () => usageResponse(),
      ],
      token: async () =>
        new Response(
          JSON.stringify({
            access_token: "renewed-secret-access",
            refresh_token: "rotated-secret-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    });
    vi.stubGlobal("fetch", fetchMock);
    const chunks: string[] = [];
    const { main } = await import("../../src/cli.js");
    await main({
      argv: ["--provider", "claude", "--json", "--full"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = chunks.join("");
    expect(output).toContain('"status": "fresh"');
    expect(output).not.toContain("super-secret-refresh");
    expect(output).not.toContain("rotated-secret-refresh");
    expect(output).not.toContain("renewed-secret-access");
    expect(output).not.toContain("expired-access");
  });
});
