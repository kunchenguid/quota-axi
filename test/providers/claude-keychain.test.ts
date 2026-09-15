import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileText = vi.fn();
vi.mock("../../src/lib/process.js", () => ({ execFileText }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const options = { allowKeychainPrompt: true, refreshCredentials: false };
const service = "Claude Code-credentials";
const otherKeychain = "/fixture/Library/Keychains/searchable.keychain-db";
const keychain = "/fixture/Library/Keychains/login.keychain-db";
let home: string;

// Synthetic metadata only, shaped like security dump-keychain (no -d/-r/-a).
function item(
  name = service,
  modified = "20260913010000Z",
  account = "fixture-user",
  path = keychain,
  kind = "genp",
): string {
  const date = Buffer.from(`${modified}\0`).toString("hex");
  return `keychain: "${path}"
version: 512
class: "${kind}"
attributes:
    "acct"<blob>="${account}"
    "mdat"<timedate>=0x${date}  "${modified}\\000"
    "svce"<blob>="${name}"
`;
}

beforeEach(() => {
  vi.resetModules();
  execFileText.mockReset();
  home = mkdtempSync(join(tmpdir(), "quota-axi-keychain-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("USER", "fixture-user");
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ five_hour: { utilization: 12 } })),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(process, "platform", platform);
  rmSync(home, { recursive: true, force: true });
});

function cachedClaude() {
  return {
    provider: "claude" as const,
    label: "Claude",
    source: "oauth",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session" as const,
        percentUsed: 12,
      },
    ],
    state: {
      status: "fresh" as const,
      stale: false,
      refreshedAt: "2026-09-13T00:30:00Z",
      sourcesTried: ["oauth"],
    },
  };
}

function valueReadArgs(): string[] {
  const call = execFileText.mock.calls.find(([, args]: [string, string[]]) =>
    args.includes("-w"),
  );
  return (call?.[1] ?? []) as string[];
}

function profileService(configDir: string): string {
  return `${service}-${createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8)}`;
}

function unreachable(): Error {
  return Object.assign(new Error("synthetic item unavailable"), { code: 44 });
}

function mockItems(
  metadata: string,
  readableService = service,
  keychains = [keychain],
): void {
  execFileText.mockImplementation(async (command: string, args: string[]) => {
    expect(command).toBe("security");
    if (args[0] === "list-keychains") {
      expect(args).toEqual(["list-keychains"]);
      return keychains.map((path) => `    "${path}"\n`).join("");
    }
    if (args[0] === "dump-keychain") {
      expect(args).toEqual(["dump-keychain", ...keychains]);
      return metadata;
    }
    expect(args.slice(0, 3)).toEqual([
      "find-generic-password",
      "-a",
      "fixture-user",
    ]);
    if (args.includes(readableService)) {
      return args.includes("-w")
        ? JSON.stringify({
            claudeAiOauth: { accessToken: "synthetic-token" },
          })
        : "";
    }
    throw unreachable();
  });
}

