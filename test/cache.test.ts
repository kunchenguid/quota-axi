import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteCachedProvider,
  readCachedClaudeProvider,
  readCachedCommandCodeProvider,
  readCachedCodexProvider,
  readCachedKimiProvider,
  readCachedDevinProvider,
  readCachedMiniMaxProvider,
  readCachedProvider,
  retireCodexAccount,
  writeCachedProviders,
  stampCodexStoredAccountId,
} from "../src/cache.js";
import { annotateQuotaAdvice } from "../src/advice.js";
import { cacheFilePath, claudeCredentialContextId } from "../src/lib/fs.js";
import {
  clearCommandCodeReadingContextId,
  commandCodeCacheContextId,
  publishCommandCodeReadingContextId,
} from "../src/providers/commandcode-cache-context.js";
import { staleFromCache } from "../src/providers/common.js";
import { withQuotaSemantics } from "../src/interpretation.js";
import { createKimiCodeCliCredentialSource } from "../src/providers/kimi-code-cli-credential.js";
import { createKimiAdapter } from "../src/providers/kimi.js";
import {
  clearDevinReadingContextId,
  devinCacheContextId,
  publishDevinReadingContextId,
} from "../src/providers/devin-cache-context.js";
import { publishMiniMaxReadingContextId } from "../src/providers/minimax-cache-context.js";
import type { ProviderId, ProviderQuota } from "../src/types.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalKimiCodeHome = process.env.KIMI_CODE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalClaudeConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = originalKimiCodeHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  clearCommandCodeReadingContextId();
  clearDevinReadingContextId();
});

