import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { annotateQuotaAdvice } from "../../src/advice.js";
import type { ProviderQuota } from "../../src/types.js";

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
  vi.doUnmock("node:os");
  vi.useRealTimers();
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUser === undefined) delete process.env.USER;
  else process.env.USER = originalUser;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalClaudeConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  process.exitCode = undefined;
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
  it("uses nonempty USER for the Keychain account before userInfo", async () => {
    const userInfoMock = vi.fn(() => ({ username: "system-user" }));
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return { ...actual, userInfo: userInfoMock };
    });
    process.env.USER = "environment-user";

    const { claudeKeychainAccount } =
      await import("../../src/providers/claude.js");

    expect(claudeKeychainAccount()).toBe("environment-user");
    expect(userInfoMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("falls back to userInfo when USER is %s", async (_label, user) => {
    if (user === undefined) delete process.env.USER;
    else process.env.USER = user;
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return {
        ...actual,
        userInfo: () => ({ ...actual.userInfo(), username: "system-user" }),
      };
    });

    const { claudeKeychainAccount } =
      await import("../../src/providers/claude.js");

    expect(claudeKeychainAccount()).toBe("system-user");
  });

  it("uses Claude Code's fallback for an invalid USER", async () => {
    process.env.USER = "unsafe account";

    const { claudeKeychainAccount } =
      await import("../../src/providers/claude.js");

    expect(claudeKeychainAccount()).toBe("claude-code-user");
  });

  it("uses Claude Code's fallback when userInfo lookup fails", async () => {
    delete process.env.USER;
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return {
        ...actual,
        userInfo: () => {
          throw new Error("lookup failed");
        },
      };
    });

    const { claudeKeychainAccount } =
      await import("../../src/providers/claude.js");

    expect(claudeKeychainAccount()).toBe("claude-code-user");
  });

  it("uses CLAUDE_CONFIG_DIR for file credentials", async () => {
    const home = useTempHome();
    const configDir = join(home, "managed-claude");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
            status: 200,
          }),
      ),
    );

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[0]).toMatchObject({
      source: "oauth-file",
      path: join(configDir, ".credentials.json"),
      status: "available",
    });
    expect(result.state.status).toBe("fresh");
  });

  it("derives the custom-config Keychain service from the literal config path", async () => {
    usePlatform("darwin");
    const home = useTempHome();
    const configDir = join(home, "managed-claude");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const suffix = createHash("sha256")
      .update(configDir)
      .digest("hex")
      .slice(0, 8);
    const execFileText = vi.fn(async () => "");
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));

    const { inspectAuth } = await import("../../src/providers/claude.js");
    await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-s",
        `Claude Code-credentials-${suffix}`,
      ],
      expect.any(Number),
    );
  });

  it("preserves an empty-present CLAUDE_CONFIG_DIR across profile derivations", async () => {
    usePlatform("darwin");
    const home = useTempHome();
    process.env.CLAUDE_CONFIG_DIR = "";
    const { claudeKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const marker = claudeKeychainAccessMarkerPath("fixture-user", "");
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "granted\n", { mode: 0o600 });
    const execFileText = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-keychain-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));

    const { claudeCredentialFile, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(claudeCredentialFile()).toBe(".credentials.json");
    expect(marker).toMatch(
      new RegExp(
        `^${join(home, "cache", "quota-axi", "claude-keychain-access-granted-account-")}[0-9a-f]{16}$`,
      ),
    );
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Number),
    );
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "available",
    });
  });

  it("normalizes a decomposed CLAUDE_CONFIG_DIR before profile derivations", async () => {
    usePlatform("darwin");
    const home = useTempHome();
    const decomposedConfigDir = join(home, "managed-e\u0301");
    const normalizedConfigDir = decomposedConfigDir.normalize("NFC");
    process.env.CLAUDE_CONFIG_DIR = decomposedConfigDir;
    mkdirSync(normalizedConfigDir, { recursive: true });
    writeFileSync(
      join(normalizedConfigDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-file-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    const { claudeKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const marker = claudeKeychainAccessMarkerPath(
      "fixture-user",
      normalizedConfigDir,
    );
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "granted\n", { mode: 0o600 });
    const suffix = createHash("sha256")
      .update(normalizedConfigDir)
      .digest("hex")
      .slice(0, 8);
    const execFileText = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-keychain-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));

    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[0]).toMatchObject({
      source: "oauth-file",
      path: join(normalizedConfigDir, ".credentials.json"),
      status: "available",
    });
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        `Claude Code-credentials-${suffix}`,
      ],
      expect.any(Number),
    );
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "available",
    });
  });

  it("treats expiry metadata as advisory and lets a 401 decide authentication", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "expired-token", expiresAt: 0 },
      }),
    );
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[0]).toMatchObject({ status: "expired" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Claude sign-in required");
    expect(result.attempts).toContainEqual({
      source: "oauth-file",
      status: "failed",
      error: "Claude sign-in required",
    });
  });

  it("returns fresh quota when an advisory-expired file token still succeeds", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-token",
          expiresAt: "2000-01-01T00:00:00.000Z",
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

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources[0]).toMatchObject({
      source: "oauth-file",
      path: join(home, ".claude", ".credentials.json"),
      status: "expired",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("oauth");
    expect(result.attempts).toContainEqual({
      source: "oauth-file",
      status: "success",
    });
  });

  it("verifies advisory expiry and retires stale cache after a definitive 401 through the real CLI", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-token",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      }),
    );
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(34)]);
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

    const output = JSON.parse(chunks.join("")) as {
      providers: Array<{
        source: string;
        windows: unknown[];
        state: { status: string; stale: boolean; error?: string };
        attempts?: Array<{ source: string; status: string; error?: string }>;
      }>;
    };
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output.providers[0]).toMatchObject({
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: "Claude sign-in required",
      },
    });
    expect(output.providers[0]?.attempts).toContainEqual({
      source: "oauth-file",
      status: "failed",
      error: "Claude sign-in required",
    });
    expect(readCachedProvider("claude")).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["missing", undefined, "credentials_missing"],
    [
      "invalid",
      JSON.stringify({ claudeAiOauth: { expiresAt: "2035-01-01" } }),
      "credentials_invalid",
    ],
  ])(
    "retires stale cache for %s credentials without a usable token",
    async (_label, credentialFile, expectedError) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
      const home = useTempHome();
      if (credentialFile !== undefined) {
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(
          join(home, ".claude", ".credentials.json"),
          credentialFile,
        );
      }
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { readCachedProvider, writeCachedProviders } =
        await import("../../src/cache.js");
      writeCachedProviders([cachedClaudeQuota(34)]);

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        source: "unavailable",
        windows: [],
        state: {
          status: "auth_required",
          stale: false,
          error: expectedError,
        },
      });
      expect(result.attempts).toContainEqual({
        source: "oauth-file",
        status: "skipped",
        error: expectedError,
      });
      expect(readCachedProvider("claude")).toBeUndefined();
    },
  );

  it.each([401, 403])(
    "bypasses and retires stale cache after usage HTTP %i",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
      const home = useTempHome();
      writeClaudeCredential(home, {
        accessToken: "future-token",
        expiresAt: "2035-01-01T00:00:00.000Z",
      });
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const { readCachedProvider, writeCachedProviders } =
        await import("../../src/cache.js");
      writeCachedProviders([cachedClaudeQuota(34)]);

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        source: "unavailable",
        windows: [],
        state: {
          status: "auth_required",
          stale: false,
          error: "Claude sign-in required",
        },
      });
      expect(readCachedProvider("claude")).toBeUndefined();
    },
  );

  it("uses an eligible bounded snapshot for timeout, network, 429, and 5xx failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    const home = useTempHome();
    writeClaudeCredential(home, {
      accessToken: "advisory-expired-token",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(34)]);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const failures: Array<[string, () => Promise<Response>]> = [
      [
        "timeout",
        async () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
      ],
      [
        "network",
        async () => {
          throw new TypeError("network unavailable");
        },
      ],
      [
        "429",
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "60" },
          }),
      ],
      ["5xx", async () => new Response(null, { status: 503 })],
    ];

    for (const [label, failure] of failures) {
      vi.stubGlobal("fetch", vi.fn(failure));
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.source, label).toBe("cache");
      expect(result.state.status, label).toBe("stale");
      expect(result.state.error, label).toBeTruthy();
      expect(
        result.windows.map(({ id }) => id),
        label,
      ).toEqual(["five_hour"]);
    }
  });

  it.each(["5xx", "timeout"])(
    "does not advise Keychain access after an oauth-file %s failure",
    async (failureKind) => {
      usePlatform("darwin");
      const home = useTempHome();
      const fakeToken = "test-claude-oauth-token";
      writeClaudeCredential(home, {
        accessToken: fakeToken,
        expiresAt: "2035-01-01T00:00:00.000Z",
      });
      const execFileText = vi.fn(async () => "keychain item metadata\n");
      vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failureKind === "5xx") return new Response(null, { status: 503 });
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }),
      );

      const { fetchQuota } = await import("../../src/providers/claude.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });
      const annotated = annotateQuotaAdvice({
        generatedAt: new Date().toISOString(),
        providers: [result],
      });

      expect(result.attempts).toContainEqual({
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      });
      expect(result.attempts).toContainEqual(
        expect.objectContaining({
          source: "oauth-file",
          status: "failed",
        }),
      );
      expect(annotated.providers[0]?.state.reason).toBeUndefined();
      expect(annotated.providers[0]?.state.remedyCommand).toBeUndefined();
      expect(annotated.help).toBeUndefined();
      expect(JSON.stringify(annotated)).not.toContain(fakeToken);
    },
  );
  it("uses a stale snapshot only for its matching synthetic credential context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    const home = useTempHome();
    const contextA = join(home, "synthetic-context-a");
    process.env.CLAUDE_CONFIG_DIR = contextA;
    writeClaudeConfigCredential(contextA, {
      accessToken: "synthetic-token-a",
      expiresAt: "2035-01-01T00:00:00.000Z",
    });
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(42)]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "cache",
      windows: [expect.objectContaining({ percentUsed: 42 })],
      state: { status: "stale", stale: true },
    });
  });

  it("rejects a stale snapshot from a different synthetic credential context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    const home = useTempHome();
    const contextA = join(home, "synthetic-context-a");
    const contextB = join(home, "synthetic-context-b");
    process.env.CLAUDE_CONFIG_DIR = contextA;
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(42)]);
    process.env.CLAUDE_CONFIG_DIR = contextB;
    writeClaudeConfigCredential(contextB, {
      accessToken: "synthetic-token-b",
      expiresAt: "2035-01-01T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", stale: false, error: "network unavailable" },
    });
  });

  it("fails closed for a legacy context-less Claude snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    const home = useTempHome();
    const context = join(home, "synthetic-context-a");
    process.env.CLAUDE_CONFIG_DIR = context;
    writeClaudeConfigCredential(context, {
      accessToken: "synthetic-token-a",
      expiresAt: "2035-01-01T00:00:00.000Z",
    });
    const { cacheFilePath } = await import("../../src/lib/fs.js");
    mkdirSync(dirname(cacheFilePath()), { recursive: true });
    writeFileSync(
      cacheFilePath(),
      JSON.stringify({ schemaVersion: 1, providers: [cachedClaudeQuota(42)] }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", stale: false, error: "network unavailable" },
    });
  });

  it("prunes reset-expired windows while retaining an eligible active window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    const home = useTempHome();
    writeClaudeCredential(home, {
      accessToken: "future-token",
      expiresAt: "2035-01-01T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
    const cached = cachedClaudeQuota(34);
    cached.state.refreshedAt = "2026-07-06T19:00:00.000Z";
    cached.windows = [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 34,
        percentRemaining: 66,
        resetsAt: "2026-07-06T19:30:00.000Z",
      },
      {
        id: "seven_day",
        label: "week",
        kind: "weekly",
        percentUsed: 20,
        percentRemaining: 80,
        resetsAt: "2026-07-10T20:00:00.000Z",
      },
    ];
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([cached]);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.source).toBe("cache");
    expect(result.windows.map(({ id }) => id)).toEqual(["seven_day"]);
  });

  it("returns the transient failure when every resetless window is over age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T01:00:00.000Z"));
    const home = useTempHome();
    writeClaudeCredential(home, {
      accessToken: "future-token",
      expiresAt: "2035-01-01T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(34)]);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", stale: false, error: "network unavailable" },
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
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

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

  it("fetches a profile with the same OAuth credential and exposes a verified account identity", async () => {
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
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/oauth/profile")) {
        return new Response(
          JSON.stringify({
            account: {
              uuid: "11111111-2222-4333-8444-555555555555",
              email: "person@example.invalid",
            },
            organization: { name: "Fixture Organization" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.account).toEqual({
      accountId: "11111111-2222-4333-8444-555555555555",
      email: "person@example.invalid",
      organization: "Fixture Organization",
      identityStatus: "verified",
    });
    expect(result.attempts).toContainEqual({
      source: "oauth-profile",
      status: "success",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/profile",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer fresh-token",
          "Cache-Control": "no-cache",
        }),
      }),
    );
  });

  it("marks identity unverified when the profile response lacks a stable account id", async () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/api/oauth/profile")
          ? new Response(
              JSON.stringify({ email_address: "person@example.invalid" }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
              status: 200,
            }),
      ),
    );

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.account).toEqual({ identityStatus: "unverified" });
    expect(result.attempts).toContainEqual({
      source: "oauth-profile",
      status: "failed",
      error: "identity_profile_unrecognized",
    });
  });

  it("surfaces missing file credentials as a skipped attempt and auth_required", async () => {
    useTempHome();

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("credentials_missing");
    expect(result.attempts).toContainEqual({
      source: "oauth-file",
      status: "skipped",
      error: "credentials_missing",
    });
  });

  it("ignores a legacy marker and does not read a Keychain value without the account marker", async () => {
    usePlatform("darwin");
    const home = useTempHome();
    const legacyMarker = join(
      home,
      "cache",
      "quota-axi",
      "claude-keychain-access-granted",
    );
    mkdirSync(dirname(legacyMarker), { recursive: true, mode: 0o700 });
    writeFileSync(legacyMarker, "granted\n", { mode: 0o600 });
    const execFileText = vi.fn(async () => "");
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));

    const { fetchQuota, inspectAuth } =
      await import("../../src/providers/claude.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Number),
    );
    expect(execFileText).not.toHaveBeenCalledWith(
      "security",
      expect.arrayContaining(["-w"]),
      expect.any(Number),
    );
    expect(
      execFileText.mock.calls.every(
        ([, args]) => args.includes("-a") && args.includes("fixture-user"),
      ),
    ).toBe(true);
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

  it("does not fall back to a service-only value read when the pinned item is missing", async () => {
    usePlatform("darwin");
    useTempHome();
    const missing = Object.assign(new Error("not found"), { code: 44 });
    const execFileText = vi.fn(async () => {
      throw missing;
    });
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));

    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth({
      allowKeychainPrompt: true,
      refreshCredentials: false,
    });

    expect(execFileText).toHaveBeenCalledTimes(1);
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Number),
    );
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_unreachable",
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
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(marker).toContain("claude-keychain-access-granted");
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Number),
    );
    expect(
      execFileText.mock.calls.every(([, args]) => args.includes("-w")),
    ).toBe(true);
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

  it("attempts read-only usage for a readable Keychain token with advisory expiry", async () => {
    usePlatform("darwin");
    useTempHome();
    await writeKeychainAccessMarker();
    const execFileText = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-keychain-token",
          expiresAt: "2000-01-01T00:00:00.000Z",
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
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "expired",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("oauth");
    expect(result.attempts).not.toContainEqual(
      expect.objectContaining({ error: "keychain_prompt_required" }),
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
    const result = await fetchQuota({
      allowKeychainPrompt: true,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Number),
    );
    const marker = claudeKeychainAccessMarkerPath("fixture-user");
    expect(existsSync(marker)).toBe(true);
    expect(statSync(marker).mode & 0o777).toBe(0o600);
  });

  it("selects the current-user item from duplicate services through the real CLI", async () => {
    usePlatform("darwin");
    useTempHome();
    await writeKeychainAccessMarker();
    const keychainFixtures = new Map([
      ["fixture-user", "current-user-keychain-token"],
      ["unknown", "stale-unknown-keychain-token"],
    ]);
    const execFileText = vi.fn(async (_file: string, args: string[]) => {
      const accountFlag = args.indexOf("-a");
      const account = accountFlag >= 0 ? args[accountFlag + 1] : undefined;
      const accessToken = account ? keychainFixtures.get(account) : undefined;
      if (!accessToken)
        throw Object.assign(new Error("not found"), { code: 44 });
      return JSON.stringify({
        claudeAiOauth: {
          accessToken,
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      });
    });
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/api/oauth/profile")
        ? new Response(
            JSON.stringify({
              account: { uuid: "11111111-2222-4333-8444-555555555555" },
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
            status: 200,
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(80)]);
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

    const output = JSON.parse(chunks.join("")) as {
      providers: Array<{
        source: string;
        windows: unknown[];
        state: { status: string; sourcesTried: string[] };
        attempts: Array<{ source: string; status: string }>;
      }>;
    };
    expect(execFileText).toHaveBeenCalledTimes(1);
    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Number),
    );
    expect(
      execFileText.mock.calls.some(([, args]) => args.includes("unknown")),
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer current-user-keychain-token",
        }),
      }),
    );
    expect(output.providers[0]).toMatchObject({
      source: "oauth",
      state: {
        status: "fresh",
        sourcesTried: ["oauth-file", "keychain", "oauth-profile"],
      },
    });
    expect(output.providers[0]?.windows).not.toHaveLength(0);
    expect(output.providers[0]?.attempts).toContainEqual({
      source: "keychain",
      status: "success",
    });
    expect(chunks.join("")).not.toContain("fixture-user");
    expect(readCachedProvider("claude")?.windows[0]?.percentUsed).toBe(12);
    expect(process.exitCode).toBeUndefined();
  });

  it.each([401, 403])(
    "reports a pinned Keychain HTTP %i as definitive in full CLI output",
    async (status) => {
      usePlatform("darwin");
      useTempHome();
      await writeKeychainAccessMarker();
      const execFileText = vi.fn(async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "current-user-keychain-token",
            expiresAt: "2035-01-01T00:00:00.000Z",
          },
        }),
      );
      vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const { readCachedProvider, writeCachedProviders } =
        await import("../../src/cache.js");
      writeCachedProviders([cachedClaudeQuota(80)]);
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

      const output = JSON.parse(chunks.join("")) as {
        providers: Array<{
          windows: unknown[];
          state: { status: string; stale: boolean };
          attempts: Array<{
            source: string;
            status: string;
            error?: string;
          }>;
        }>;
      };
      expect(execFileText).toHaveBeenCalledWith(
        "security",
        [
          "find-generic-password",
          "-a",
          "fixture-user",
          "-w",
          "-s",
          "Claude Code-credentials",
        ],
        expect.any(Number),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.anthropic.com/api/oauth/usage",
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer current-user-keychain-token",
          }),
        }),
      );
      expect(output.providers[0]).toMatchObject({
        windows: [],
        state: { status: "auth_required", stale: false },
      });
      expect(output.providers[0]?.attempts).toContainEqual({
        source: "keychain",
        status: "failed",
        error: "Claude sign-in required",
      });
      expect(readCachedProvider("claude")).toBeUndefined();
      expect(process.exitCode).toBe(1);
    },
  );

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
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(execFileText).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Number),
    );
    expect(
      execFileText.mock.calls.some(([, args]) => args.includes("-w")),
    ).toBe(false);
    expect(
      execFileText.mock.calls.every(
        ([, args]) => args.includes("-a") && args.includes("fixture-user"),
      ),
    ).toBe(true);

    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_presence_check_failed",
    });
    expect(result.attempts).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_presence_check_failed",
    });
    expect(result.attempts).not.toContainEqual(
      expect.objectContaining({
        source: "keychain",
        error: "keychain_prompt_required",
      }),
    );
  });

  it("names the usage-fetch error on the stale Claude attention row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    const home = useTempHome();
    writeClaudeCredential(home, {
      accessToken: "live-token",
      expiresAt: "2035-01-01T00:00:00.000Z",
    });
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(34)]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const chunks: string[] = [];
    const { main } = await import("../../src/cli.js");
    await main({
      argv: ["--provider", "claude"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });
    const output = chunks.join("");
    expect(output).toContain(
      'claude,all,stale,"last refreshed 2026-07-06T18:10:00Z · fetch failed Claude quota unavailable (503)"',
    );
  });

  it("does not treat Keychain exit 44 as signed-out or retire the Claude cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T20:00:00.000Z"));
    usePlatform("darwin");
    useTempHome();
    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaudeQuota(34)]);
    const execFileText = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { code: 44 });
    });
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({
      allowKeychainPrompt: true,
      refreshCredentials: false,
    });
    expect(result.state.status).not.toBe("auth_required");
    expect(result.state.error).toBe("keychain_unreachable");
    expect(result.source).toBe("cache");
    expect(readCachedProvider("claude")).toMatchObject({
      provider: "claude",
      source: "oauth",
    });
  });

  it("says so when Keychain is denied and does not offer a prompt that cannot help", async () => {
    usePlatform("darwin");
    useTempHome();
    const execFileText = vi.fn(async () => {
      throw Object.assign(new Error("auth failed"), { code: 51 });
    });
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { annotateQuotaAdvice } = await import("../../src/advice.js");
    const result = await fetchQuota({
      allowKeychainPrompt: true,
      refreshCredentials: false,
    });
    const annotated = annotateQuotaAdvice({
      generatedAt: new Date().toISOString(),
      providers: [result],
    });
    expect(result.state.error).toBe("keychain_access_denied");
    expect(result.state.status).not.toBe("auth_required");
    expect(annotated.providers[0]?.state.remedyCommand).toBeUndefined();
    expect(annotated.help?.join("\n") ?? "").not.toContain(
      "--allow-keychain-prompt",
    );
  });

  it("surfaces malformed file credentials as invalid auth", async () => {
    const home = useTempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{not-json");

    const { inspectAuth } = await import("../../src/providers/claude.js");
    const result = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

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
  const marker = claudeKeychainAccessMarkerPath("fixture-user");
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  writeFileSync(marker, "granted\n", { mode: 0o600 });
  return marker;
}

function writeClaudeCredential(
  home: string,
  oauth: Record<string, unknown>,
): void {
  writeClaudeConfigCredential(join(home, ".claude"), oauth);
}

function writeClaudeConfigCredential(
  configDir: string,
  oauth: Record<string, unknown>,
): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: oauth }),
  );
}

function cachedClaudeQuota(percentUsed: number): ProviderQuota {
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
