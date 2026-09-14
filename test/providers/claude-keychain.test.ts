import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileText = vi.fn();
vi.mock("../../src/lib/process.js", () => ({ execFileText }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const options = { allowKeychainPrompt: true, refreshCredentials: false };
const service = "Claude Code-credentials-abcdef12";
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

function mockItems(metadata: string, readableService = service): void {
  execFileText.mockImplementation(async (command: string, args: string[]) => {
    if (command !== "security") throw new Error("unexpected command");
    if (args[0] === "default-keychain") return `    "${keychain}"\n`;
    if (args[0] === "dump-keychain") {
      if (args[1] !== keychain) throw new Error("unbounded dump");
      return metadata;
    }
    if (args.includes("-w") && args.includes(readableService)) {
      return JSON.stringify({
        claudeAiOauth: { accessToken: "synthetic-token" },
      });
    }
    throw Object.assign(
      new Error(
        `Command failed: security ${args.join(" ")}\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n`,
      ),
      {
        code: 44,
      },
    );
  });
}

describe("Claude macOS Keychain discovery", () => {
  it("still reads a legacy unsuffixed item", async () => {
    mockItems(item("Claude Code-credentials"), "Claude Code-credentials");
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
  });

  it("reads quota from a suffixed item when the unsuffixed item does not exist", async () => {
    mockItems(item());
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toMatchObject([
      { id: "five_hour", percentUsed: 12 },
    ]);
    expect(execFileText.mock.calls).toEqual([
      ["security", ["default-keychain"], 5000],
      ["security", ["dump-keychain", keychain], 5000],
      [
        "security",
        [
          "find-generic-password",
          "-a",
          "fixture-user",
          "-w",
          "-s",
          service,
          keychain,
        ],
        60000,
      ],
    ]);
    expect(JSON.stringify(report)).not.toContain("synthetic-token");
    expect(JSON.stringify(report)).not.toContain("fixture-user");
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
      ["security", ["default-keychain"], 5000],
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

  it("selects the newest matching item among thousands and reads only one value", async () => {
    const old = Array.from({ length: 1306 }, (_, index) =>
      item(
        `Claude Code-credentials-${index.toString(16).padStart(8, "0")}`,
        "20260101010000Z",
      ),
    ).join("");
    mockItems(
      old + item("Claude Code-credentials", "20260102010000Z") + item(),
    );
    const { fetchQuota } = await import("../../src/providers/claude.js");
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(
      execFileText.mock.calls.filter(([, args]) => args.includes("-w")),
    ).toEqual([
      [
        "security",
        [
          "find-generic-password",
          "-a",
          "fixture-user",
          "-w",
          "-s",
          service,
          keychain,
        ],
        60000,
      ],
    ]);
  });

  it("ignores other accounts, unrelated services and non-password items", async () => {
    mockItems(
      item(service, undefined, "other-user") +
        item("Claude Code-credentials-ABCDEF12", undefined, "other-user") +
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
      ["security", ["default-keychain"], 5000],
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
    "keeps explicit profiles pinned and never reads absence from an exact read (prompt=%s)",
    async (allowKeychainPrompt) => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "managed"));
      mockItems(item());
      const { inspectAuth, claudeKeychainService } =
        await import("../../src/providers/claude.js");
      const auth = await inspectAuth({ ...options, allowKeychainPrompt });
      expect(auth.sources).toContainEqual(
        expect.objectContaining({
          source: "keychain",
          status: "skipped",
          error: "keychain_unreachable",
        }),
      );
      expect(execFileText).toHaveBeenCalledTimes(1);
      expect(execFileText.mock.calls[0]?.[1]).toContain(
        claudeKeychainService(),
      );
      expect(execFileText.mock.calls[0]?.[1]).not.toContain("dump-keychain");
    },
  );

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
    "breaks equal modification-time ties deterministically (reverse=%s)",
    async (reverse) => {
      const records = [
        item("Claude Code-credentials-ffffffff"),
        item(),
        item("Claude Code-credentials-00000000", "unknown"),
      ];
      mockItems((reverse ? records.reverse() : records).join(""));
      const { fetchQuota } = await import("../../src/providers/claude.js");
      expect((await fetchQuota(options)).state.status).toBe("fresh");
      expect(valueReadArgs()).toContain(service);
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
    mockItems('keychain: "/fixture/incomplete.keychain-db"\nversion: 512\n');
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
    "does not read older candidates after a %s value read",
    async (_label, failure, error) => {
      execFileText.mockImplementation(async (_command: string, args) => {
        if (args[0] === "default-keychain") return `    "${keychain}"\n`;
        if (args[0] === "dump-keychain")
          return item() + item("Claude Code-credentials", "20260101000000Z");
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
      if (args[0] === "default-keychain") return `    "${keychain}"\n`;
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

  it("lists once per process after it locates an item", async () => {
    mockItems(item());
    const { fetchQuota } = await import("../../src/providers/claude.js");
    await fetchQuota(options);
    await fetchQuota(options);
    expect(
      execFileText.mock.calls.filter(([, args]) => args[0] === "dump-keychain"),
    ).toHaveLength(1);
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
      argv: ["--provider", "claude"],
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
