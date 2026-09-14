import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EDITOR_TOKEN = "cursor-editor-token-fixture";
const CLI_TOKEN = "cursor-cli-token-fixture";
const PI_TOKEN = "cursor-pi-token-fixture";
const PI_REFRESH = "cursor-pi-refresh-must-stay-private";

const originalEnv = {
  CURSOR_STATE_DB: process.env.CURSOR_STATE_DB,
  CURSOR_CLI_CONFIG: process.env.CURSOR_CLI_CONFIG,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};

let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cursor-pi-"));
  process.env.CURSOR_STATE_DB = join(tempDir, "state.vscdb");
  process.env.CURSOR_CLI_CONFIG = join(tempDir, "cursor-cli.json");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
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

type ProcessState = {
  editorToken?: string;
  editorError?: string;
};

function mockProcess(state: ProcessState): { calls: string[][] } {
  const calls: string[][] = [];
  vi.doMock("../../src/lib/process.js", () => ({
    commandExists: vi.fn(async () => true),
    execFileText: vi.fn(async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command !== "sqlite3") {
        throw new Error(`unexpected process: ${command}`);
      }
      if (state.editorError) throw new Error(state.editorError);
      if (!state.editorToken) throw new Error("unable to open database file");
      const query = args.at(-1) ?? "";
      if (query.includes("cursorAuth/accessToken")) {
        return JSON.stringify(state.editorToken);
      }
      if (query.includes("cursorAuth/cachedEmail")) {
        return '"editor@example.invalid"';
      }
      return "";
    }),
  }));
  return { calls };
}

type TokenBehavior = {
  usageStatus?: number;
  accountId?: string;
  percentUsed?: number;
};

function stubCursorApi(byToken: Record<string, TokenBehavior>): {
  bearers: string[];
  urls: string[];
} {
  const bearers: string[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      const token = bearer.replace(/^Bearer /, "");
      const behavior = byToken[token] ?? {};
      bearers.push(bearer);
      urls.push(url);
      if (url.endsWith("/auth/full_stripe_profile")) {
        return new Response(
          JSON.stringify(
            behavior.accountId ? { customerId: behavior.accountId } : {},
          ),
          { status: 200 },
        );
      }
      if (url.includes("GetCurrentPeriodUsage")) {
        const status = behavior.usageStatus ?? 200;
        return new Response(
          status === 200
            ? JSON.stringify({
                billingCycleStart: "2026-09-01T00:00:00.000Z",
                billingCycleEnd: "2026-10-01T00:00:00.000Z",
                planUsage: {
                  totalPercentUsed: behavior.percentUsed ?? 23,
                },
              })
            : "{}",
          { status },
        );
      }
      if (url.includes("GetPlanInfo")) {
        return new Response(
          JSON.stringify({ planInfo: { planName: "ultra" } }),
          { status: 200 },
        );
      }
      if (url.includes("GetSandUsageStatus")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }),
  );
  return { bearers, urls };
}

function writePiCredential(
  entry: Record<string, unknown> = { type: "api_key", key: PI_TOKEN },
): void {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
    JSON.stringify({ cursor: entry }),
    { mode: 0o600 },
  );
}

function writeCliCredential(): void {
  writeFileSync(
    process.env.CURSOR_CLI_CONFIG!,
    JSON.stringify({
      accessToken: CLI_TOKEN,
      refreshToken: "cli-refresh-must-not-be-read",
    }),
  );
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

const options = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};

