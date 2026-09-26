import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { annotateQuotaAdvice } from "../../src/advice.js";
import type { ProviderQuota } from "../../src/types.js";

// Never a real credential: the suite must never depend on live Cursor auth.
const FAKE_KEYCHAIN_SECRET = "fake-cursor-cli-secret";
const CLI_CONFIG = {
  version: 1,
  authInfo: {
    email: "person@example.invalid",
    displayName: "Person",
    userId: "user_abc123",
    authId: "auth_abc123",
  },
};

const originalEnv = {
  CURSOR_STATE_DB: process.env.CURSOR_STATE_DB,
  CURSOR_CLI_CONFIG: process.env.CURSOR_CLI_CONFIG,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
let tempDir: string | undefined;
let cliConfigPath: string;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cursor-cli-"));
  cliConfigPath = join(tempDir, "cli-config.json");
  process.env.CURSOR_STATE_DB = join(tempDir, "state.vscdb");
  process.env.CURSOR_CLI_CONFIG = cliConfigPath;
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
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function withPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

function writeCliConfig(value: unknown = CLI_CONFIG): void {
  writeFileSync(cliConfigPath, JSON.stringify(value));
}

function writeLinuxAuthFile(accessToken = "linux-auth-token"): void {
  writeFileSync(
    cliConfigPath,
    JSON.stringify({ accessToken, refreshToken: "must-never-be-used" }),
  );
}

type ExecCall = { command: string; args: string[] };

/**
 * Stands in for both `sqlite3` (Cursor editor store) and `security` (Cursor CLI
 * keychain store) so every resolved service/account is inspectable.
 */
function mockProcess(options: {
  editorToken?: string;
  sqliteAvailable?: boolean;
  sqliteError?: Error;
  keychainSecret?: string;
  keychainError?: Error & { code?: number; killed?: boolean };
}): { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  vi.doMock("../../src/lib/process.js", () => ({
    commandExists: vi.fn(
      async (command: string) =>
        command !== "sqlite3" || options.sqliteAvailable !== false,
    ),
    execFileText: vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "sqlite3") {
        if (options.sqliteError) throw options.sqliteError;
        const query = args.at(-1) ?? "";
        if (options.editorToken && query.includes("cursorAuth/accessToken"))
          return JSON.stringify(options.editorToken);
        if (options.editorToken && query.includes("cursorAuth/cachedEmail"))
          return '"editor@example.invalid"';
        return "";
      }
      if (command === "security") {
        if (options.keychainError) throw options.keychainError;
        if (!args.includes("-w")) return "keychain item metadata\n";
        return `${options.keychainSecret ?? FAKE_KEYCHAIN_SECRET}\n`;
      }
      throw new Error(`unexpected command ${command}`);
    }),
  }));
  return { calls };
}

function securityCalls(calls: ExecCall[]): ExecCall[] {
  return calls.filter((call) => call.command === "security");
}

