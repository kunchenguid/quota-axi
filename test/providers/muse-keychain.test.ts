import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderQuota } from "../../src/types.js";

// Synthetic. No real Muse credential, key, or account data appears in this tree.
const ACCESS_TOKEN = "synthetic-muse-keychain-access-token-411";
const REFRESH_TOKEN = "SENTINEL-MUSE-REFRESH-TOKEN-never-read";
const MINTED_API_KEY = "SENTINEL-MUSE-KEYCHAIN-API-KEY-must-never-appear";
const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const PROMPT_OPTIONS = { allowKeychainPrompt: true, refreshCredentials: false };

const KEY_RESPONSE = {
  api_key: "SENTINEL-MUSE-ISSUED-KEY-must-never-appear",
  email: "sentinel-muse-user@example.invalid",
  is_subs_active: true,
  subs_tier_name: "pro",
  subs_usage: {
    window: {
      used_percent: 42.5,
      window_duration_mins: 300,
      resets_at: 1781964000,
    },
    weekly: { used_percent: 17, resets_at: 1782216000 },
  },
};

const originalEnv = {
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
let directory: string;

beforeEach(() => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "quota-axi-muse-keychain-"));
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  // The Keychain source is macOS-only; pin the platform so the suite behaves
  // the same on Linux CI.
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  platformDescriptor = descriptor;
});

let platformDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  if (platformDescriptor)
    Object.defineProperty(process, "platform", platformDescriptor);
  platformDescriptor = undefined;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

type ExecCall = { command: string; args: string[] };

type KeychainMock = {
  /** The stored bundle value; undefined means the item is absent. */
  bundle?: unknown;
  /** Raw string returned instead of a JSON bundle. */
  rawSecret?: string;
  error?: Error & { code?: number; killed?: boolean };
};

/** Stands in for the `security` binary so every resolved query is inspectable. */
function mockSecurity(mock: KeychainMock): { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  vi.doMock("../../src/lib/process.js", () => ({
    execFileText: vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command !== "security") throw new Error(`unexpected ${command}`);
      if (mock.error) throw mock.error;
      if (mock.bundle === undefined && mock.rawSecret === undefined)
        throw Object.assign(new Error("not found"), { code: 44 });
      if (!args.includes("-w")) return "keychain item metadata\n";
      return `${mock.rawSecret ?? JSON.stringify(mock.bundle)}\n`;
    }),
  }));
  return { calls };
}