describe("Cursor Pi credential source", () => {
  it("keeps editor then CLI then Pi as the fixed source order", async () => {
    writePiCredential();
    writeCliCredential();
    mockProcess({ editorToken: EDITOR_TOKEN });
    const api = stubCursorApi({
      [EDITOR_TOKEN]: { accountId: "acct-editor" },
      [CLI_TOKEN]: { accountId: "acct-cli" },
      [PI_TOKEN]: { accountId: "acct-pi" },
    });

    await onLinux(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota(options);

      expect(result.attempts).toEqual([{ source: "api", status: "success" }]);
      expect(api.bearers).toHaveLength(4);
      expect(api.bearers).toEqual(Array(4).fill(`Bearer ${EDITOR_TOKEN}`));
      expect(result.account).toMatchObject({
        accountId: "acct-editor",
        identityStatus: "verified",
      });
    });
  });

  it("uses CLI before Pi when the editor source is absent", async () => {
    writePiCredential();
    writeCliCredential();
    mockProcess({});
    const api = stubCursorApi({
      [CLI_TOKEN]: { accountId: "acct-cli" },
      [PI_TOKEN]: { accountId: "acct-pi" },
    });

    await onLinux(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota(options);

      expect(result.state.sourcesTried).toEqual([
        "state-vscdb",
        "cli-authfile",
      ]);
      expect(result.attempts?.at(-1)).toEqual({
        source: "cli-authfile",
        status: "success",
      });
      expect(api.bearers).toEqual(Array(4).fill(`Bearer ${CLI_TOKEN}`));
    });
  });

  it("refreshes Cursor Ultra quota from Pi after editor and CLI absence", async () => {
    writePiCredential();
    const processMock = mockProcess({});
    const api = stubCursorApi({
      [PI_TOKEN]: { accountId: "acct-ultra", percentUsed: 37 },
    });

    await onLinux(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota(options);

      expect(result.state.status).toBe("fresh");
      expect(result.plan).toBe("ultra");
      expect(result.windows).toMatchObject([
        { id: "included_usage", percentUsed: 37, percentRemaining: 63 },
      ]);
      expect(result.account).toMatchObject({
        accountId: "acct-ultra",
        identityStatus: "verified",
      });
      expect(result.state.sourcesTried).toEqual([
        "state-vscdb",
        "cli-authfile",
        "pi:cursor",
      ]);
      expect(result.attempts?.at(-1)).toEqual({
        source: "pi:cursor",
        status: "success",
      });
      expect(api.bearers).toEqual(Array(4).fill(`Bearer ${PI_TOKEN}`));
      expect(
        api.urls.every((url) => url.startsWith("https://api2.cursor.sh/")),
      ).toBe(true);
      expect(processMock.calls.every((call) => call[0] === "sqlite3")).toBe(
        true,
      );
      expect(JSON.stringify(result)).not.toContain(PI_TOKEN);
    });
  });

  it("hands over definitive source rejection and preserves degraded evidence", async () => {
    writePiCredential();
    mockProcess({ editorToken: EDITOR_TOKEN });
    stubCursorApi({
      [EDITOR_TOKEN]: { usageStatus: 401, accountId: "acct-ultra" },
      [PI_TOKEN]: { accountId: "acct-ultra", percentUsed: 31 },
    });

    await onLinux(async () => {
      const { withQuotaSemantics } =
        await import("../../src/interpretation.js");
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = withQuotaSemantics(
        await fetchQuota(options),
        "2026-09-15T00:00:00.000Z",
      );

      expect(result.state.status).toBe("fresh");
      expect(result.attempts).toEqual([
        {
          source: "state-vscdb",
          status: "failed",
          error: "Cursor sign-in required",
        },
        {
          source: "cli-authfile",
          status: "skipped",
          error: "credentials_missing",
        },
        { source: "pi:cursor", status: "success" },
      ]);
      expect(result.state.degradedSources).toEqual([
        { source: "state-vscdb", error: "Cursor sign-in required" },
      ]);
    });
  });

  it("probes stored-expired Pi OAuth and keeps soft expiry distinct after rejection", async () => {
    writePiCredential({
      type: "oauth",
      access: PI_TOKEN,
      refresh: PI_REFRESH,
      expires: Date.now() - 1,
    });
    mockProcess({});
    const api = stubCursorApi({
      [PI_TOKEN]: { usageStatus: 401, accountId: "acct-ultra" },
    });

    await onLinux(async () => {
      const { fetchQuota, inspectAuth } =
        await import("../../src/providers/cursor.js");
      const auth = await inspectAuth(options);
      const result = await fetchQuota(options);

      expect(auth.sources.at(-1)).toMatchObject({
        source: "pi:cursor",
        status: "expired",
        error: "credentials_expired_refreshable",
        credentialPresent: true,
      });
      expect(api.bearers).toContain(`Bearer ${PI_TOKEN}`);
      expect(result.state).toMatchObject({
        status: "auth_required",
        authStatus: "expired_refreshable",
        reason: "credentials_expired",
      });
      expect(result.state.error).toBe("Cursor Pi access token expired");
      expect(JSON.stringify({ auth, result })).not.toContain(PI_TOKEN);
      expect(JSON.stringify({ auth, result })).not.toContain(PI_REFRESH);
    });
  });

  it("does not switch to Pi on non-definitive network, policy, or server failures", async () => {
    writePiCredential();
    mockProcess({ editorToken: EDITOR_TOKEN });
    const api = stubCursorApi({
      [EDITOR_TOKEN]: { usageStatus: 500, accountId: "acct-editor" },
      [PI_TOKEN]: { accountId: "acct-pi" },
    });

    await onLinux(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota(options);

      expect(result.state.status).toBe("error");
      expect(result.state.status).not.toBe("auth_required");
      expect(result.state.error).toBe("Cursor quota unavailable (500)");
      expect(api.bearers).toEqual(Array(4).fill(`Bearer ${EDITOR_TOKEN}`));
      expect(result.state.sourcesTried).toEqual(["api"]);
    });
  });

  it("redacts a credential even when a transport error echoes it", async () => {
    writePiCredential();
    mockProcess({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`synthetic transport failure: ${PI_TOKEN}`);
      }),
    );

    await onLinux(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const result = await fetchQuota(options);

      expect(result.state.status).toBe("error");
      expect(result.state.error).toContain("[redacted]");
      expect(JSON.stringify(result)).not.toContain(PI_TOKEN);
      expect(JSON.stringify(result)).not.toContain(PI_REFRESH);
    });
  });

  it("reports malformed Pi auth as present without sending or launching anything", async () => {
    writePiCredential({ type: "api_key", key: "$CURSOR_TOKEN" });
    const processMock = mockProcess({});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await onLinux(async () => {
      const { fetchQuota, inspectAuth } =
        await import("../../src/providers/cursor.js");
      const auth = await inspectAuth(options);
      const result = await fetchQuota(options);

      expect(auth.sources.at(-1)).toMatchObject({
        source: "pi:cursor",
        status: "invalid",
        error: "invalid_credential",
        credentialPresent: true,
      });
      expect(result.attempts?.at(-1)).toEqual({
        source: "pi:cursor",
        status: "skipped",
        error: "invalid_credential",
        credentialPresent: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(processMock.calls.every((call) => call[0] === "sqlite3")).toBe(
        true,
      );
    });
  });

  it("reuses stale quota only with matching remote account evidence across sources", async () => {
    writePiCredential();
    const processState: ProcessState = { editorToken: EDITOR_TOKEN };
    mockProcess(processState);
    const behavior: Record<string, TokenBehavior> = {
      [EDITOR_TOKEN]: {
        accountId: "acct-same",
        percentUsed: 44,
      },
      [PI_TOKEN]: {
        accountId: "acct-same",
        percentUsed: 22,
      },
    };
    stubCursorApi(behavior);

    await onLinux(async () => {
      const { fetchQuota } = await import("../../src/providers/cursor.js");
      const { writeCachedProviders } = await import("../../src/cache.js");
      const { cacheFilePath } = await import("../../src/lib/fs.js");
      const fresh = await fetchQuota(options);
      writeCachedProviders([fresh]);
      expect(fresh.windows[0]?.percentUsed).toBe(44);
      const cacheBytes = readFileSync(cacheFilePath(), "utf8");
      expect(cacheBytes).not.toContain(EDITOR_TOKEN);
      expect(cacheBytes).not.toContain(PI_TOKEN);
      expect(cacheBytes).not.toContain(PI_REFRESH);

      processState.editorToken = undefined;
      behavior[PI_TOKEN].usageStatus = 500;
      const sameAccount = await fetchQuota(options);
      expect(sameAccount.state.status).toBe("stale");
      expect(sameAccount.windows[0]?.percentUsed).toBe(44);
      expect(sameAccount.state.sourcesTried).toContain("cache");

      behavior[PI_TOKEN].accountId = "acct-different";
      const differentAccount = await fetchQuota(options);
      expect(differentAccount.state.status).toBe("error");
      expect(differentAccount.state.stale).toBe(false);
      expect(differentAccount.windows).toEqual([]);
      expect(differentAccount.state.sourcesTried).not.toContain("cache");

      // An earlier source's verified identity must not leak across a later
      // source attempt whose account cannot be verified.
      processState.editorToken = EDITOR_TOKEN;
      behavior[EDITOR_TOKEN]!.usageStatus = 401;
      behavior[PI_TOKEN]!.accountId = undefined;
      const unverifiedAfterHandover = await fetchQuota(options);
      expect(unverifiedAfterHandover.state.status).toBe("error");
      expect(unverifiedAfterHandover.state.stale).toBe(false);
      expect(unverifiedAfterHandover.state.sourcesTried).not.toContain("cache");
    });
  });
});
