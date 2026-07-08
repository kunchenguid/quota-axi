import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  usePlatform("linux");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.useRealTimers();
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
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

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("Claude credential-state reporting", () => {
  it("surfaces expired file credentials as a skipped attempt and auth_required", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "expired-token", expiresAt: 0 },
      }),
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

  it("surfaces expired ISO-string file credentials without probing usage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(auth.sources[0]).toMatchObject({
      source: "oauth-file",
      path: join(home, ".claude", ".credentials.json"),
      status: "expired",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state.status).toBe("auth_required");
    expect(result.attempts).toContainEqual({
      source: "oauth-file",
      status: "skipped",
      error: "credentials_expired",
    });
  });

  it("sends the Claude Code User-Agent when probing usage", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringMatching(/^claude-code\/\d+\.\d+\.\d+/),
          "Content-Type": "application/json",
        }),
      }),
    );
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

  it("does not attempt a default keychain value read without the access marker", async () => {
    usePlatform("darwin");
    useTempHome();
    const execFileText = vi.fn(async () => "");
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(execFileText).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      expect.any(Number),
    );
    expect(execFileText).not.toHaveBeenCalledWith(
      "security",
      expect.arrayContaining(["-w"]),
      expect.any(Number),
    );
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_prompt_required",
      credentialPresent: true,
    });
    expect(result.attempts).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_prompt_required",
      credentialPresent: true,
    });
  });

  it("uses the keychain value on a default call when the access marker exists", async () => {
    usePlatform("darwin");
    useTempHome();
    const marker = await writeKeychainAccessMarker();
    const execFileText = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-keychain-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(marker).toContain("claude-keychain-access-granted");
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      expect.any(Number),
    );
    expect(execFileText).not.toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      expect.any(Number),
    );
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "available",
    });
    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("oauth");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer fresh-keychain-token",
        }),
      }),
    );
  });

  it("writes the keychain access marker after an explicit allowed value read", async () => {
    usePlatform("darwin");
    useTempHome();
    const { claudeKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const execFileText = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-keychain-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
            status: 200,
          }),
      ),
    );

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: true });

    expect(result.state.status).toBe("fresh");
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      expect.any(Number),
    );
    expect(existsSync(claudeKeychainAccessMarkerPath())).toBe(true);
  });

  it("refreshes the cache after a successful default keychain read", async () => {
    usePlatform("darwin");
    useTempHome();
    await writeKeychainAccessMarker();
    const execFileText = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-keychain-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
            status: 200,
          }),
      ),
    );
    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(80)]);
    const chunks: string[] = [];

    const { main } = await import("../../src/cli.js");
    await main({
      argv: ["--provider", "claude", "--json"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = JSON.parse(chunks.join("")) as {
      providers: Array<{ state: { status: string } }>;
    };
    expect(output.providers[0]?.state.status).toBe("fresh");
    expect(readCachedProvider("claude")?.windows[0]?.percentUsed).toBe(12);
  });

  it("does not mark keychain prompt required when the keychain item is missing", async () => {
    usePlatform("darwin");
    useTempHome();
    const missing = Object.assign(new Error("not found"), { code: 44 });
    const execFileText = vi.fn(async () => {
      throw missing;
    });
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({ allowKeychainPrompt: false });
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "missing",
    });
    expect(result.attempts).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "credentials_missing",
    });
    expect(result.attempts).not.toContainEqual(
      expect.objectContaining({
        source: "keychain",
        error: "keychain_prompt_required",
      }),
    );
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

async function writeKeychainAccessMarker(): Promise<string> {
  const { claudeKeychainAccessMarkerPath } =
    await import("../../src/lib/fs.js");
  const marker = claudeKeychainAccessMarkerPath();
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  writeFileSync(marker, "granted\n", { mode: 0o600 });
  return marker;
}

function cachedClaudeQuota(percentUsed: number) {
  return {
    provider: "claude" as const,
    label: "Claude",
    source: "oauth" as const,
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session" as const,
        percentUsed,
        percentRemaining: 100 - percentUsed,
      },
    ],
    state: {
      status: "fresh" as const,
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["oauth"],
    },
  };
}
