import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuota } from "../../src/types.js";

/**
 * A CLI-only Cursor machine has no editor `state.vscdb` at all, so these cases
 * cover quota refresh from the platform `cursor-agent` credential store alone.
 * The token value is a stand-in string here so every case can also assert that
 * it never reaches the report.
 */
const CLI_TOKEN = "cli-keychain-token-stand-in";
const EDITOR_TOKEN = "editor-token-stand-in";

const originalEnv = {
  CURSOR_STATE_DB: process.env.CURSOR_STATE_DB,
  CURSOR_CLI_CONFIG: process.env.CURSOR_CLI_CONFIG,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cursor-cli-quota-"));
  // Absent on purpose: the editor database is what a CLI-only machine lacks.
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

async function onLinux<T>(callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

function writeCliConfig(): void {
  writeFileSync(
    process.env.CURSOR_CLI_CONFIG!,
    JSON.stringify({
      authInfo: { email: "person@example.invalid", userId: "cursor-user-1" },
    }),
  );
}

function writeCliAuthFile(): void {
  writeFileSync(
    process.env.CURSOR_CLI_CONFIG!,
    JSON.stringify({
      accessToken: CLI_TOKEN,
      refreshToken: "refresh-token-must-not-be-used",
    }),
  );
}

type ProcessMock = {
  editorToken?: string;
  editorError?: string;
  keychainToken?: string;
  keychainPresent?: boolean;
};

/** Mirrors how the provider shells out: `sqlite3` for the editor store, `security` for the Keychain. */
function mockProcess(mock: ProcessMock): { calls: string[][] } {
  const calls: string[][] = [];
  vi.doMock("../../src/lib/process.js", () => ({
    commandExists: vi.fn(async () => true),
    execFileText: vi.fn(async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "sqlite3") {
        if (mock.editorError) throw new Error(mock.editorError);
        if (mock.editorToken === undefined)
          throw new Error("unable to open database file");
        const query = args.at(-1) ?? "";
        if (query.includes("cursorAuth/accessToken"))
          return JSON.stringify(mock.editorToken);
        if (query.includes("cursorAuth/cachedEmail"))
          return '"editor@example.invalid"';
        return "";
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

function mockUsageApi(): { bearers: string[] } {
  const bearers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      if (String(url).includes("GetPlanInfo")) {
        return new Response(
          JSON.stringify({ planInfo: { planName: "ultra" } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          billingCycleEnd: "1783036800000",
          planUsage: { totalPercentUsed: 12 },
        }),
        { status: 200 },
      );
    }),
  );
  return { bearers };
}

/** A previously cached snapshot, so a failed refresh would visibly fall back to it. */
async function seedCache(): Promise<void> {
  const { writeCachedProviders } = await import("../../src/cache.js");
  const cached: ProviderQuota = {
    provider: "cursor",
    label: "Cursor",
    source: "api",
    plan: "ultra",
    windows: [
      {
        id: "included_usage",
        label: "included usage",
        kind: "monthly",
        percentUsed: 100,
        percentRemaining: 0,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-08-12T04:03:06.000Z",
      sourcesTried: ["state-vscdb", "api"],
    },
  };
  writeCachedProviders([cached]);
}

describe("Cursor CLI-only quota refresh", () => {
  it("refreshes quota from the Linux CLI auth file when the editor database is absent", async () => {
    writeCliAuthFile();
    mockProcess({});
    const { bearers } = mockUsageApi();

    await onLinux(async () => {
      await seedCache();
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state.status).toBe("fresh");
      expect(result.state.stale).toBe(false);
      expect(result.state.sourcesTried).toEqual([
        "state-vscdb",
        "cli-authfile",
      ]);
      expect(result.attempts).toEqual([
        {
          source: "state-vscdb",
          status: "skipped",
          error: "credentials_missing",
        },
        { source: "cli-authfile", status: "success" },
      ]);
      expect(result.windows).toMatchObject([
        { id: "included_usage", percentUsed: 12, percentRemaining: 88 },
      ]);
      expect(bearers).toEqual([
        `Bearer ${CLI_TOKEN}`,
        `Bearer ${CLI_TOKEN}`,
        `Bearer ${CLI_TOKEN}`,
      ]);
      expect(JSON.stringify(result)).not.toContain(
        "refresh-token-must-not-be-used",
      );
    });
  });

  it("keeps an invalid editor store degraded when CLI auth returns quota", async () => {
    writeCliAuthFile();
    mockProcess({ editorError: "database disk image is malformed" });
    mockUsageApi();

    await onLinux(async () => {
      const { withQuotaSemantics } =
        await import("../../src/interpretation.js");
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });
      const interpreted = withQuotaSemantics(result, new Date().toISOString());

      expect(result.state.status).toBe("fresh");
      expect(result.windows.length).toBeGreaterThan(0);
      expect(interpreted.state.degradedSources).toEqual([
        { source: "state-vscdb", error: "sqlite_read_error" },
      ]);
    });
  });

  it("falls back to stale quota when the Linux auth-file token is rejected", async () => {
    writeCliAuthFile();
    mockProcess({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );

    await onLinux(async () => {
      await seedCache();
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state.status).toBe("stale");
      expect(result.state.error).toBe("Cursor sign-in required");
      expect(result.state.sourcesTried).toEqual([
        "state-vscdb",
        "cli-authfile",
        "cache",
      ]);
      expect(result.attempts).toEqual([
        {
          source: "state-vscdb",
          status: "skipped",
          error: "credentials_missing",
        },
        {
          source: "cli-authfile",
          status: "failed",
          error: "Cursor sign-in required",
        },
      ]);
    });
  });

  it("refreshes quota from the CLI Keychain token when the editor database is absent", async () => {
    writeCliConfig();
    mockProcess({ keychainToken: CLI_TOKEN });
    const { bearers } = mockUsageApi();

    await onDarwin(async () => {
      await seedCache();
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });

      expect(result.state.status).toBe("fresh");
      expect(result.state.stale).toBe(false);
      expect(result.state.error).toBeUndefined();
      expect(result.source).toBe("api");
      expect(result.state.sourcesTried).toContain("cli-keychain");
      expect(result.attempts).toContainEqual({
        source: "cli-keychain",
        status: "success",
      });
      expect(result.plan).toBe("ultra");
      expect(result.account?.email).toBe("person@example.invalid");
      expect(result.windows).toMatchObject([
        { id: "included_usage", percentUsed: 12, percentRemaining: 88 },
      ]);
      // The Keychain token is the bearer of Cursor's read-only dashboard RPCs...
      expect(bearers).toEqual([
        `Bearer ${CLI_TOKEN}`,
        `Bearer ${CLI_TOKEN}`,
        `Bearer ${CLI_TOKEN}`,
      ]);
      // ...and nothing more: it never reaches the report.
      expect(JSON.stringify(result)).not.toContain(CLI_TOKEN);
    });
  });

  it("reports the Keychain grant as the remedy instead of asking a CLI-signed-in user to sign in", async () => {
    writeCliConfig();
    mockProcess({ keychainToken: CLI_TOKEN });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await onDarwin(async () => {
      await seedCache();
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const { annotateQuotaAdvice } = await import("../../src/advice.js");
      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state.error).toBe("keychain_prompt_required");
      expect(result.state.error).not.toBe("Cursor sign-in required");
      expect(result.state.sourcesTried).toContain("cli-keychain");
      expect(fetchSpy).not.toHaveBeenCalled();

      const annotated = annotateQuotaAdvice({
        generatedAt: "2026-08-13T00:00:00.000Z",
        providers: [result],
      });
      expect(annotated.providers[0]?.state.reason).toBe(
        "keychain_access_required",
      );
      expect(annotated.providers[0]?.state.remedyCommand).toBe(
        "quota-axi --allow-keychain-prompt",
      );
      expect(JSON.stringify(annotated)).not.toContain(CLI_TOKEN);
    });
  });

  it("still reports sign-in required when neither Cursor store holds a credential", async () => {
    mockProcess({ keychainPresent: false });

    await onDarwin(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });

      expect(result.state.status).toBe("auth_required");
      expect(result.state.error).toBe("Cursor sign-in required");
    });
  });

  it("leaves the editor-credential fetch path unchanged", async () => {
    writeCliConfig();
    const { calls } = mockProcess({
      editorToken: EDITOR_TOKEN,
      keychainToken: CLI_TOKEN,
    });
    const { bearers } = mockUsageApi();

    await onDarwin(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });

      expect(result.state.status).toBe("fresh");
      expect(result.state.sourcesTried).toEqual(["api"]);
      expect(result.attempts).toEqual([{ source: "api", status: "success" }]);
      expect(result.account?.email).toBe("editor@example.invalid");
      expect(bearers).toEqual([
        `Bearer ${EDITOR_TOKEN}`,
        `Bearer ${EDITOR_TOKEN}`,
        `Bearer ${EDITOR_TOKEN}`,
      ]);
      // The non-prompting editor store answered, so the Keychain is left alone.
      expect(calls.some((call) => call[0] === "security")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(EDITOR_TOKEN);
    });
  });
});
