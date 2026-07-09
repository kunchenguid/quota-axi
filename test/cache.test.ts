import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../src/cache.js";
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
    account: { email: "person@example.invalid" },
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
  if (provider === "agy") return "Antigravity";
  return "Grok";
}