function bundle(refreshToken?: string): Record<string, unknown> {
  return {
    secret_schema_version: 1,
    access_token: ACCESS_TOKEN,
    api_key: MINTED_API_KEY,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

async function museModule() {
  return import("../../src/providers/muse.js");
}

async function keychainAdapter(
  mock: KeychainMock,
  fetchImpl?: unknown,
): Promise<{ adapter: ProviderAdapter; calls: ExecCall[] }> {
  const calls = mockSecurity(mock);
  const muse = await museModule();
  const adapter = muse.createMuseAdapter({
    sources: [muse.createMuseKeychainSource()],
    fetch: (fetchImpl ??
      sequentialFetch([jsonResponse(KEY_RESPONSE)])) as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    ledger: {
      recent: () => undefined,
      record: () => undefined,
      claim: () => ({ kind: "claimed" as const }),
    },
    now: () => NOW,
  });
  return { adapter, calls: calls.calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sequentialFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  });
}

describe("Muse Keychain credential source", () => {
  it("is absent off macOS without probing the Keychain", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const { adapter, calls } = await keychainAdapter({ bundle: bundle() });
      const report = await adapter.fetchQuota(PROMPT_OPTIONS);
      expect(report.state.status).toBe("auth_required");
      expect(calls).toEqual([]);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("checks presence without -w, and reads no value on a plain call", async () => {
    const fetchMock = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const { adapter, calls } = await keychainAdapter(
      { bundle: bundle() },
      fetchMock,
    );
    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("keychain_prompt_required");
    expect(report.attempts).toEqual([
      {
        source: "cli-keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).not.toContain("-w");
    expect(calls[0].args).toContain("ai.meta.dev.credentials");
    expect(calls[0].args).toContain("meta");
  });

  it("a prompt-blocked read is never reported as a sign-out", async () => {
    const { adapter } = await keychainAdapter({ bundle: bundle() });
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state.status).not.toBe("auth_required");
    expect(report.state.authStatus).toBeUndefined();
  });

  it("with --allow-keychain-prompt it resolves the bundle's access token and answers quota", async () => {
    const fetchMock = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const { adapter, calls } = await keychainAdapter(
      { bundle: bundle() },
      fetchMock,
    );
    const report = await adapter.fetchQuota(PROMPT_OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "weekly",
    ]);
    expect(calls.some((call) => call.args.includes("-w"))).toBe(true);
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("the bundle's minted API key never leaves the parse", async () => {
    const fetchMock = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const { adapter } = await keychainAdapter({ bundle: bundle() }, fetchMock);
    const report = await adapter.fetchQuota(PROMPT_OPTIONS);
    expect(JSON.stringify(report)).not.toContain(MINTED_API_KEY);
  });

  it("a recorded grant marker lets a plain call read the value", async () => {
    mockSecurity({ bundle: bundle() });
    const muse = await museModule();
    const { museKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const marker = museKeychainAccessMarkerPath(
      "ai.meta.dev.credentials",
      "meta",
    );
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "granted\n", { mode: 0o600 });

    const adapter = muse.createMuseAdapter({
      sources: [muse.createMuseKeychainSource()],
      fetch: sequentialFetch([jsonResponse(KEY_RESPONSE)]) as typeof fetch,
      readCachedProvider: () => undefined,
      deleteCachedProvider: () => undefined,
      ledger: {
        recent: () => undefined,
        record: () => undefined,
        claim: () => ({ kind: "claimed" as const }),
      },
      now: () => NOW,
    });
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state.status).toBe("fresh");
  });

  it("a missing item resolves absent, so a pointer-only auth.json still ends at sign-in required", async () => {
    const fetchMock = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const { adapter } = await keychainAdapter({}, fetchMock);
    const report = await adapter.fetchQuota(PROMPT_OPTIONS);
    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toBe("muse_credential_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a denied value read is a skipped read, not a sign-out", async () => {
    const { adapter } = await keychainAdapter({
      bundle: bundle(),
      error: Object.assign(new Error("denied"), { code: 128 }),
    });
    const report = await adapter.fetchQuota(PROMPT_OPTIONS);
    expect(report.state.error).toBe("keychain_access_denied");
    expect(report.state.status).toBe("error");
  });

  it("a timed-out prompt is a skipped read, not a sign-out", async () => {
    const { adapter } = await keychainAdapter({
      bundle: bundle(),
      error: Object.assign(new Error("killed"), { killed: true }),
    });
    const report = await adapter.fetchQuota(PROMPT_OPTIONS);
    expect(report.state.error).toBe("keychain_prompt_timeout");
    expect(report.state.status).toBe("error");
  });

  it("a non-JSON bundle is structurally invalid and never sent", async () => {
    const fetchMock = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const { adapter } = await keychainAdapter(
      { rawSecret: "not json" },
      fetchMock,
    );
    const report = await adapter.fetchQuota(PROMPT_OPTIONS);
    expect(report.state.status).toBe("error");
    expect(report.state.authStatus).toBeUndefined();
    expect(report.state.error).toBe("muse_keychain_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a bundle carrying a refresh token is soft expiry on a definitive 401", async () => {
    const fetchMock = sequentialFetch([new Response(null, { status: 401 })]);
    const { adapter } = await keychainAdapter(
      { bundle: bundle(REFRESH_TOKEN) },
      fetchMock,
    );
    const report = await adapter.fetchQuota(PROMPT_OPTIONS);
    expect(report.state.status).toBe("unavailable");
    expect(report.state.authStatus).toBe("expired_refreshable");
    expect(JSON.stringify(report)).not.toContain(REFRESH_TOKEN);
  });

  it("auth reports the Keychain source from presence alone, without a value read", async () => {
    const calls = mockSecurity({ bundle: bundle() });
    const muse = await museModule();
    const adapter = muse.createMuseAdapter({
      sources: [muse.createMuseKeychainSource()],
    });
    const report = await adapter.inspectAuth(OPTIONS);
    expect(report.sources).toEqual([
      {
        source: "cli-keychain",
        path: "Keychain ai.meta.dev.credentials",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
    ]);
    expect(calls.calls.every((call) => !call.args.includes("-w"))).toBe(true);
  });

  it("auth --allow-keychain-prompt reads the item and reports available", async () => {
    const calls = mockSecurity({ bundle: bundle() });
    const muse = await museModule();
    const adapter = muse.createMuseAdapter({
      sources: [muse.createMuseKeychainSource()],
    });
    const report = await adapter.inspectAuth(PROMPT_OPTIONS);
    expect(report.sources).toEqual([
      {
        source: "cli-keychain",
        path: "Keychain ai.meta.dev.credentials",
        status: "available",
      },
    ]);
    expect(calls.calls.some((call) => call.args.includes("-w"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(report)).not.toContain(MINTED_API_KEY);
  });

  it("auth does not fetch the bundle from a leftover grant marker", async () => {
    const calls = mockSecurity({ bundle: bundle() });
    const muse = await museModule();
    const { museKeychainAccessMarkerPath } =
      await import("../../src/lib/fs.js");
    const marker = museKeychainAccessMarkerPath(
      "ai.meta.dev.credentials",
      "meta",
    );
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "granted\n", { mode: 0o600 });
    const adapter = muse.createMuseAdapter({
      sources: [muse.createMuseKeychainSource()],
    });
    const report = await adapter.inspectAuth(OPTIONS);
    expect(report.sources[0]).toMatchObject({
      source: "cli-keychain",
      status: "skipped",
      error: "keychain_prompt_required",
    });
    expect(calls.calls.every((call) => !call.args.includes("-w"))).toBe(true);
  });

  it("a prompt-blocked Keychain read is not a sign-out when META_API_KEY is rejected", async () => {
    const fetchMock = sequentialFetch([new Response(null, { status: 401 })]);
    const deleteCachedProvider = vi.fn();
    mockSecurity({ bundle: bundle() });
    const muse = await museModule();
    const store = join(directory, "auth.json");
    writeFileSync(
      store,
      JSON.stringify({
        schema_version: 2,
        providers: { meta: { mechanism: "oauth", storage: "keychain" } },
      }),
    );
    const adapter = muse.createMuseAdapter({
      sources: [
        muse.createMuseAuthFileSource(() => store),
        muse.createMuseKeychainSource(),
        muse.createMuseApiKeySource({
          META_API_KEY: "synthetic-meta-api-key",
        }),
      ],
      fetch: fetchMock as typeof fetch,
      readCachedProvider: () => undefined,
      deleteCachedProvider,
      ledger: {
        recent: () => undefined,
        record: () => undefined,
        claim: () => ({ kind: "claimed" as const }),
      },
      now: () => NOW,
    });
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state.status).not.toBe("auth_required");
    expect(report.state.authStatus).not.toBe("unusable");
    expect(report.state.error).toBe("keychain_prompt_required");
    expect(deleteCachedProvider).not.toHaveBeenCalled();
  });

  it("a prompt-blocked Muse report earns the keychain advice", async () => {
    mockSecurity({ bundle: bundle() });
    const muse = await museModule();
    const store = join(directory, "auth.json");
    writeFileSync(
      store,
      JSON.stringify({
        schema_version: 2,
        providers: { meta: { mechanism: "oauth", storage: "keychain" } },
      }),
    );
    const adapter = muse.createMuseAdapter({
      sources: [
        muse.createMuseAuthFileSource(() => store),
        muse.createMuseKeychainSource(),
        muse.createMuseApiKeySource({}),
      ],
    });
    const report = await adapter.fetchQuota(OPTIONS);
    const { annotateQuotaAdvice } = await import("../../src/advice.js");
    const annotated = annotateQuotaAdvice({
      providers: [report as ProviderQuota],
      generatedAt: new Date(NOW).toISOString(),
    } as never);
    const advised = annotated.providers[0];
    expect(advised.state.reason).toBe("keychain_access_required");
    expect(advised.state.remedyCommand).toBe(
      "quota-axi --allow-keychain-prompt",
    );
  });
});

describe("Muse auth.json keychain pointer", () => {
  it("storage keychain without a token resolves the file absent so the Keychain source owns it", async () => {
    const muse = await museModule();
    mockSecurity({ bundle: bundle() });
    const store = join(directory, "auth.json");
    writeFileSync(
      store,
      JSON.stringify({
        schema_version: 2,
        providers: {
          meta: {
            mechanism: "oauth",
            obtained_via: "device_code",
            storage: "keychain",
          },
        },
      }),
    );
    const fileSource = muse.createMuseAuthFileSource(() => store);
    const resolution = await fileSource.resolve(OPTIONS);
    expect(resolution.status).toBe("absent");
  });

  it("storage file without a token stays structurally invalid", async () => {
    const muse = await museModule();
    const store = join(directory, "auth.json");
    writeFileSync(
      store,
      JSON.stringify({
        providers: { meta: { mechanism: "oauth", storage: "file" } },
      }),
    );
    const resolution = await muse
      .createMuseAuthFileSource(() => store)
      .resolve(OPTIONS);
    expect(resolution).toEqual({
      status: "structurally_invalid",
      error: "muse_access_token_invalid",
    });
  });
});
