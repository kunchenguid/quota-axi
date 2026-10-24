import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuota } from "../../src/types.js";

/**
 * When the Cursor editor and the `cursor-agent` CLI are signed in to different
 * accounts (a personal login in `state.vscdb`, a team login whose identity is in
 * `cli-config.json` and whose token is in the login Keychain), quota is reported
 * as two account lanes so the team usage is never hidden behind the personal
 * one. These cases run the account collector over a synthetic editor store, a
 * synthetic `cli-config.json`, a mocked `sqlite3`/`security` boundary, and a
 * stubbed vendor. No real Keychain, store, or network is touched.
 */
const EDITOR_TOKEN = "editor-token-stand-in";
const CLI_TOKEN = "cli-keychain-token-stand-in";

const originalEnv = {
  CURSOR_STATE_DB: process.env.CURSOR_STATE_DB,
  CURSOR_CLI_CONFIG: process.env.CURSOR_CLI_CONFIG,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cursor-lanes-"));
  process.env.CURSOR_STATE_DB = join(tempDir, "state.vscdb");
  process.env.CURSOR_CLI_CONFIG = join(tempDir, "cli-config.json");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

async function onDarwin<T>(callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

function writeCliConfig(email: string): void {
  writeFileSync(
    process.env.CURSOR_CLI_CONFIG!,
    JSON.stringify({ authInfo: { email, userId: "cli-user-1" } }),
  );
}

type ProcessMock = {
  editorEmail?: string;
  keychainToken?: string;
  keychainPresent?: boolean;
};

/** Mirrors how the provider shells out: `sqlite3` for the editor, `security` for the Keychain. */
function mockProcess(mock: ProcessMock): { calls: string[][] } {
  const calls: string[][] = [];
  vi.doMock("../../src/lib/process.js", () => ({
    commandExists: vi.fn(async (command: string) => command === "sqlite3"),
    execFileText: vi.fn(async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "sqlite3") {
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken"))
          return JSON.stringify(EDITOR_TOKEN);
        if (query.includes("cursorAuth/cachedEmail"))
          return JSON.stringify(mock.editorEmail ?? "editor@example.invalid");
        return JSON.stringify("pro");
      }
      if (command === "security") {
        // Value reads pass `-w`; the presence probe deliberately does not.
        if (!args.includes("-w")) {
          if (mock.keychainPresent === false)
            throw Object.assign(new Error("not found"), { code: 44 });
          return "keychain item found";
        }
        if (mock.keychainToken === undefined)
          throw Object.assign(new Error("not found"), { code: 44 });
        return `${mock.keychainToken}\n`;
      }
      throw new Error(`unexpected command ${command}`);
    }),
  }));
  return { calls };
}

/**
 * A distinct usage figure per bearer, so a lane that reported the sibling's
 * account would be visible: the personal editor account is nearly spent, the
 * team CLI account is not.
 */
function mockUsageApi(): { bearers: string[] } {
  const bearers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      bearers.push(bearer);
      if (String(url).includes("GetPlanInfo")) {
        return new Response(
          JSON.stringify({
            planInfo: {
              planName: bearer.includes(CLI_TOKEN) ? "business" : "pro",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          billingCycleEnd: "1783036800000",
          planUsage: {
            totalPercentUsed: bearer.includes(CLI_TOKEN) ? 7 : 42,
          },
        }),
        { status: 200 },
      );
    }),
  );
  return { bearers };
}

async function collect(options: {
  allowKeychainPrompt: boolean;
}): Promise<ProviderQuota[]> {
  const { fetchAccountQuotas } =
    await import("../../src/providers/accounts.js");
  const { cursorAdapter } = await import("../../src/providers/cursor.js");
  return fetchAccountQuotas(cursorAdapter, {
    allowKeychainPrompt: options.allowKeychainPrompt,
    refreshCredentials: false,
  });
}

function includedRemaining(
  report: ProviderQuota | undefined,
): number | undefined {
  return report?.windows.find((w) => w.id === "included_usage")
    ?.percentRemaining;
}

