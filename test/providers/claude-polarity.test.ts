import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import { quotaCommand } from "../../src/commands.js";
import { claudeProfileLocations } from "../../src/lib/claude-profile.js";
import { cacheFilePath } from "../../src/lib/fs.js";
import { computeWindowPace } from "../../src/pace.js";
import { normalizeClaudeApiUsage } from "../../src/providers/claude.js";
import { parseClaudeNativeDebug } from "../../src/providers/claude-native-quota.js";
import type { ProviderQuota, QuotaAxiResponse } from "../../src/types.js";

/**
 * Observed vendor payloads from the 0.1.50 polarity inversion (PR #248).
 * Live vendor polarity is established by Claude Code's first-party schema and
 * UI ("% used" / "Share of the window used, 0-100"); these tests do not open
 * Keychain or call the live usage endpoint.
 */
const READING_A = {
  generatedAt: "2026-09-22T21:26:20Z",
  payload: {
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 48,
        resets_at: "2026-09-22T22:50:00Z",
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 2,
        resets_at: "2026-09-29T21:00:00Z",
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        resets_at: "2026-09-29T21:00:00Z",
        scope: { model: { display_name: "Fable" } },
      },
    ],
  },
};

const READING_B = {
  payload: {
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 0,
        resets_at: "2026-09-23T02:20:00Z",
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 61,
        resets_at: "2026-09-26T09:00:00Z",
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 94,
        resets_at: "2026-09-26T09:00:00Z",
        scope: { model: { display_name: "Fable" } },
      },
    ],
  },
};

describe("Claude utilization polarity", () => {
  it("reads a weekly window 26 minutes after its reset as nearly full", () => {
    const windows = normalizeClaudeApiUsage(READING_A.payload, "max")!.windows;

    expect(windows).toMatchObject([
      { id: "five_hour", percentUsed: 48, percentRemaining: 52 },
      { id: "seven_day", percentUsed: 2, percentRemaining: 98 },
      { id: "model:fable", percentUsed: 0, percentRemaining: 100 },
    ]);

    const weeklyPace = computeWindowPace(windows[1]!, READING_A.generatedAt);
    expect(weeklyPace.burnMultiple).toBeLessThan(10);
  });

  it("publishes remaining for the second observed limits[] reading", () => {
    const windows = normalizeClaudeApiUsage(READING_B.payload, "max")!.windows;

    expect(windows).toMatchObject([
      { id: "five_hour", percentUsed: 0, percentRemaining: 100 },
      { id: "seven_day", percentUsed: 61, percentRemaining: 39 },
      { id: "model:fable", percentUsed: 94, percentRemaining: 6 },
    ]);
  });

  it("keeps OAuth utilization, limits[] percent, and native header polarity aligned", () => {
    const fromTopLevel = normalizeClaudeApiUsage({
      seven_day: { utilization: 40 },
    });
    const fromLimits = normalizeClaudeApiUsage({
      limits: [
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 40,
          resets_at: "2026-09-29T21:00:00Z",
        },
      ],
    });
    const nativeNow = Date.parse("2026-09-22T21:26:20Z");
    const fromNative = parseClaudeNativeDebug(
      `[log_fixture] response start ${JSON.stringify({
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.4",
          "anthropic-ratelimit-unified-5h-reset": String(
            nativeNow / 1000 + 3600,
          ),
          "anthropic-ratelimit-unified-7d-utilization": "0.4",
          "anthropic-ratelimit-unified-7d-reset": String(
            nativeNow / 1000 + 86400,
          ),
        },
      })}\n`,
      nativeNow,
    );

    expect(fromTopLevel?.windows).toMatchObject([
      { id: "seven_day", percentUsed: 40 },
    ]);
    expect(fromLimits?.windows).toMatchObject([
      { id: "seven_day", percentUsed: 40 },
    ]);
    expect(fromNative).toMatchObject({
      kind: "success",
      windows: expect.arrayContaining([
        expect.objectContaining({ id: "seven_day", percentUsed: 40 }),
      ]),
    });
  });
});