describe("quota cache", () => {
  it("serves Codex stale quota only for a matching stored account", () => {
    useTempCache();
    const snapshot = quota("codex", 42);
    stampCodexStoredAccountId(snapshot, "acct-signed-in");
    writeCachedProviders([snapshot]);

    expect(readCachedCodexProvider(undefined, [])).toBeUndefined();
    expect(readCachedCodexProvider(undefined, ["acct-other"])).toBeUndefined();
    expect(
      readCachedCodexProvider(undefined, ["acct-signed-in"]),
    ).toMatchObject({
      windows: [{ percentUsed: 42 }],
    });
  });

  it("continues from a mismatched Codex home snapshot to a matching keyless snapshot", () => {
    useTempCache();
    const foreignHome = quota("codex", 10);
    foreignHome.accountKey = "codex-home";
    stampCodexStoredAccountId(foreignHome, "acct-foreign");
    const signedIn = quota("codex", 80);
    stampCodexStoredAccountId(signedIn, "acct-signed-in");
    writeCachedProviders([foreignHome, signedIn]);

    expect(
      readCachedCodexProvider("codex-home", ["acct-signed-in"]),
    ).toMatchObject({ windows: [{ percentUsed: 80 }] });
  });

  it("retires only Codex snapshots stamped for rejected accounts", () => {
    useTempCache();
    const defaultA = quota("codex", 10);
    const keyedA = quota("codex", 20);
    keyedA.accountKey = "openai-codex";
    const keyedB = quota("codex", 30);
    keyedB.accountKey = "openai-codex-work";
    const unstamped = quota("codex", 40);
    unstamped.accountKey = "openai-codex-unstamped";
    stampCodexStoredAccountId(defaultA, "acct-a");
    stampCodexStoredAccountId(keyedA, "acct-a");
    stampCodexStoredAccountId(keyedB, "acct-b");
    writeCachedProviders([defaultA, keyedA, keyedB, unstamped]);

    retireCodexAccount(["acct-a"]);

    expect(readCachedProvider("codex")).toBeUndefined();
    expect(readCachedProvider("codex", "openai-codex")).toBeUndefined();
    expect(readCachedProvider("codex", "openai-codex-work")).toMatchObject({
      windows: [{ percentUsed: 30 }],
    });
    expect(readCachedProvider("codex", "openai-codex-unstamped")).toMatchObject(
      { windows: [{ percentUsed: 40 }] },
    );
  });

  it("withholds legacy Codex snapshots without account context", () => {
    useTempCache();
    writeCachedProviders([quota("codex", 42)]);

    expect(
      readCachedCodexProvider(undefined, ["acct-signed-in"]),
    ).toBeUndefined();
  });

  it.each([true, false])(
    "leaves persistent snapshots untouched by native Claude reads with windows %s",
    (hasWindows) => {
      useTempCache();
      writeCachedProviders([quota("claude", 20), quota("copilot", 30)]);
      const before = readFileSync(cacheFilePath(), "utf8");
      const native = quota("claude", 80);
      native.source = "cli";
      native.state.sourcesTried = ["env", "claude-native-inference"];
      if (!hasWindows) native.windows = [];
      writeCachedProviders([native]);
      expect(readFileSync(cacheFilePath(), "utf8")).toBe(before);
      writeCachedProviders([native, quota("copilot", 40)]);
      expect(readCachedProvider("claude")?.windows[0]?.percentUsed).toBe(20);
      expect(readCachedProvider("copilot")?.windows[0]?.percentUsed).toBe(40);
    },
  );

  it("ignores malformed matching entries", () => {
    useTempCache();
    const file = cacheFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        generatedAt: "x",
        schemaVersion: 1,
        providers: [{ provider: "claude" }],
      }),
    );

    expect(() => readCachedProvider("claude")).not.toThrow();
    expect(readCachedProvider("claude")).toBeUndefined();
  });

  it("invalidates Codex identities that do not exactly match duration", () => {
    useTempCache();
    const file = cacheFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const invalidWindows = [
      {
        id: "seven_day",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        windowSeconds: 600_000,
      },
      {
        id: "model:preview:7d",
        label: "Preview week",
        kind: "model",
        windowSeconds: 18_000,
      },
      {
        id: "weekly_2",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
    ];

    for (const window of invalidWindows) {
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          providers: [{ ...quota("codex", 20), windows: [window] }],
        }),
      );

      expect(readCachedProvider("codex")).toBeUndefined();
    }
  });

  it("retains the additive Pi Codex provider source", () => {
    useTempCache();
    const codex = quota("codex", 20);
    codex.source = "pi:openai-codex";
    codex.state.sourcesTried = ["oauth", "pi:openai-codex"];

    writeCachedProviders([codex]);

    expect(readCachedProvider("codex")).toMatchObject({
      source: "pi:openai-codex",
      state: { sourcesTried: ["oauth", "pi:openai-codex"] },
    });
  });

  it("isolates Codex Pi sibling snapshots by account key", () => {
    useTempCache();
    const personal = quota("codex", 20);
    personal.accountKey = "openai-codex";
    personal.source = "pi:openai-codex";
    personal.state.sourcesTried = ["pi:openai-codex"];
    const work = quota("codex", 80);
    work.accountKey = "openai-codex-work";
    work.source = "pi:openai-codex-work";
    work.state.sourcesTried = ["pi:openai-codex-work"];

    writeCachedProviders([personal, work]);

    expect(readCachedProvider("codex")).toBeUndefined();
    expect(readCachedProvider("codex", "openai-codex")).toMatchObject({
      accountKey: "openai-codex",
      source: "pi:openai-codex",
      windows: [{ percentUsed: 20 }],
    });
    expect(readCachedProvider("codex", "openai-codex-work")).toMatchObject({
      accountKey: "openai-codex-work",
      source: "pi:openai-codex-work",
      windows: [{ percentUsed: 80 }],
    });
    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      schemaVersion: number;
    };
    expect(payload.schemaVersion).toBe(3);
  });

  it("keeps an expanded report's filler key out of a later unexpanded report", () => {
    useTempCache();
    const work = quota("codex", 20);
    work.accountKey = "openai-codex-work";
    const expanded = annotateQuotaAdvice({
      generatedAt: "2026-07-06T18:10:00Z",
      providers: [work, quota("copilot", 40)],
    });
    expect(expanded.schemaVersion).toBe(6);
    expect(expanded.providers[1]?.accountKey).toBe("default");

    writeCachedProviders(expanded.providers);
    const cached = readCachedProvider("copilot");
    expect(cached).toMatchObject({ windows: [{ percentUsed: 40 }] });
    expect(cached?.accountKey).toBeUndefined();

    const later = annotateQuotaAdvice({
      generatedAt: "2026-07-06T19:10:00Z",
      providers: [
        staleFromCache(
          cached!,
          "fetch failed",
          ["api"],
          [],
          Date.parse("2026-07-06T19:10:00Z"),
        )!,
      ],
    });
    expect(later.schemaVersion).toBe(5);
    expect(later.providers[0]?.accountKey).toBeUndefined();
  });

  it("retains exact known and unfamiliar Codex cache identities", () => {
    useTempCache();
    const codex = quota("codex", 20);
    codex.windows = [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        windowSeconds: 18_000,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
      {
        id: "weekly_2",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
      },
      {
        id: "model:preview:window:166.67h",
        label: "Preview 166.67h window",
        kind: "model",
        windowSeconds: 600_000,
      },
    ];
    writeCachedProviders([codex]);

    expect(readCachedProvider("codex")?.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "weekly",
      "weekly_2",
      "model:preview:window:166.67h",
    ]);
  });

  it("merges fresh provider snapshots into existing cache", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("codex", 20)]);
    writeCachedProviders([quota("claude", 30)]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: ProviderQuota[];
    };

    expect(payload.providers.map((provider) => provider.provider)).toEqual([
      "claude",
      "codex",
    ]);
    expect(
      payload.providers.find((provider) => provider.provider === "claude")
        ?.windows[0].percentUsed,
    ).toBe(30);
    expect(
      payload.providers.find((provider) => provider.provider === "codex")
        ?.windows[0].percentUsed,
    ).toBe(20);
    expect(payload.providers.every((provider) => !provider.account)).toBe(true);
  });

  it("retains CLI-sourced snapshots for stale fallback", () => {
    useTempCache();
    const alibaba = {
      ...quota("alibaba", 18),
      source: "cli" as const,
    };

    writeCachedProviders([alibaba]);

    expect(readCachedProvider("alibaba")).toMatchObject({
      provider: "alibaba",
      source: "cli",
      windows: [{ percentUsed: 18 }],
    });
  });

  it("never writes a Copilot native snapshot over a servable legacy one", () => {
    useTempCache();
    writeCachedProviders([quota("copilot", 18)]);

    writeCachedProviders([{ ...quota("copilot", 55), source: "cli" as const }]);

    expect(readCachedProvider("copilot")).toMatchObject({
      source: "oauth",
      windows: [{ percentUsed: 18 }],
    });
  });

  it("stores Claude cache provenance as an opaque context identifier", () => {
    useTempCache();
    const contextDir = join(tempDir!, "synthetic-claude-context");
    process.env.CLAUDE_CONFIG_DIR = contextDir;

    writeCachedProviders([quota("claude", 42)]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      schemaVersion: number;
      providers: Array<{ credentialContext?: string }>;
    };
    const contextId = payload.providers[0]?.credentialContext;
    expect(payload.schemaVersion).toBe(3);
    expect(contextId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain(contextDir);
    expect(readCachedClaudeProvider(claudeCredentialContextId())).toBeDefined();
  });

  it("keeps one Claude snapshot when the credential context changes", () => {
    useTempCache();
    process.env.CLAUDE_CONFIG_DIR = join(tempDir!, "claude-context-a");
    writeCachedProviders([quota("claude", 10)]);
    process.env.CLAUDE_CONFIG_DIR = join(tempDir!, "claude-context-b");
    writeCachedProviders([quota("claude", 20)]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: Array<{ snapshot: ProviderQuota }>;
    };
    expect(payload.providers).toHaveLength(1);

    writeCachedProviders([quotaWithoutWindows("claude")]);
    expect(readCachedProvider("claude")).toBeUndefined();
  });

  it("refuses Kimi cache captured under another Kimi Code environment", async () => {
    useTempCache();
    const codeHome = join(tempDir!, "synthetic-kimi-code-home");
    const config = join(codeHome, "config.toml");
    mkdirSync(codeHome, { recursive: true });
    process.env.KIMI_CODE_HOME = codeHome;
    writeFileSync(
      config,
      `[providers."managed:kimi-code"]
type = "kimi"
api_key = "cache-context-must-not-depend-on-this-118"
`,
    );
    const mainland = await selectKimiEnvironment();

    writeCachedProviders([{ ...quota("kimi", 42), source: "api" as const }]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: Array<{ credentialContext?: string }>;
    };
    expect(payload.providers[0]?.credentialContext).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain(codeHome);
    expect(readCachedKimiProvider(mainland)).toBeDefined();

    writeFileSync(
      config,
      `[providers."managed:kimi-code"]
type = "kimi"
api_key = "a-rotated-key-selects-the-same-environment-994"
default_model = "k2"
`,
    );

    expect(await selectKimiEnvironment()).toBe(mainland);
    expect(readCachedKimiProvider(mainland)).toBeDefined();

    writeFileSync(
      config,
      '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n',
    );
    const global = await selectKimiEnvironment();

    expect(global).not.toBe(mainland);
    expect(readCachedKimiProvider(global)).toBeUndefined();
    expect(readCachedProvider("kimi")).toBeDefined();
  });

  /**
   * Kimi Code rewrites `config.toml` on login, so the environment can already
   * have changed by the time a reading is written. The stamp has to name the
   * environment the numbers came from, not whichever one the file describes
   * afterwards, or one deployment's quota is filed under the other's identity
   * and later served back as its stale reading.
   */
  it("stamps a Kimi snapshot with the environment its reading was taken under", async () => {
    useTempCache();
    const codeHome = join(tempDir!, "switching-kimi-code-home");
    const config = join(codeHome, "config.toml");
    mkdirSync(codeHome, { recursive: true });
    process.env.KIMI_CODE_HOME = codeHome;
    writeFileSync(
      config,
      '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com/coding/v1"\n',
    );
    const readingEnvironment = await selectKimiEnvironment();

    writeFileSync(
      config,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000031"
oauth_host = "https://auth.kimi.ai"
`,
    );

    writeCachedProviders([{ ...quota("kimi", 42), source: "api" as const }]);

    expect(readCachedKimiProvider(readingEnvironment)).toBeDefined();
    expect(
      readCachedKimiProvider(await selectKimiEnvironment()),
    ).toBeUndefined();
  });

  /**
   * An authenticated `/usages` body with no quota field (a Free-tier account)
   * is a fresh reading with no windows, per README Cache "fresh with no
   * windows clears this context's slot" - not a stale-eligible failure that
   * would preserve a pre-existing snapshot.
   */
  it("clears an existing Kimi snapshot on a fresh no-quota reading, and a later transient failure does not resurrect it", async () => {
    useTempCache();
    const codeHome = join(tempDir!, "no-quota-kimi-code-home");
    mkdirSync(codeHome, { recursive: true });
    process.env.KIMI_CODE_HOME = codeHome;

    const piBroker = {
      resolve: async () =>
        ({
          status: "available",
          kind: "api_key",
          credential: "synthetic-pi-key",
        }) as const,
      inspect: async () => "available" as const,
    };
    const cliSource = createKimiCodeCliCredentialSource();
    const readKimi = (respond: () => Response, at: string) =>
      createKimiAdapter({
        broker: piBroker,
        cliCredentialSource: cliSource,
        fetch: (async () => respond()) as unknown as typeof fetch,
        readCachedProvider: readCachedKimiProvider,
        deleteCachedProvider,
        now: () => Date.parse(at),
      }).fetchQuota({ allowKeychainPrompt: false, refreshCredentials: false });

    /**
     * The snapshot the no-quota reading has to clear belongs to the identity
     * that reading publishes, so it comes from a real successful read rather
     * than from a context another test happened to leave behind.
     */
    const withWindows = await readKimi(
      () =>
        new Response(
          JSON.stringify({
            usages: {
              limit_5h: {
                used_ratio: 0.42,
                reset_time: "2026-09-22T04:00:00Z",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "2026-09-21T23:55:00Z",
    );
    expect(withWindows.state.status).toBe("fresh");
    expect(withWindows.windows.length).toBeGreaterThan(0);
    writeCachedProviders([withWindows]);
    expect(readCachedProvider("kimi")).toBeDefined();

    const noQuotaReport = await readKimi(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      "2026-09-22T00:00:00Z",
    );

    expect(noQuotaReport.state).toMatchObject({
      status: "fresh",
      stale: false,
      authStatus: "usable",
    });
    expect(noQuotaReport.windows).toEqual([]);

    writeCachedProviders([noQuotaReport]);
    expect(readCachedProvider("kimi")).toBeUndefined();

    const failed = await readKimi(() => {
      throw new Error("network down");
    }, "2026-09-22T00:05:00Z");

    expect(failed.state.stale).toBe(false);
    expect(failed.windows).toEqual([]);
    expect(readCachedProvider("kimi")).toBeUndefined();
  });

  it("scopes MiniMax cache reuse to the reading's source and deployment", () => {
    useTempCache();
    const globalContext = "a".repeat(64);
    const otherContext = "b".repeat(64);
    publishMiniMaxReadingContextId(globalContext);

    writeCachedProviders([quota("minimax", 42)]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: Array<{ credentialContext?: string }>;
    };
    expect(payload.providers[0]?.credentialContext).toBe(globalContext);
    expect(readCachedMiniMaxProvider(globalContext)).toBeDefined();
    expect(readCachedMiniMaxProvider(otherContext)).toBeUndefined();

    // A legacy record without a context is withheld, not deleted.
    writeFileSync(
      cacheFilePath(),
      JSON.stringify({
        generatedAt: "x",
        schemaVersion: 2,
        providers: [quota("minimax", 11)],
      }),
    );
    expect(readCachedMiniMaxProvider(globalContext)).toBeUndefined();
    expect(readCachedProvider("minimax")?.windows[0].percentUsed).toBe(11);
  });

  it("writes normalized cache data with mode 0600 and no attempts or sentinel secret", () => {
    useTempCache();
    const sentinel = "CACHE-SENTINEL-KIMI-612704";
    const kimi = {
      ...quota("kimi", 37.5),
      source: "api" as const,
      state: {
        ...quota("kimi", 37.5).state,
        untrustedWindowIds: ["limit:2"],
        sourcesTried: ["pi:kimi-coding"],
      },
      attempts: [
        {
          source: "pi:kimi-coding",
          status: "success" as const,
          error: sentinel,
        },
      ],
    };

    writeCachedProviders([kimi]);

    const bytes = readFileSync(cacheFilePath(), "utf8");
    expect(statSync(cacheFilePath()).mode & 0o777).toBe(0o600);
    expect(bytes).not.toContain(sentinel);
    expect(bytes).not.toContain("attempts");
    expect(bytes).not.toContain("account");
    expect(readCachedProvider("kimi")?.windows[0].percentUsed).toBe(37.5);
    expect(readCachedProvider("kimi")?.state.untrustedWindowIds).toEqual([
      "limit:2",
    ]);
  });

  it("retains trusted cycle evidence but never caches derived pace", () => {
    useTempCache();
    const claude = quota("claude", 40);
    claude.windows[0] = {
      ...claude.windows[0],
      percentRemaining: 60,
      startsAt: "2026-07-06T15:00:00Z",
      resetsAt: "2026-07-06T20:00:00Z",
      windowSeconds: 18_000,
      pace: {
        status: "ahead",
        reservePercentPoints: -20,
      },
    };

    writeCachedProviders([claude]);

    const bytes = readFileSync(cacheFilePath(), "utf8");
    const cachedWindow = readCachedProvider("claude")?.windows[0];
    expect(bytes).not.toContain('"pace"');
    expect(cachedWindow).toMatchObject({
      startsAt: "2026-07-06T15:00:00Z",
      resetsAt: "2026-07-06T20:00:00Z",
      windowSeconds: 18_000,
    });
    expect(cachedWindow?.pace).toBeUndefined();
  });

  it("retains a used-share parent marker without inventing remaining", () => {
    useTempCache();
    const provider = quota("copilot", 40);
    provider.windows.push({
      id: "month_code",
      label: "code month",
      kind: "monthly",
      percentUsed: 25,
      shareOf: "month_total",
    });

    writeCachedProviders([provider]);

    const cached = readCachedProvider("copilot")?.windows[1];
    expect(cached).toMatchObject({
      id: "month_code",
      percentUsed: 25,
      shareOf: "month_total",
    });
    expect(cached?.percentRemaining).toBeUndefined();
  });

  it("presents a 0.1.47 Kimi month_code snapshot as a share of month_total", () => {
    useTempCache();
    const file = cacheFilePath();
    const contextId = "b".repeat(64);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        generatedAt: "2026-07-06T18:10:00Z",
        schemaVersion: 3,
        providers: [
          {
            provider: "kimi",
            credentialContext: contextId,
            label: "Kimi",
            source: "api",
            windows: [
              {
                id: "month_total",
                label: "month",
                kind: "monthly",
                percentUsed: 40,
                percentRemaining: 60,
              },
              {
                id: "month_code",
                label: "code month",
                kind: "monthly",
                percentUsed: 25,
              },
            ],
            state: {
              status: "fresh",
              stale: false,
              refreshedAt: "2026-07-06T18:10:00Z",
              sourcesTried: ["kimi-code"],
            },
          },
        ],
      }),
    );

    const stale = staleFromCache(
      readCachedKimiProvider(contextId)!,
      "fetch failed: synthetic outage",
      ["kimi-code"],
      [],
      Date.parse("2026-07-06T18:20:00Z"),
    )!;
    const monthCode = stale.windows.find(
      (window) => window.id === "month_code",
    );
    expect(monthCode).toMatchObject({
      percentUsed: 25,
      shareOf: "month_total",
    });
    expect(monthCode?.percentRemaining).toBeUndefined();
    expect(
      withQuotaSemantics(stale, "2026-07-06T18:20:00Z").quotaSemantics
        ?.unresolvedWindowIds,
    ).toBeUndefined();
  });

  it("deletes a definitive-auth provider while retaining other snapshots", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("kimi", 20)]);

    deleteCachedProvider("kimi");

    expect(readCachedProvider("kimi")).toBeUndefined();
    expect(readCachedProvider("claude")?.windows[0].percentUsed).toBe(10);
    expect(statSync(cacheFilePath()).mode & 0o777).toBe(0o600);
  });

  it("clears a stale snapshot after a fresh no-window report", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("copilot", 20)]);
    writeCachedProviders([quotaWithoutWindows("copilot")]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: ProviderQuota[];
    };

    expect(payload.providers.map((provider) => provider.provider)).toEqual([
      "claude",
    ]);
    expect(readCachedProvider("copilot")).toBeUndefined();
  });

  it("clears Alibaba after a fresh empty CLI report", () => {
    useTempCache();
    const alibaba = {
      ...quota("alibaba", 10),
      source: "cli" as const,
    };
    writeCachedProviders([alibaba]);
    writeCachedProviders([
      {
        ...alibaba,
        windows: [],
        state: { ...alibaba.state, sourcesTried: ["bl-cli"] },
      },
    ]);

    expect(readCachedProvider("alibaba")).toBeUndefined();
  });

  it("does not replace a context-scoped snapshot when the current reading has no identity", () => {
    useTempCache();
    const contextId = commandCodeCacheContextId(
      "pi:commandcode",
      "org:fixture",
    );
    publishCommandCodeReadingContextId(contextId);
    writeCachedProviders([quota("commandcode", 40)]);

    clearCommandCodeReadingContextId();
    writeCachedProviders([quota("commandcode", 5)]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: Array<{
        provider?: string;
        credentialContext?: string;
        windows: Array<{ percentUsed?: number }>;
      }>;
    };
    const record = payload.providers.find(
      (provider) => provider.provider === "commandcode",
    );
    expect(record?.credentialContext).toBe(contextId);
    expect(record?.windows[0]?.percentUsed).toBe(40);
    expect(
      readCachedCommandCodeProvider(contextId)?.windows[0].percentUsed,
    ).toBe(40);
  });

  it("does not clear a context-scoped snapshot when a no-window reading has no identity", () => {
    useTempCache();
    const contextId = commandCodeCacheContextId(
      "pi:commandcode",
      "org:fixture",
    );
    publishCommandCodeReadingContextId(contextId);
    writeCachedProviders([quota("commandcode", 40)]);

    clearCommandCodeReadingContextId();
    writeCachedProviders([quotaWithoutWindows("commandcode")]);

    expect(
      readCachedCommandCodeProvider(contextId)?.windows[0].percentUsed,
    ).toBe(40);
  });

  it("clears a context-scoped snapshot after an identified no-window report", () => {
    useTempCache();
    const contextId = commandCodeCacheContextId(
      "pi:commandcode",
      "org:fixture",
    );
    publishCommandCodeReadingContextId(contextId);
    writeCachedProviders([quota("commandcode", 40)]);
    writeCachedProviders([quotaWithoutWindows("commandcode")]);

    expect(readCachedCommandCodeProvider(contextId)).toBeUndefined();
    expect(readCachedProvider("commandcode")).toBeUndefined();
  });

  it("reuses a Devin snapshot only for the source, host, and key that wrote it", () => {
    useTempCache();
    const contextId = devinCacheContextId(
      "env:WINDSURF_API_KEY",
      "https://server.codeium.com",
      "synthetic-devin-cache-key",
    );
    const otherId = devinCacheContextId(
      "file:credentials.toml",
      "https://server.codeium.com",
      "synthetic-devin-cache-key",
    );
    publishDevinReadingContextId(contextId);
    writeCachedProviders([quota("devin", 40)]);

    clearDevinReadingContextId();
    writeCachedProviders([quota("devin", 5)]);

    expect(readCachedDevinProvider(contextId)?.windows[0].percentUsed).toBe(40);
    expect(readCachedDevinProvider(otherId)).toBeUndefined();
    expect(readCachedProvider("devin")?.windows[0].percentUsed).toBe(40);
  });

  it("clears a Devin snapshot after an identified no-window report", () => {
    useTempCache();
    const contextId = devinCacheContextId(
      "env:WINDSURF_API_KEY",
      "https://server.codeium.com",
      "synthetic-devin-cache-key",
    );
    publishDevinReadingContextId(contextId);
    writeCachedProviders([quota("devin", 40)]);
    writeCachedProviders([quotaWithoutWindows("devin")]);

    expect(readCachedDevinProvider(contextId)).toBeUndefined();
    expect(readCachedProvider("devin")).toBeUndefined();
  });
});

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, "synthetic-claude-context");
}

/**
 * Selects the Kimi Code environment the way a reading does, and returns the
 * cache identity that selection carries.
 */
async function selectKimiEnvironment(): Promise<string> {
  const { contextId } = await createKimiCodeCliCredentialSource().select();
  return contextId;
}

function quota(provider: ProviderId, percentUsed: number): ProviderQuota {
  return {
    provider,
    label: providerLabel(provider),
    source: "oauth",
    windows: [
      { id: "five_hour", label: "session", kind: "session", percentUsed },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["oauth"],
    },
    account: {
      email: "person@example.invalid",
      accountId: "fixture-account",
      identityStatus: "verified",
    },
    attempts: [{ source: "oauth", status: "success" }],
  };
}

function quotaWithoutWindows(provider: ProviderId): ProviderQuota {
  return {
    ...quota(provider, 0),
    windows: [],
  };
}

function providerLabel(provider: ProviderId): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "cursor") return "Cursor";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "grok") return "Grok";
  if (provider === "zai") return "Z.AI";
  if (provider === "agy") return "Antigravity";
  if (provider === "commandcode") return "Command Code";
  if (provider === "opencode-go") return "OpenCode Go";
  if (provider === "minimax") return "MiniMax";
  if (provider === "devin") return "Devin";
  return "Kimi";
}
