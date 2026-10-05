import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalClaudeStorageDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
const originalCwd = process.cwd();
let tempDir: string | undefined;

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalClaudeConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalClaudeStorageDir === undefined)
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = originalClaudeStorageDir;
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
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
    const defaultService = "Claude Code-credentials";
    const defaultAlice = claudeKeychainAccessMarkerPath(
      "alice",
      defaultService,
    );
    const defaultBob = claudeKeychainAccessMarkerPath("bob", defaultService);
    const suffixedAlice = claudeKeychainAccessMarkerPath(
      "alice",
      `${defaultService}-abcdef12`,
    );

    for (const marker of [defaultAlice, suffixedAlice]) {
      expect(marker).toMatch(
        /^\/tmp\/quota-cache\/quota-axi\/claude-keychain-access-granted-[0-9a-f]{8}-account-[0-9a-f]{16}$/,
      );
    }
    expect(suffixedAlice).not.toBe(defaultAlice);
    expect(defaultBob).not.toBe(defaultAlice);
    expect(defaultAlice).not.toContain("alice");
    expect(defaultBob).not.toContain("bob");
    expect(suffixedAlice).not.toContain("abcdef12");
  });
});

describe("keychain access grants", () => {
  function grantDir() {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-grants-"));
    return tempDir;
  }

  it("parses the mdat fingerprint in both timedate spellings", async () => {
    const { parseKeychainItemFingerprint } =
      await importFsWithHome("/Users/kun");

    expect(
      parseKeychainItemFingerprint(
        'keychain: "/login.keychain-db"\nattributes:\n    "mdat"<timedate>=2026-10-04 22:24:12 +0000\n',
      ),
    ).toBe("2026-10-04 22:24:12 +0000");
    expect(
      parseKeychainItemFingerprint(
        'attributes:\n    "mdat"<timedate>=0x32303236313030343232323431325A00  "20261004222412Z\\000"\n',
      ),
    ).toBe("20261004222412Z");
    expect(
      parseKeychainItemFingerprint(
        'attributes:\n    "mdat"<timedate>="20260701000000Z"\n',
      ),
    ).toBe("20260701000000Z");
    expect(
      parseKeychainItemFingerprint("keychain item metadata\n"),
    ).toBeUndefined();
    for (const value of ["<NULL>", "", "unexpected", "20261004222412Z"]) {
      expect(
        parseKeychainItemFingerprint(
          `attributes:\n    "mdat"<timedate>=${value}\n`,
        ),
      ).toBeUndefined();
    }
    expect(
      parseKeychainItemFingerprint(
        'attributes:\n    "mdat"<timedate>=0x32303236313030343232323431325A00  "20261004222413Z\\000"\n',
      ),
    ).toBeUndefined();
  });

  it("round-trips a bound grant and reads a legacy marker as legacy", async () => {
    const { readKeychainAccessGrant, writeKeychainAccessGrant } =
      await importFsWithHome("/Users/kun");
    const file = join(grantDir(), "marker");

    writeKeychainAccessGrant(file, "20261004222412Z");
    expect(readKeychainAccessGrant(file)).toEqual({
      status: "bound",
      itemFingerprint: "20261004222412Z",
    });

    writeFileSync(file, "granted\n", { mode: 0o600 });
    expect(readKeychainAccessGrant(file)).toEqual({ status: "legacy" });

    expect(readKeychainAccessGrant(join(grantDir(), "absent"))).toEqual({
      status: "missing",
    });
  });

  it("overwrites a stale binding but leaves an identical grant untouched", async () => {
    const { readKeychainAccessGrant, writeKeychainAccessGrant } =
      await importFsWithHome("/Users/kun");
    const file = join(grantDir(), "marker");

    writeKeychainAccessGrant(file, "first");
    const before = statSync(file).mtimeNs;
    writeKeychainAccessGrant(file, "first");
    expect(statSync(file).mtimeNs).toBe(before);
    writeKeychainAccessGrant(file, "second");
    expect(readKeychainAccessGrant(file)).toEqual({
      status: "bound",
      itemFingerprint: "second",
    });
  });

  it("permits a plain read only for a bound grant matching the fingerprint", async () => {
    const { keychainAccessGrantPermitsRead } =
      await importFsWithHome("/Users/kun");

    expect(
      keychainAccessGrantPermitsRead({ status: "missing" }, "fingerprint"),
    ).toBe(false);
    expect(
      keychainAccessGrantPermitsRead({ status: "legacy" }, "fingerprint"),
    ).toBe(false);
    expect(
      keychainAccessGrantPermitsRead(
        { status: "bound", itemFingerprint: "fingerprint" },
        "other",
      ),
    ).toBe(false);
    expect(
      keychainAccessGrantPermitsRead(
        { status: "bound", itemFingerprint: "fingerprint" },
        "fingerprint",
      ),
    ).toBe(true);
    expect(
      keychainAccessGrantPermitsRead({ status: "legacy" }, undefined),
    ).toBe(false);
    expect(
      keychainAccessGrantPermitsRead(
        { status: "bound", itemFingerprint: "fingerprint" },
        undefined,
      ),
    ).toBe(false);
    expect(
      keychainAccessGrantPermitsRead({ status: "missing" }, undefined),
    ).toBe(false);
  });
});