describe("Claude macOS Keychain discovery", () => {
  it("still reads a legacy unsuffixed item", async () => {
    mockItems(item("Claude Code-credentials"), "Claude Code-credentials");
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
  });

  it("reads the default profile's own suffixed item", async () => {
    const defaultService = profileService(join(home, ".claude"));
    mockItems(item(defaultService), defaultService);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(defaultService);
    expect(
      execFileText.mock.calls.filter(([, args]) => args.includes("-w")),
    ).toHaveLength(1);
  });

  it("never opens the default directory's suffixed item for an explicit profile", async () => {
    const explicitDir = join(home, "explicit-profile");
    vi.stubEnv("CLAUDE_CONFIG_DIR", explicitDir);
    const defaultService = profileService(join(home, ".claude"));
    mockItems(item(defaultService) + item(service), "unavailable-service");
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).not.toBe("auth_required");
    expect(valueReadArgs()).toContain(profileService(explicitDir));
    expect(valueReadArgs()).not.toContain(defaultService);
    expect(valueReadArgs()).not.toContain(service);
  });

  it("prefers the exact selector over the equivalent spelling", async () => {
    const defaultService = profileService(join(home, ".claude"));
    mockItems(item(defaultService) + item(service), service);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(service);
    expect(valueReadArgs()).not.toContain(defaultService);
  });

  it("reads the suffix selected by Claude secure storage", async () => {
    const configDir = "/fixture/secure-profile";
    const selectedService = profileService(configDir);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", configDir);
    mockItems(item(selectedService), selectedService);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toMatchObject([
      { id: "five_hour", percentUsed: 12 },
    ]);
    expect(execFileText.mock.calls).toEqual([
      ["security", ["list-keychains"], 5000],
      ["security", ["dump-keychain", keychain], 5000],
      [
        "security",
        [
          "find-generic-password",
          "-a",
          "fixture-user",
          "-w",
          "-s",
          selectedService,
          keychain,
        ],
        60000,
      ],
    ]);
    expect(JSON.stringify(report)).not.toContain("synthetic-token");
    expect(JSON.stringify(report)).not.toContain("fixture-user");
  });

  it("finds a credential in a searchable keychain after the default changes", async () => {
    mockItems(
      item("unrelated-service") +
        item(service, undefined, undefined, otherKeychain),
      service,
      [keychain, otherKeychain],
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(valueReadArgs()).toEqual([
      "find-generic-password",
      "-a",
      "fixture-user",
      "-w",
      "-s",
      service,
      otherKeychain,
    ]);
    expect(
      execFileText.mock.calls.some(
        ([, args]) => args[0] === "default-keychain",
      ),
    ).toBe(false);
  });

  it("discovers presence without reading values until the existing grant policy permits it", async () => {
    mockItems(item());
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth({ ...options, allowKeychainPrompt: false });
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_prompt_required",
      credentialPresent: true,
    });
    expect(execFileText.mock.calls).toEqual([
      ["security", ["list-keychains"], 5000],
      ["security", ["dump-keychain", keychain], 5000],
    ]);

    const { claudeKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const marker = claudeKeychainAccessMarkerPath("fixture-user", service);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "granted\n", { mode: 0o600 });
    const granted = await inspectAuth({
      ...options,
      allowKeychainPrompt: false,
    });
    expect(granted.sources).toContainEqual({
      source: "keychain",
      status: "available",
    });
  });

  it("never lets a newer explicit-profile item replace the default profile", async () => {
    const explicitService = profileService("/fixture/explicit-profile");
    mockItems(
      item(service, "20260101010000Z") +
        item(explicitService, "20260913020000Z"),
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(service);
    expect(valueReadArgs()).not.toContain(explicitService);
    expect(
      execFileText.mock.calls.filter(([, args]) => args.includes("-w")),
    ).toHaveLength(1);
  });

  it("reads the default profile's lone opaque item whatever its suffix", async () => {
    const opaqueService = "Claude Code-credentials-abcdef12";
    expect(opaqueService).not.toBe(profileService(join(home, ".claude")));
    mockItems(item(opaqueService), opaqueService);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(opaqueService);
    expect(
      execFileText.mock.calls.filter(([, args]) => args.includes("-w")),
    ).toHaveLength(1);
  });

  it("opens no opaque item when the default profile has more than one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
    const first = "Claude Code-credentials-abcdef12";
    const second = profileService(join(home, ".claude"));
    mockItems(item(first) + item(second), "unavailable-service");
    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaude()]);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state).toMatchObject({
      status: "stale",
      error: "keychain_unreachable",
    });
    expect(readCachedProvider("claude")).toBeDefined();
    expect(valueReadArgs()).toContain(service);
    expect(valueReadArgs()).not.toContain(first);
    expect(valueReadArgs()).not.toContain(second);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "another searchable keychain is omitted",
      metadata: "",
      paths: [keychain, otherKeychain],
    },
    {
      label: "a competing record cannot be parsed",
      metadata: item("Claude Code-credentials-1234abcd").replace(
        '    "acct"<blob>="fixture-user"\n',
        "",
      ),
      paths: [keychain],
    },
    {
      label: "an unfamiliar Claude service remains",
      metadata: item("Claude Code-credentials-unfamiliar"),
      paths: [keychain],
    },
    {
      label: "a Claude item belongs to another account",
      metadata: item(service, undefined, "other-fixture-user"),
      paths: [keychain],
    },
  ])(
    "withholds a lone opaque item when $label",
    async ({ metadata, paths }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
      const opaqueService = "Claude Code-credentials-abcdef12";
      // The opaque value is readable, so accepting it would produce a fresh
      // reading instead of exercising the exact-selector fallback below.
      mockItems(item(opaqueService) + metadata, opaqueService, paths);
      const { readCachedProvider, writeCachedProviders } =
        await import("../../src/cache.js");
      writeCachedProviders([cachedClaude()]);
      const { fetchQuota } = await import("../../src/providers/claude.js");
      const report = await fetchQuota(options);

      expect(report.state).toMatchObject({
        status: "stale",
        error: "keychain_unreachable",
      });
      expect(readCachedProvider("claude")).toBeDefined();
      expect(valueReadArgs()).toEqual([
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        service,
      ]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports missing for unrelated services and non-password items", async () => {
    mockItems(
      item("other-service", undefined, "other-user") +
        item("unrelated-credentials-ABCDEF12", undefined, "other-user") +
        item("other-service") +
        item(service, undefined, undefined, undefined, "inet"),
    );
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth(options);
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "missing",
    });
    expect(execFileText.mock.calls).toEqual([
      ["security", ["list-keychains"], 5000],
      ["security", ["dump-keychain", keychain], 5000],
    ]);
  });

  it.each([
    ["an unfamiliar suffix length", "Claude Code-credentials-0123456789abcdef"],
    ["an uppercase suffix", "Claude Code-credentials-ABCDEF12"],
    ["a trailing segment", "Claude Code-credentials-deadbeef-extra"],
  ])(
    "never reports sign-out when this account holds a Claude item with %s",
    async (_label, unfamiliar) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
      mockItems(item(unfamiliar), "unavailable-service");
      const { readCachedProvider, writeCachedProviders } =
        await import("../../src/cache.js");
      writeCachedProviders([cachedClaude()]);
      const { fetchQuota } = await import("../../src/providers/claude.js");
      const report = await fetchQuota(options);

      expect(report.state.status).toBe("stale");
      expect(report.source).toBe("cache");
      expect(readCachedProvider("claude")).toBeDefined();
      expect(valueReadArgs()).toContain("Claude Code-credentials");
      expect(valueReadArgs()).not.toContain(unfamiliar);
    },
  );

  it("still prefers a recognized item over an unfamiliar one for the same account", async () => {
    mockItems(
      item("Claude Code-credentials-0123456789abcdef", "20260913020000Z") +
        item(),
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(service);
  });

  it.each([false, true])(
    "does not read absence from a listing that printed nothing (prompt=%s)",
    async (allowKeychainPrompt) => {
      mockItems("", "unavailable-service");
      const { inspectAuth } = await import("../../src/providers/claude.js");
      const auth = await inspectAuth({ ...options, allowKeychainPrompt });
      expect(auth.sources).not.toContainEqual(
        expect.objectContaining({ source: "keychain", status: "missing" }),
      );
      expect(
        execFileText.mock.calls.some(([, args]) =>
          args.includes("Claude Code-credentials"),
        ),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    "enumerates explicit profiles without crossing to another service (prompt=%s)",
    async (allowKeychainPrompt) => {
      const configDir = join(home, "managed");
      const selectedService = profileService(configDir);
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      mockItems(item(), "unavailable-service");
      const { inspectAuth } = await import("../../src/providers/claude.js");
      const auth = await inspectAuth({ ...options, allowKeychainPrompt });
      expect(auth.sources).toContainEqual(
        expect.objectContaining({
          source: "keychain",
          status: "skipped",
          error: "keychain_unreachable",
        }),
      );
      expect(execFileText.mock.calls.slice(0, 2)).toEqual([
        ["security", ["list-keychains"], 5000],
        ["security", ["dump-keychain", keychain], 5000],
      ]);
      expect(execFileText.mock.calls[2]?.[1]).toContain(selectedService);
      expect(execFileText.mock.calls[2]?.[1]).not.toContain(service);
    },
  );

  it("reads only the exact explicit-profile item even if the default is newer", async () => {
    const configDir = join(home, "managed");
    const selectedService = profileService(configDir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    mockItems(
      item(selectedService, "20260101000000Z") + item(),
      selectedService,
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");

    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(selectedService);
    expect(valueReadArgs()).not.toContain(service);
  });

  it("keeps an ambiguous exit 44 as unreachable without asserting absence", async () => {
    execFileText.mockRejectedValue(
      Object.assign(new Error("unreachable"), { code: 44 }),
    );
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth(options);
    expect(auth.sources).toContainEqual(
      expect.objectContaining({
        source: "keychain",
        status: "skipped",
        error: "keychain_unreachable",
      }),
    );
  });

  it.each([false, true])(
    "uses search-list order for duplicate services regardless of dump order (reverse=%s)",
    async (reverse) => {
      const records = [
        item(service, "20260101000000Z", undefined, keychain),
        item(service, "20260913020000Z", undefined, otherKeychain),
      ];
      mockItems((reverse ? records.reverse() : records).join(""), service, [
        keychain,
        otherKeychain,
      ]);
      const { fetchQuota } = await import("../../src/providers/claude.js");
      expect((await fetchQuota(options)).state.status).toBe("fresh");
      expect(valueReadArgs().at(-1)).toBe(keychain);
    },
  );

  it("handles hex metadata and ignores unrelated numeric item classes", async () => {
    const hex = (value: string) => `0x${Buffer.from(value).toString("hex")}`;
    const metadata = item()
      .replace(`"${service}"`, hex(service))
      .replace('"fixture-user"', hex("fixture-user"))
      .replace(`"${keychain}"`, hex(keychain));
    mockItems(
      metadata +
        item("unrelated").replace('class: "genp"', "class: 0x80001000"),
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(keychain);
  });

  it("still reads a located item alongside an unreadable unrelated record", async () => {
    mockItems(
      item() + 'keychain: "/fixture/incomplete.keychain-db"\nversion: 512\n',
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(valueReadArgs()).toContain(service);
  });

  it("does not turn a wholly unreadable listing into absence", async () => {
    mockItems(
      'keychain: "/fixture/incomplete.keychain-db"\nversion: 512\n',
      "unavailable-service",
    );
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth(options);
    expect(auth.sources).toContainEqual(
      expect.objectContaining({
        source: "keychain",
        status: "skipped",
        error: "keychain_unreachable",
      }),
    );
    expect(valueReadArgs()).toContain("Claude Code-credentials");
  });

  it.each([
    ["denied", { code: 51 }, "keychain_access_denied"],
    ["timeout", { killed: true, signal: "SIGTERM" }, "keychain_prompt_timeout"],
    ["unreachable", { code: 44 }, "keychain_unreachable"],
  ])(
    "does not cross profiles after a %s value read",
    async (_label, failure, error) => {
      execFileText.mockImplementation(async (_command: string, args) => {
        if (args[0] === "list-keychains") return `    "${keychain}"\n`;
        if (args[0] === "dump-keychain")
          return (
            item() +
            item(profileService("/fixture/other-profile"), "20260914000000Z")
          );
        throw Object.assign(new Error("read failed"), failure);
      });
      const { inspectAuth } = await import("../../src/providers/claude.js");
      expect((await inspectAuth(options)).sources).toContainEqual({
        source: "keychain",
        status: "skipped",
        error,
        credentialPresent: true,
      });
      expect(
        execFileText.mock.calls.filter(([, args]) => args.includes("-w")),
      ).toHaveLength(1);
    },
  );

  it("reports a selected item that cannot be read as unreachable, not absent", async () => {
    mockItems(item(), "unavailable-service");
    const { inspectAuth } = await import("../../src/providers/claude.js");
    expect((await inspectAuth(options)).sources).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_unreachable",
      credentialPresent: true,
    });
    expect(execFileText).toHaveBeenCalledTimes(3);
  });

  it("detects a sign-in on a later read in the same process", async () => {
    let signedIn = false;
    execFileText.mockImplementation(async (_command: string, args) => {
      if (args[0] === "list-keychains") return `    "${keychain}"\n`;
      if (args[0] === "dump-keychain")
        return signedIn ? item() : item("other-service");
      return JSON.stringify({
        claudeAiOauth: { accessToken: "synthetic-token" },
      });
    });
    const { fetchQuota } = await import("../../src/providers/claude.js");

    expect((await fetchQuota(options)).state.status).toBe("auth_required");
    signedIn = true;
    expect((await fetchQuota(options)).state.status).toBe("fresh");
  });

  it("recovers when a selected item is replaced in another keychain during repeated refreshes", async () => {
    const selectedService = profileService("/fixture/tui-profile");
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/fixture/tui-profile");
    let activeKeychain = keychain;
    execFileText.mockImplementation(async (command: string, args: string[]) => {
      expect(command).toBe("security");
      if (args[0] === "list-keychains")
        return `"${keychain}"\n"${otherKeychain}"\n`;
      if (args[0] === "dump-keychain") {
        expect(args).toEqual(["dump-keychain", keychain, otherKeychain]);
        return [keychain, otherKeychain]
          .map((path) =>
            item(
              path === activeKeychain ? selectedService : "other-service",
              undefined,
              undefined,
              path,
            ),
          )
          .join("");
      }
      expect(args.slice(0, 3)).toEqual([
        "find-generic-password",
        "-a",
        "fixture-user",
      ]);
      if (!args.includes(selectedService) || args.at(-1) !== activeKeychain)
        throw unreachable();
      return JSON.stringify({
        claudeAiOauth: { accessToken: "synthetic-token" },
      });
    });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    activeKeychain = otherKeychain;
    expect(
      (await fetchQuota({ ...options, allowKeychainPrompt: false })).state
        .status,
    ).toBe("fresh");

    const reads = execFileText.mock.calls.filter(([, args]) =>
      args.includes("-w"),
    );
    expect(reads.map(([, args]) => args.at(-1))).toEqual([
      keychain,
      otherKeychain,
    ]);
    expect(
      execFileText.mock.calls.filter(([, args]) => args[0] === "dump-keychain"),
    ).toHaveLength(2);
  });

  it("reselects a changed secure-storage profile without transferring its prompt grant", async () => {
    const firstProfile = "/fixture/tui-first-profile";
    const nextProfile = "/fixture/tui-next-profile";
    const firstService = profileService(firstProfile);
    const nextService = profileService(nextProfile);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", firstProfile);
    mockItems(item(firstService), firstService);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");

    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", nextProfile);
    mockItems(item(nextService), nextService);
    const withheld = await fetchQuota({
      ...options,
      allowKeychainPrompt: false,
    });
    expect(withheld.state).toMatchObject({
      status: "auth_required",
      error: "keychain_prompt_required",
    });
    expect(withheld.attempts).toContainEqual(
      expect.objectContaining({
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
      }),
    );
    expect(
      execFileText.mock.calls.filter(([, args]) => args.includes("-w")),
    ).toHaveLength(1);

    expect((await fetchQuota(options)).state.status).toBe("fresh");
    const reads = execFileText.mock.calls.filter(([, args]) =>
      args.includes("-w"),
    );
    expect(reads.map(([, args]) => args[args.indexOf("-s") + 1])).toEqual([
      firstService,
      nextService,
    ]);
  });

  it("does not follow metadata naming a keychain outside the search list", async () => {
    mockItems(
      item(service, undefined, undefined, otherKeychain),
      "unavailable-service",
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);
    expect(report.state.status).not.toBe("auth_required");
    expect(valueReadArgs()).not.toContain(otherKeychain);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves cached quota when a partial search-list dump fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
    execFileText.mockImplementation(async (command: string, args: string[]) => {
      expect(command).toBe("security");
      if (args[0] === "list-keychains")
        return `"${keychain}"\n"${otherKeychain}"\n`;
      if (args[0] === "dump-keychain") {
        expect(args).toEqual(["dump-keychain", keychain, otherKeychain]);
        throw Object.assign(new Error("synthetic partial listing failure"), {
          code: 44,
          stdout: item("unrelated-service"),
        });
      }
      expect(args.slice(0, 3)).toEqual([
        "find-generic-password",
        "-a",
        "fixture-user",
      ]);
      expect(args).toContain(service);
      expect(args).not.toContain(keychain);
      expect(args).not.toContain(otherKeychain);
      throw unreachable();
    });
    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaude()]);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state).toMatchObject({
      status: "stale",
      error: "keychain_unreachable",
    });
    expect(readCachedProvider("claude")).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not infer missing from a successful dump that omits a searchable keychain", async () => {
    mockItems(item("unrelated-service"), "unavailable-service", [
      keychain,
      otherKeychain,
    ]);
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth(options);
    expect(auth.sources).not.toContainEqual({
      source: "keychain",
      status: "missing",
    });
  });

  it("does not infer missing from a Claude item owned by another account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
    mockItems(
      item(service, undefined, "other-fixture-user"),
      "unavailable-service",
    );
    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaude()]);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state).toMatchObject({
      status: "stale",
      error: "keychain_unreachable",
    });
    expect(readCachedProvider("claude")).toBeDefined();
    expect(valueReadArgs()).toContain("fixture-user");
    expect(valueReadArgs()).not.toContain("other-fixture-user");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("withholds a snapshot from the former opaque-discovery context without deleting it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
    mockItems(item("Claude Code-credentials-abcdef12"), "unavailable-service");
    const { cacheFilePath } = await import("../../src/lib/fs.js");
    const file = cacheFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        providers: [
          {
            ...cachedClaude(),
            credentialContext: createHash("sha256")
              .update(`claude-config-dir:${join(home, ".claude")}`)
              .digest("hex"),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const { readCachedProvider } = await import("../../src/cache.js");
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).not.toBe("stale");
    expect(report.windows).toEqual([]);
    expect(readCachedProvider("claude")?.windows).toEqual(
      cachedClaude().windows,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps cached quota when a located item is unread and a leftover file is rejected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-rejected-token",
          expiresAt: 0,
        },
      }),
    );
    mockItems(item());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const { readCachedProvider, writeCachedProviders } =
      await import("../../src/cache.js");
    writeCachedProviders([cachedClaude()]);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ ...options, allowKeychainPrompt: false });

    expect(report.state).toMatchObject({
      status: "stale",
      error: "keychain_prompt_required",
    });
    expect(report.source).toBe("cache");
    expect(readCachedProvider("claude")).toBeDefined();
    expect(valueReadArgs()).toEqual([]);
  });

  it("keeps an unchecked Keychain visible behind the file credential that answered", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-file-token",
          expiresAt: Date.parse("2035-01-01T00:00:00Z"),
        },
      }),
    );
    execFileText.mockRejectedValue(
      Object.assign(new Error("listing failed"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
    );
    const chunks: string[] = [];
    const { main } = await import("../../src/cli.js");
    await main({
      argv: ["--provider", "claude", "--no-credential-refresh"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    expect(chunks.join("")).toContain(
      "claude,all,degraded_source,keychain · keychain_presence_check_failed,none",
    );
  });

  it.each([
    ["unreachable", { code: 44 }, "keychain_unreachable"],
    ["timeout", { killed: true, signal: "SIGTERM" }, "keychain_prompt_timeout"],
    [
      "buffer limit",
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      "keychain_access_denied",
    ],
  ])(
    "preserves cached quota after %s discovery and a leftover file's 401",
    async (_label, failure, error) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-13T01:00:00Z"));
      mkdirSync(join(home, ".claude"));
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "synthetic-rejected-token",
            expiresAt: 0,
          },
        }),
      );
      execFileText.mockRejectedValue(
        Object.assign(new Error("listing failed"), failure),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 401 })),
      );
      const { readCachedProvider, writeCachedProviders } =
        await import("../../src/cache.js");
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
              percentUsed: 12,
            },
          ],
          state: {
            status: "fresh",
            stale: false,
            refreshedAt: "2026-09-13T00:30:00Z",
            sourcesTried: ["oauth"],
          },
        },
      ]);
      const { fetchQuota } = await import("../../src/providers/claude.js");
      const report = await fetchQuota(options);
      expect(report.state).toMatchObject({ status: "stale", error });
      expect(report.source).toBe("cache");
      expect(readCachedProvider("claude")).toBeDefined();
    },
  );
});