describe("Cursor editor and CLI account lanes", () => {
  it("reports the editor and the team CLI as separate lanes when their identities differ", async () => {
    writeCliConfig("team@example.invalid");
    mockProcess({ keychainToken: CLI_TOKEN });
    mockUsageApi();

    await onDarwin(async () => {
      const result = await collect({ allowKeychainPrompt: true });

      expect(result.map((r) => r.accountKey)).toEqual([
        "cursor-editor",
        "cursor-cli",
      ]);
      expect(result.map((r) => r.accountKeys)).toEqual([
        ["cursor-editor"],
        ["cursor-cli"],
      ]);
      // Each lane reports its own account's usage, not the sibling's.
      expect(result[0].plan).toBe("pro");
      expect(includedRemaining(result[0])).toBe(58);
      expect(result[1].plan).toBe("business");
      expect(includedRemaining(result[1])).toBe(93);
      expect(JSON.stringify(result)).not.toContain(EDITOR_TOKEN);
      expect(JSON.stringify(result)).not.toContain(CLI_TOKEN);
    });
  });

  it("reads the team CLI token through the keychain gate only", async () => {
    writeCliConfig("team@example.invalid");
    const { calls } = mockProcess({ keychainToken: CLI_TOKEN });
    mockUsageApi();

    await onDarwin(async () => {
      await collect({ allowKeychainPrompt: true });
      const valueReads = calls.filter(
        ([command, ...args]) => command === "security" && args.includes("-w"),
      );
      expect(valueReads).toHaveLength(1);
      expect(valueReads[0]).toContain("cursor-access-token");
    });
  });

  it("keeps one lane when the editor and CLI are the same account", async () => {
    writeCliConfig("editor@example.invalid");
    mockProcess({ editorEmail: "editor@example.invalid" });
    mockUsageApi();

    await onDarwin(async () => {
      const result = await collect({ allowKeychainPrompt: true });
      expect(result).toHaveLength(1);
      // A sole lane keeps the legacy keyless shape.
      expect(result[0].accountKey).toBeUndefined();
    });
  });

  it("keeps one lane when the CLI identity is unknown", async () => {
    // No cli-config.json, so the CLI login cannot be compared to the editor's.
    mockProcess({});
    mockUsageApi();

    await onDarwin(async () => {
      const result = await collect({ allowKeychainPrompt: true });
      expect(result).toHaveLength(1);
      expect(result[0].accountKey).toBeUndefined();
    });
  });

  it("reports only the editor lane when the team CLI keychain read is gated", async () => {
    writeCliConfig("team@example.invalid");
    const { calls } = mockProcess({ keychainToken: CLI_TOKEN });
    mockUsageApi();

    await onDarwin(async () => {
      const result = await collect({ allowKeychainPrompt: false });

      expect(result.map((r) => r.accountKey)).toEqual([
        "cursor-editor",
        "cursor-cli",
      ]);
      // The gated CLI lane reports the keychain gate, never a number it did not read.
      const cli = result[1];
      expect(cli.windows).toEqual([]);
      expect(cli.state.status).toBe("auth_required");
      expect(cli.state.error).toBe("keychain_prompt_required");
      // The editor lane still reports its own live usage.
      expect(includedRemaining(result[0])).toBe(58);
      // Without the opt-in, no Keychain value read is attempted at all.
      const valueReads = calls.filter(
        ([command, ...args]) => command === "security" && args.includes("-w"),
      );
      expect(valueReads).toHaveLength(0);
    });
  });

  it("caches each lane under its own key so one account never serves the other", async () => {
    writeCliConfig("team@example.invalid");
    mockProcess({ keychainToken: CLI_TOKEN });
    mockUsageApi();

    await onDarwin(async () => {
      const { writeCachedProviders, readCachedProvider } =
        await import("../../src/cache.js");
      const result = await collect({ allowKeychainPrompt: true });
      writeCachedProviders(result);

      const editor = readCachedProvider("cursor", "cursor-editor");
      const cli = readCachedProvider("cursor", "cursor-cli");
      expect(includedRemaining(editor)).toBe(58);
      expect(includedRemaining(cli)).toBe(93);
      // The legacy default slot holds neither: lanes never collide.
      expect(readCachedProvider("cursor")).toBeUndefined();
    });
  });
});
