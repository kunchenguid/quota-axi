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

function mockItems(metadata: string, readableService = service): void {
  execFileText.mockImplementation(async (command: string, args: string[]) => {
    if (command !== "security") throw new Error("unexpected command");
    if (args[0] === "dump-keychain") return metadata;
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
      ["security", ["dump-keychain"], 5000],
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
      ["security", ["dump-keychain"], 5000],
    ]);

    const { claudeKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const marker = claudeKeychainAccessMarkerPath("fixture-user");
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
      old +
        item("Claude Code-credentials", "20260102010000Z") +
        item() +
        item(
          service,
          "20260101010000Z",
          "fixture-user",
          "/fixture/old.keychain-db",
        ),
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

  it("ignores other accounts, unrelated services, invalid suffixes and non-password items", async () => {
    mockItems(
      item(service, undefined, "other-user") +
        item("other-service") +
        item("Claude Code-credentials-ABCDEF12") +
        item("Claude Code-credentials-deadbeef-extra") +
        item(service, undefined, undefined, undefined, "inet"),
    );
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth(options);
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "missing",
    });
    expect(execFileText.mock.calls).toEqual([
      ["security", ["dump-keychain"], 5000],
    ]);
  });

  it.each([false, true])(
    "reports a successfully listed empty Keychain as missing (prompt=%s)",
    async (allowKeychainPrompt) => {
      mockItems("");
      const { inspectAuth } = await import("../../src/providers/claude.js");
      const auth = await inspectAuth({ ...options, allowKeychainPrompt });
      expect(auth.sources).toContainEqual({
        source: "keychain",
        status: "missing",
      });
    },
  );

  it.each([false, true])(
    "keeps explicit profiles pinned and classifies exact item-not-found (prompt=%s)",
    async (allowKeychainPrompt) => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "managed"));
      mockItems(item());
      const { inspectAuth, claudeKeychainService } =
        await import("../../src/providers/claude.js");
      const auth = await inspectAuth({ ...options, allowKeychainPrompt });
      expect(auth.sources).toContainEqual({
        source: "keychain",
        status: "missing",
      });
      expect(execFileText).toHaveBeenCalledTimes(1);
      expect(execFileText.mock.calls[0]?.[1]).toContain(
        claudeKeychainService(),
      );
      expect(execFileText.mock.calls[0]?.[1]).not.toContain("dump-keychain");
    },
  );

  it("keeps an ambiguous exit 44 as unreachable without asserting credential presence", async () => {
    execFileText.mockRejectedValue(
      Object.assign(new Error("unreachable"), { code: 44 }),
    );
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth(options);
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_unreachable",
    });
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
      expect(execFileText.mock.calls[1]?.[1]).toContain(service);
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
    expect(execFileText.mock.calls[1]?.[1]).toContain(keychain);
  });

  it("does not turn an incomplete metadata listing into absence or read a partial selection", async () => {
    mockItems(
      item() + 'keychain: "/fixture/incomplete.keychain-db"\nversion: 512\n',
    );
    const { inspectAuth } = await import("../../src/providers/claude.js");
    const auth = await inspectAuth(options);
    expect(auth.sources).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_presence_check_failed",
    });
    expect(execFileText).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["denied", { code: 51 }, "keychain_access_denied"],
    ["timeout", { killed: true, signal: "SIGTERM" }, "keychain_prompt_timeout"],
    ["unreachable", { code: 44 }, "keychain_unreachable"],
  ])(
    "does not read older candidates after a %s value read",
    async (_label, failure, error) => {
      execFileText.mockResolvedValueOnce(
        item() + item("Claude Code-credentials", "20260101000000Z"),
      );
      execFileText.mockRejectedValue(
        Object.assign(new Error("read failed"), failure),
      );
      const { inspectAuth } = await import("../../src/providers/claude.js");
      expect((await inspectAuth(options)).sources).toContainEqual({
        source: "keychain",
        status: "skipped",
        error,
        credentialPresent: true,
      });
      expect(execFileText).toHaveBeenCalledTimes(2);
    },
  );

  it("reports a selected item deleted between listing and read as missing", async () => {
    mockItems(item(), "unavailable-service");
    const { inspectAuth } = await import("../../src/providers/claude.js");
    expect((await inspectAuth(options)).sources).toContainEqual({
      source: "keychain",
      status: "missing",
    });
    expect(execFileText).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "does not mistake a search setup failure followed by not-found for absence (prompt=%s)",
    async (allowKeychainPrompt) => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "managed"));
      execFileText.mockRejectedValue(
        Object.assign(new Error("search failed"), {
          code: 44,
          stderr:
            "security: SecKeychainSearchCreateFromAttributes: The specified keychain could not be found.\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
        }),
      );
      const { inspectAuth } = await import("../../src/providers/claude.js");
      const auth = await inspectAuth({ ...options, allowKeychainPrompt });
      expect(auth.sources).toContainEqual(
        expect.objectContaining({
          source: "keychain",
          status: "skipped",
          error: "keychain_unreachable",
        }),
      );
    },
  );

  it.each([
    ["unreachable", { code: 44 }, "keychain_unreachable"],
    [
      "timeout",
      { killed: true, signal: "SIGTERM" },
      "keychain_presence_check_failed",
    ],
    [
      "buffer limit",
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      "keychain_presence_check_failed",
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
      expect(execFileText).toHaveBeenCalledTimes(1);
    },
  );
});
