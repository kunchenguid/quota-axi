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
  readCachedProvider,
  writeCachedProviders,
} from "../src/cache.js";
import { cacheFilePath } from "../src/lib/fs.js";
import type { ProviderId, ProviderQuota } from "../src/types.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("quota cache", () => {
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

  it("writes normalized cache data with mode 0600 and no attempts or sentinel secret", () => {
    useTempCache();
    const sentinel = "CACHE-SENTINEL-TOKENROUTER-612704";
    const tokenrouter = {
      ...quota("tokenrouter", 37.5),
      source: "api" as const,
      state: {
        ...quota("tokenrouter", 37.5).state,
        sourcesTried: ["management-api"],
      },
      attempts: [
        {
          source: "management-api",
          status: "success" as const,
          error: sentinel,
        },
      ],
    };

    writeCachedProviders([tokenrouter]);

    const bytes = readFileSync(cacheFilePath(), "utf8");
    expect(statSync(cacheFilePath()).mode & 0o777).toBe(0o600);
    expect(bytes).not.toContain(sentinel);
    expect(bytes).not.toContain("attempts");
    expect(bytes).not.toContain("account");
    expect(readCachedProvider("tokenrouter")?.windows[0].percentUsed).toBe(
      37.5,
    );
  });

  it("deletes a definitive-auth provider while retaining other snapshots", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("tokenrouter", 20)]);

    deleteCachedProvider("tokenrouter");

    expect(readCachedProvider("tokenrouter")).toBeUndefined();
    expect(readCachedProvider("claude")?.windows[0].percentUsed).toBe(10);
    expect(statSync(cacheFilePath()).mode & 0o777).toBe(0o600);
  });

  it("clears a stale snapshot after a fresh no-window report", () => {
    useTempCache();
    writeCachedProviders([quota("claude", 10), quota("openrouter", 20)]);
    writeCachedProviders([quotaWithoutWindows("openrouter")]);

    const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as {
      providers: ProviderQuota[];
    };

    expect(payload.providers.map((provider) => provider.provider)).toEqual([
      "claude",
    ]);
    expect(readCachedProvider("openrouter")).toBeUndefined();
  });
});

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
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
  if (provider === "tokenrouter") return "TokenRouter";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "pioneer") return "Pioneer";
  return "Command Code";
}
