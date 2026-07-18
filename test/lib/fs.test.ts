import { afterEach, describe, expect, it, vi } from "vitest";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
});

async function importFsWithHome(home: string) {
  vi.resetModules();
  vi.doMock("node:os", () => ({ homedir: () => home }));
  return import("../../src/lib/fs.js");
}

describe("collapseHome", () => {
  it("collapses POSIX paths inside the home directory", async () => {
    const { collapseHome } = await importFsWithHome("/Users/kun");

    expect(collapseHome("/Users/kun/.codex/auth.json")).toBe(
      "~/.codex/auth.json",
    );
    expect(collapseHome("/Users/kun")).toBe("~");
  });

  it("collapses Windows paths inside the home directory", async () => {
    const { collapseHome } = await importFsWithHome("C:\\Users\\kun");

    expect(collapseHome("C:\\Users\\kun\\.codex\\auth.json")).toBe(
      "~/.codex/auth.json",
    );
    expect(collapseHome("C:\\Users\\kun")).toBe("~");
  });

  it("does not collapse sibling paths with the same prefix", async () => {
    const { collapseHome } = await importFsWithHome("C:\\Users\\kun");

    expect(collapseHome("C:\\Users\\kun-other\\auth.json")).toBe(
      "C:\\Users\\kun-other\\auth.json",
    );
  });

  it("does not collapse relative paths", async () => {
    const { collapseHome } = await importFsWithHome("/Users/kun");

    expect(collapseHome("quota-axi")).toBe("quota-axi");
  });
});

describe("cache paths", () => {
  it("places the Claude keychain marker alongside the quota cache", async () => {
    const { cacheFilePath, claudeKeychainAccessMarkerPath } =
      await importFsWithHome("/Users/kun");
    process.env.XDG_CACHE_HOME = "/tmp/quota-cache";

    expect(cacheFilePath()).toBe("/tmp/quota-cache/quota-axi/quotas.json");
    expect(claudeKeychainAccessMarkerPath()).toBe(
      "/tmp/quota-cache/quota-axi/claude-keychain-access-granted",
    );
    expect(claudeKeychainAccessMarkerPath("/tmp/claude-profile")).toMatch(
      /^\/tmp\/quota-cache\/quota-axi\/claude-keychain-access-granted-[0-9a-f]{8}$/,
    );
    expect(claudeKeychainAccessMarkerPath("")).toBe(
      "/tmp/quota-cache/quota-axi/claude-keychain-access-granted",
    );
  });
});