describe("Claude polarity end to end", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  const originalEnv = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    cacheHome: process.env.XDG_CACHE_HOME,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    envToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  let tempHome: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", originalPlatform);
    restoreEnv("HOME", originalEnv.home);
    restoreEnv("USERPROFILE", originalEnv.userProfile);
    restoreEnv("XDG_CACHE_HOME", originalEnv.cacheHome);
    restoreEnv("CLAUDE_CONFIG_DIR", originalEnv.configDir);
    restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", originalEnv.envToken);
    process.exitCode = undefined;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  // Faking only Date leaves the Response body stream the provider reads on
  // real timers; faking the whole clock never lets that read complete.
  function readAt(instant: string): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
  }

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function useClaudeOauthHome(): void {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    tempHome = mkdtempSync(join(tmpdir(), "quota-axi-claude-polarity-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.XDG_CACHE_HOME = join(tempHome, "cache");
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const configDir = join(tempHome, ".claude");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "CLAUDE-SENTINEL-DO-NOT-LEAK-POLARITY",
          expiresAt: "2035-01-01T00:00:00.000Z",
          subscriptionType: "max",
        },
      }),
    );
  }

  function stubClaudeUsage(payload: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/oauth/profile")) {
          return new Response(
            JSON.stringify({ account: { uuid: "polarity-account" } }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/oauth/usage")) {
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  function stubUnreachableVendor(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
  }

  /**
   * The cache record 0.1.50 persisted for this same profile: its windows carry
   * the inverted polarity, under the credential-context identity that release
   * stamped them with.
   */
  function cacheInvertedSnapshot(): void {
    writeCachedProviders([invertedClaudeSnapshot()]);
    const { configDir, keychainService } = claudeProfileLocations();
    const cache = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: Array<{ credentialContext?: string }>;
    };
    cache.providers[0]!.credentialContext = createHash("sha256")
      .update(
        JSON.stringify([
          "claude-profile-v2",
          resolve(configDir),
          keychainService,
        ]),
      )
      .digest("hex");
    writeFileSync(cacheFilePath(), JSON.stringify(cache));
  }

  function invertedClaudeSnapshot(): ProviderQuota {
    return {
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "seven_day",
          label: "week",
          kind: "weekly",
          percentUsed: 98,
          percentRemaining: 2,
          resetsAt: "2026-09-29T21:00:00Z",
          windowSeconds: 604_800,
        },
      ],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: READING_A.generatedAt,
        sourcesTried: ["oauth-file"],
      },
    };
  }

  async function publishedClaude(): Promise<
    QuotaAxiResponse["providers"][number]
  > {
    const json = JSON.parse(
      await quotaCommand(
        ["--provider", "claude", "--json", "--no-credential-refresh"],
        undefined,
      ),
    ) as QuotaAxiResponse;
    return json.providers[0]!;
  }

  it("publishes the reset-boundary reading as nearly full quota", async () => {
    readAt(READING_A.generatedAt);
    useClaudeOauthHome();
    stubClaudeUsage(READING_A.payload);

    const claude = await publishedClaude();

    expect(claude.state).toMatchObject({ status: "fresh", stale: false });
    expect(claude.windows).toMatchObject([
      { id: "five_hour", percentRemaining: 52 },
      { id: "seven_day", percentRemaining: 98 },
      { id: "model:fable", percentRemaining: 100 },
    ]);
    expect(
      claude.windows.find((window) => window.id === "seven_day")?.pace
        ?.burnMultiple,
    ).toBeLessThan(10);
  });

  it("publishes the second observed reading's remaining percentages", async () => {
    readAt(READING_A.generatedAt);
    useClaudeOauthHome();
    stubClaudeUsage(READING_B.payload);

    const claude = await publishedClaude();

    expect(claude.windows).toMatchObject([
      { id: "five_hour", percentRemaining: 100 },
      { id: "seven_day", percentRemaining: 39 },
      { id: "model:fable", percentRemaining: 6 },
    ]);
  });

  it("never republishes a snapshot cached under the inverted polarity", async () => {
    readAt(READING_A.generatedAt);
    useClaudeOauthHome();
    cacheInvertedSnapshot();
    stubUnreachableVendor();

    const claude = await publishedClaude();

    expect(claude.state).toMatchObject({ stale: false });
    expect(claude.windows).toEqual([]);
    expect(readCachedProvider("claude")?.windows[0]).toMatchObject({
      percentRemaining: 2,
    });
  });

  it("still serves a stale snapshot this version cached", async () => {
    readAt(READING_A.generatedAt);
    useClaudeOauthHome();
    stubClaudeUsage(READING_A.payload);
    await publishedClaude();
    stubUnreachableVendor();

    const claude = await publishedClaude();

    expect(claude.state).toMatchObject({ status: "stale", stale: true });
    expect(claude.windows).toMatchObject([
      { id: "five_hour", percentRemaining: 52 },
      { id: "seven_day", percentRemaining: 98 },
      { id: "model:fable", percentRemaining: 100 },
    ]);
  });
});