function stubCursorUsage(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).includes("GetPlanInfo")) {
      return new Response(JSON.stringify({ planInfo: { planName: "pro" } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        billingCycleEnd: "1783036800000",
        planUsage: { totalPercentUsed: 12 },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubEditorUsageFailure(status: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    if (
      authorization === "Bearer editor-token" &&
      String(url).includes("GetCurrentPeriodUsage")
    ) {
      return new Response("{}", {
        status,
        headers: status === 429 ? { "retry-after": "60" } : undefined,
      });
    }
    if (String(url).includes("GetPlanInfo")) {
      return new Response(JSON.stringify({ planInfo: { planName: "pro" } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        billingCycleEnd: "1783036800000",
        planUsage: { totalPercentUsed: 12 },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Cursor CLI keychain credential source", () => {
  it("resolves CLI-only sign-in from the cursor-access-token keychain item", async () => {
    writeCliConfig();
    const { calls } = mockProcess({});
    const fetchMock = stubCursorUsage();

    const result = await withPlatform("darwin", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      return fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result.state.status).toBe("fresh");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(securityCalls(calls)).toEqual([
      {
        command: "security",
        args: [
          "find-generic-password",
          "-a",
          "cursor-user",
          "-w",
          "-s",
          "cursor-access-token",
        ],
      },
    ]);
    expect(
      new Headers(
        (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
      ).get("authorization"),
    ).toBe(`Bearer ${FAKE_KEYCHAIN_SECRET}`);
  });

  it("never surfaces the keychain secret in the report", async () => {
    writeCliConfig();
    mockProcess({});
    stubCursorUsage();

    const { report, auth } = await withPlatform("darwin", async () => {
      const { fetchQuota, inspectAuth } =
        await import("../../src/providers/cursor.js");
      return {
        report: await fetchQuota({
          allowKeychainPrompt: true,
          refreshCredentials: false,
        }),
        auth: await inspectAuth({
          allowKeychainPrompt: true,
          refreshCredentials: false,
        }),
      };
    });

    expect(JSON.stringify(report)).not.toContain(FAKE_KEYCHAIN_SECRET);
    expect(JSON.stringify(auth)).not.toContain(FAKE_KEYCHAIN_SECRET);
    expect(auth.sources).toContainEqual({
      source: "cli-keychain",
      path: cliConfigPath,
      status: "available",
      credentialPresent: true,
    });
  });

  it("skips the value read without the keychain prompt opt-in", async () => {
    writeCliConfig();
    const { calls } = mockProcess({});

    const result = await withPlatform("darwin", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      return fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });
    });

    expect(securityCalls(calls)).toEqual([
      {
        command: "security",
        args: [
          "find-generic-password",
          "-a",
          "cursor-user",
          "-s",
          "cursor-access-token",
        ],
      },
    ]);
    expect(result.attempts).toContainEqual({
      source: "cli-keychain",
      status: "skipped",
      error: "keychain_prompt_required",
      credentialPresent: true,
    });
    expect(result.state.status).toBe("auth_required");
  });

  it.each([
    ["sqlite3 is unavailable", { sqliteAvailable: false }],
    ["the editor database read fails", { sqliteError: new Error("locked") }],
  ])(
    "advises the one-time keychain grant when %s",
    async (_scenario, processOptions) => {
      writeCliConfig();
      mockProcess(processOptions);

      const result = await withPlatform("darwin", async () => {
        const { fetchQuota } = await import("../../src/providers/cursor.js");
        return fetchQuota({
          allowKeychainPrompt: false,
          refreshCredentials: false,
        });
      });
      const annotated = annotateQuotaAdvice({
        generatedAt: new Date().toISOString(),
        providers: [result as ProviderQuota],
      });

      expect(annotated.providers[0]?.state.reason).toBe(
        "keychain_access_required",
      );
      expect(annotated.providers[0]?.state.remedyCommand).toBe(
        "quota-axi --allow-keychain-prompt",
      );
      expect(annotated.help?.[0]).toContain("Always Allow");
      expect(JSON.stringify(annotated)).not.toContain(FAKE_KEYCHAIN_SECRET);
    },
  );

  it("reuses a recorded grant on a later plain call", async () => {
    writeCliConfig();
    mockProcess({});
    stubCursorUsage();

    const granted = await withPlatform("darwin", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      return fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });
    expect(granted.state.status).toBe("fresh");

    vi.resetModules();
    const { calls } = mockProcess({});
    stubCursorUsage();
    const plain = await withPlatform("darwin", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      return fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });
    });

    expect(plain.state.status).toBe("fresh");
    expect(securityCalls(calls)[0]?.args).toContain("-w");
  });

  it("does not touch the keychain when no CLI sign-in is recorded", async () => {
    const { calls } = mockProcess({});

    const result = await withPlatform("darwin", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      return fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(securityCalls(calls)).toEqual([]);
    expect(result.attempts).toContainEqual({
      source: "cli-keychain",
      status: "skipped",
      error: "credentials_missing",
    });
  });

  it("reports a signed-in CLI user whose keychain item is gone as missing", async () => {
    writeCliConfig();
    const notFound = Object.assign(new Error("could not be found"), {
      code: 44,
    });
    mockProcess({ keychainError: notFound });

    const result = await withPlatform("darwin", async () => {
      const { inspectAuth } = await import("../../src/providers/cursor.js");
      return inspectAuth({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result.sources).toContainEqual({
      source: "cli-keychain",
      path: cliConfigPath,
      status: "missing",
    });
  });

  it("reports a denied keychain read as skipped rather than signed out", async () => {
    writeCliConfig();
    mockProcess({
      keychainError: Object.assign(
        new Error("User interaction is not allowed"),
        {
          code: 51,
        },
      ),
    });

    const result = await withPlatform("darwin", async () => {
      const { inspectAuth } = await import("../../src/providers/cursor.js");
      return inspectAuth({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result.sources).toContainEqual({
      source: "cli-keychain",
      path: cliConfigPath,
      status: "skipped",
      error: "keychain_access_denied",
      credentialPresent: true,
    });
  });

  it("reports an unreadable cli-config as invalid", async () => {
    writeFileSync(cliConfigPath, "{not json");
    const { calls } = mockProcess({});

    const result = await withPlatform("darwin", async () => {
      const { inspectAuth } = await import("../../src/providers/cursor.js");
      return inspectAuth({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(securityCalls(calls)).toEqual([]);
    expect(result.sources).toContainEqual({
      source: "cli-keychain",
      path: cliConfigPath,
      status: "invalid",
      error: "json_parse_error",
      credentialPresent: true,
    });
  });

  it("reads only the Linux auth-file access token", async () => {
    writeLinuxAuthFile();

    const result = await withPlatform("linux", async () => {
      const { readCursorCliCredentialState } =
        await import("../../src/providers/cursor-cli-credential.js");
      return readCursorCliCredentialState({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result).toEqual({
      status: "available",
      accessToken: "linux-auth-token",
      identity: {},
      source: {
        source: "cli-authfile",
        path: cliConfigPath,
        status: "available",
        credentialPresent: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-never-be-used");
  });

  it("resolves the Linux auth file below XDG config home", async () => {
    delete process.env.CURSOR_CLI_CONFIG;
    const xdgConfigHome = join(tempDir!, "xdg-config");
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    const authPath = join(xdgConfigHome, "cursor", "auth.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(xdgConfigHome, "cursor"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ accessToken: "xdg-token" }));

    const result = await withPlatform("linux", async () => {
      const { readCursorCliCredentialState } =
        await import("../../src/providers/cursor-cli-credential.js");
      return readCursorCliCredentialState({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });
    });

    expect(result.source).toEqual({
      source: "cli-authfile",
      path: authPath,
      status: "available",
      credentialPresent: true,
    });
    expect(result.status).toBe("available");
  });

  it("reports the Linux auth-file source when its JSON is malformed", async () => {
    writeFileSync(cliConfigPath, "{not json");

    const result = await withPlatform("linux", async () => {
      const { readCursorCliCredentialState } =
        await import("../../src/providers/cursor-cli-credential.js");
      return readCursorCliCredentialState({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result).toEqual({
      status: "invalid",
      source: {
        source: "cli-authfile",
        path: cliConfigPath,
        status: "invalid",
        error: "json_parse_error",
        credentialPresent: true,
      },
    });
  });

  it("reports the Linux auth-file source when its token is missing", async () => {
    writeCliConfig();
    const { calls } = mockProcess({});

    const result = await withPlatform("linux", async () => {
      const { inspectAuth } = await import("../../src/providers/cursor.js");
      return inspectAuth({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result.sources.map((source) => source.source)).toEqual([
      "state-vscdb",
      "cli-authfile",
    ]);
    expect(result.sources[1]).toEqual({
      source: "cli-authfile",
      path: cliConfigPath,
      status: "missing",
    });
    expect(securityCalls(calls)).toEqual([]);
  });
});

describe("Cursor editor state.vscdb source (regression)", () => {
  it("inspects CLI auth without a value read when editor auth is available", async () => {
    writeCliConfig();
    const { calls } = mockProcess({ editorToken: "editor-token" });

    const result = await withPlatform("darwin", async () => {
      const { readCursorCliCredentialState } =
        await import("../../src/providers/cursor-cli-credential.js");
      await readCursorCliCredentialState({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
      calls.length = 0;

      const { inspectAuth } = await import("../../src/providers/cursor.js");
      return inspectAuth({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result.sources).toEqual([
      {
        source: "state-vscdb",
        path: process.env.CURSOR_STATE_DB,
        status: "available",
      },
      {
        source: "cli-keychain",
        path: cliConfigPath,
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
    ]);
    expect(securityCalls(calls)).toEqual([
      {
        command: "security",
        args: [
          "find-generic-password",
          "-a",
          "cursor-user",
          "-s",
          "cursor-access-token",
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEYCHAIN_SECRET);
  });

  it.each([401, 403])(
    "falls back to CLI auth after editor auth receives %i",
    async (status) => {
      writeCliConfig();
      const { calls } = mockProcess({ editorToken: "editor-token" });
      stubEditorUsageFailure(status);

      const result = await withPlatform("darwin", async () => {
        const { fetchQuota } = await import("../../src/providers/cursor.js");
        return fetchQuota({
          allowKeychainPrompt: true,
          refreshCredentials: false,
        });
      });

      expect(result.state.status).toBe("fresh");
      expect(result.account?.email).toBe("person@example.invalid");
      expect(result.attempts).toEqual([
        {
          source: "state-vscdb",
          status: "failed",
          error: "Cursor sign-in required",
        },
        { source: "cli-keychain", status: "success" },
      ]);
      const annotated = annotateQuotaAdvice({
        generatedAt: new Date().toISOString(),
        providers: [result],
      });
      expect(annotated.providers[0]?.state.reason).toBeUndefined();
      expect(annotated.help).toBeUndefined();
      expect(securityCalls(calls)).toHaveLength(1);
      expect(securityCalls(calls)[0]?.args).toContain("-w");
      expect(JSON.stringify(result)).not.toContain(FAKE_KEYCHAIN_SECRET);
    },
  );

  it.each([401, 403])(
    "advises a keychain grant after editor auth receives %i",
    async (status) => {
      writeCliConfig();
      const { calls } = mockProcess({ editorToken: "editor-token" });
      stubEditorUsageFailure(status);

      const result = await withPlatform("darwin", async () => {
        const { fetchQuota } = await import("../../src/providers/cursor.js");
        return fetchQuota({
          allowKeychainPrompt: false,
          refreshCredentials: false,
        });
      });
      const annotated = annotateQuotaAdvice({
        generatedAt: new Date().toISOString(),
        providers: [result],
      });

      expect(result.attempts).toEqual([
        {
          source: "state-vscdb",
          status: "failed",
          error: "Cursor sign-in required",
        },
        {
          source: "cli-keychain",
          status: "skipped",
          error: "keychain_prompt_required",
          credentialPresent: true,
        },
      ]);
      expect(annotated.providers[0]?.state.reason).toBe(
        "keychain_access_required",
      );
      expect(annotated.providers[0]?.state.remedyCommand).toBe(
        "quota-axi --allow-keychain-prompt",
      );
      expect(annotated.help?.[0]).toContain("Always Allow");
      expect(securityCalls(calls)[0]?.args).not.toContain("-w");
      expect(JSON.stringify(annotated)).not.toContain(FAKE_KEYCHAIN_SECRET);
    },
  );

  it.each([429, 500])(
    "does not consult CLI auth after editor usage receives %i",
    async (status) => {
      writeCliConfig();
      const { calls } = mockProcess({ editorToken: "editor-token" });
      stubEditorUsageFailure(status);

      const result = await withPlatform("darwin", async () => {
        const { fetchQuota } = await import("../../src/providers/cursor.js");
        return fetchQuota({
          allowKeychainPrompt: true,
          refreshCredentials: false,
        });
      });

      expect(result.state.status).toBe(
        status === 429 ? "rate_limited" : "error",
      );
      expect(securityCalls(calls)).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(FAKE_KEYCHAIN_SECRET);
    },
  );

  it("still resolves editor auth without consulting the keychain", async () => {
    writeCliConfig();
    const { calls } = mockProcess({ editorToken: "editor-token" });
    const fetchMock = stubCursorUsage();

    const result = await withPlatform("darwin", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      return fetchQuota({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });
    });

    expect(result.state.status).toBe("fresh");
    expect(result.account?.email).toBe("editor@example.invalid");
    expect(
      new Headers(
        (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
      ).get("authorization"),
    ).toBe("Bearer editor-token");
    expect(securityCalls(calls)).toEqual([]);
    expect(result.attempts).toEqual([{ source: "api", status: "success" }]);
  });

  it("keeps reporting a signed-out editor with no CLI sign-in as auth required", async () => {
    const { calls } = mockProcess({});

    const result = await withPlatform("darwin", async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      return fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });
    });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Cursor sign-in required");
    expect(result.attempts?.[0]).toEqual({
      source: "state-vscdb",
      status: "skipped",
      error: "credentials_missing",
    });
    expect(securityCalls(calls)).toEqual([]);
  });
});