describe("claudeCredentialContextId", () => {
  it("includes the credential storage selector without exposing either path", async () => {
    const { claudeCredentialContextId } =
      await importFsWithHome("/fixture/home");
    process.env.CLAUDE_CONFIG_DIR = "/fixture/config";
    const configuredId = claudeCredentialContextId();

    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/fixture/storage-a";
    const firstStorageId = claudeCredentialContextId();
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/fixture/storage-b";
    const secondStorageId = claudeCredentialContextId();
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
    const emptyStorageId = claudeCredentialContextId();

    expect(new Set([configuredId, firstStorageId, secondStorageId]).size).toBe(
      3,
    );
    expect(emptyStorageId).toBe(configuredId);
    for (const context of [
      configuredId,
      firstStorageId,
      secondStorageId,
      emptyStorageId,
    ]) {
      expect(context).toMatch(/^[a-f0-9]{64}$/);
      expect(context).not.toContain("fixture");
    }
  });

  it("changes provenance from the legacy profile-only context", async () => {
    const { claudeCredentialContextId } =
      await importFsWithHome("/fixture/home");
    process.env.CLAUDE_CONFIG_DIR = "/fixture/config";
    const legacyContext = createHash("sha256")
      .update("claude-config-dir:/fixture/config")
      .digest("hex");

    expect(claudeCredentialContextId()).not.toBe(legacyContext);
  });

  it("normalizes equivalent NFC storage selectors to one context", async () => {
    const { claudeCredentialContextId } =
      await importFsWithHome("/fixture/home");
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/fixture/cafe\u0301";
    const decomposed = claudeCredentialContextId();
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/fixture/caf\u00e9";

    expect(claudeCredentialContextId()).toBe(decomposed);
  });
  it("separates identical relative config dirs resolved from different directories", async () => {
    const { claudeCredentialContextId } = await importFsWithHome("/Users/kun");
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "quota-axi-context-")));
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    mkdirSync(join(first, ".claude-profile"), { recursive: true });
    mkdirSync(join(second, ".claude-profile"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = ".claude-profile";

    process.chdir(first);
    const firstId = claudeCredentialContextId();
    process.chdir(second);
    const secondId = claudeCredentialContextId();

    expect(firstId).toMatch(/^[a-f0-9]{64}$/);
    expect(secondId).toMatch(/^[a-f0-9]{64}$/);
    expect(secondId).not.toBe(firstId);

    process.env.CLAUDE_CONFIG_DIR = join(second, ".claude-profile");
    // The file path is identical, but the vendor hashes the literal selector
    // for the Keychain service, so the relative and absolute forms differ.
    expect(claudeCredentialContextId()).not.toBe(secondId);
  });
});
