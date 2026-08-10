import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import {
  OVERRIDE_REJECTED_ERROR,
  OVERRIDE_SOURCE,
} from "../../src/providers/common.js";
import { createGrokAdapter } from "../../src/providers/grok.js";
import { createKimiAdapter } from "../../src/providers/kimi.js";
import { renderQuotaToon } from "../../src/render.js";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderOptions,
  ProviderQuota,
} from "../../src/types.js";

/**
 * Contract tests for the uniform credential override: when an override entry
 * exists for a provider, the adapter uses ONLY that credential (no local
 * source, no CLI fallback, no stale-cache answer), attributes the flight as
 * `source: "override"`, never writes the result to the quota cache, and
 * surfaces a definitive 401/403 as `auth_required` / `override_rejected`.
 * Token bytes must never appear in any output.
 */

const OVERRIDE_TOKENS: Record<ProviderId, string> = {
  claude: "synthetic-override-claude-a1b2c3",
  codex: "synthetic-override-codex-d4e5f6",
  cursor: "synthetic-override-cursor-a7b8c9",
  copilot: "synthetic-override-copilot-d1e2f3",
  grok: "synthetic-override-grok-a4b5c6",
  kimi: "synthetic-override-kimi-d7e8f9",
};
const LOCAL_DECOY = "synthetic-local-decoy-token-must-not-be-used";

const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "QUOTA_AXI_CODEX_BINARY",
  "CURSOR_STATE_DB",
  "GITHUB_COPILOT_APPS_JSON",
  "GROK_AUTH_JSON",
  "GROK_AUTH_PATH",
  "GROK_AUTH",
  "GROK_HOME",
  "PI_CODING_AGENT_DIR",
  "KIMI_CODE_HOME",
  "XDG_CACHE_HOME",
  "QUOTA_AXI_CREDENTIALS_FILE",
] as const;
const savedEnv = new Map<string, string | undefined>();
let tempDir: string | undefined;

beforeEach(() => {
  vaultEnv();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-flight-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, "claude-home");
  process.env.CODEX_HOME = join(tempDir, "codex-home");
  process.env.CURSOR_STATE_DB = join(tempDir, "cursor-state", "state.vscdb");
  process.env.GITHUB_COPILOT_APPS_JSON = join(tempDir, "copilot", "apps.json");
  process.env.GROK_AUTH_JSON = join(tempDir, "grok", "auth.json");
  process.env.GROK_HOME = join(tempDir, "grok-home");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  process.env.KIMI_CODE_HOME = join(tempDir, "kimi-code-home");
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreEnv();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
});

function vaultEnv(): void {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function overridesFor(provider: ProviderId): ProviderOptions {
  return {
    allowKeychainPrompt: false,
    credentialOverrides: {
      [provider]: { kind: "bearer", token: OVERRIDE_TOKENS[provider] },
    },
  };
}

function writeJson(file: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value), { mode });
  chmodSync(file, mode);
}

/** A fetch double that records the bearer token seen on each request. */
function recordingFetch(
  respond: (url: string, init?: RequestInit) => Response,
): { fetchImpl: typeof globalThis.fetch; seen: (string | null)[] } {
  const seen: (string | null)[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return respond(String(url), init);
  }) as typeof globalThis.fetch;
  return { fetchImpl, seen };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function expectOverrideAttribution(result: ProviderQuota): void {
  expect(result.source).toBe(OVERRIDE_SOURCE);
  expect(result.state.sourcesTried).toEqual([OVERRIDE_SOURCE]);
  expect(result.attempts).toEqual([
    { source: OVERRIDE_SOURCE, status: "success" },
  ]);
  expect(result.state.status).toBe("fresh");
  expect(result.state.stale).toBe(false);
}

function expectOverrideRejection(result: ProviderQuota): void {
  expect(result.source).toBe("unavailable");
  expect(result.state.status).toBe("auth_required");
  expect(result.state.error).toBe(OVERRIDE_REJECTED_ERROR);
  expect(result.state.sourcesTried).toEqual([OVERRIDE_SOURCE]);
  expect(result.attempts).toEqual([
    {
      source: OVERRIDE_SOURCE,
      status: "failed",
      error: OVERRIDE_REJECTED_ERROR,
    },
  ]);
  expect(result.state.stale).toBe(false);
  expect(result.windows).toEqual([]);
}

function expectTokenHygiene(result: ProviderQuota, token: string): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(token);
  expect(serialized).not.toContain(LOCAL_DECOY);
  const toon = renderQuotaToon(
    {
      generatedAt: "2026-08-10T00:00:00.000Z",
      schemaVersion: 3,
      providers: [result],
    },
    "quota-axi",
    true,
  );
  expect(toon).not.toContain(token);
  expect(toon).not.toContain(LOCAL_DECOY);
}

function expectNoOverrideBytesInEnvironment(): void {
  for (const value of Object.values(process.env)) {
    if (!value) continue;
    for (const token of Object.values(OVERRIDE_TOKENS)) {
      expect(value).not.toContain(token);
    }
  }
}

// Static imports keep the vitest transform happy; the override paths never
// consult module-level env state, so import order is irrelevant here.
async function loadAdapter(provider: ProviderId): Promise<ProviderAdapter> {
  switch (provider) {
    case "claude":
      return (await import("../../src/providers/claude.js")).claudeAdapter;
    case "codex":
      return (await import("../../src/providers/codex.js")).codexAdapter;
    case "cursor":
      return (await import("../../src/providers/cursor.js")).cursorAdapter;
    case "copilot":
      return (await import("../../src/providers/copilot.js")).copilotAdapter;
    case "grok":
      return createGrokAdapter();
    case "kimi":
      return createKimiAdapter();
  }
}

describe("override flights: exclusivity and attribution", () => {
  it("claude uses only the override token against the usage and profile endpoints", async () => {
    writeJson(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), {
      claudeAiOauth: {
        accessToken: LOCAL_DECOY,
        subscriptionType: "Pro",
      },
    });
    const fixtureDir = join(import.meta.dirname, "..", "fixtures", "claude");
    const usage = readFileSync(join(fixtureDir, "oauth.json"), "utf8");
    const profile = readFileSync(
      join(fixtureDir, "oauth-profile.json"),
      "utf8",
    );
    const { fetchImpl, seen } = recordingFetch((url) =>
      url.endsWith("/profile")
        ? new Response(profile, { status: 200 })
        : new Response(usage, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = await loadAdapter("claude");

    const result = await adapter.fetchQuota(overridesFor("claude"));

    expectOverrideAttribution(result);
    expect(result.windows.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(2);
    for (const header of seen) {
      expect(header).toBe(`Bearer ${OVERRIDE_TOKENS.claude}`);
    }
    expectTokenHygiene(result, OVERRIDE_TOKENS.claude);
    expectNoOverrideBytesInEnvironment();
  });

  it("codex uses only the override token and never spawns the vendor CLI fallback", async () => {
    writeJson(join(process.env.CODEX_HOME!, "auth.json"), {
      tokens: { access_token: LOCAL_DECOY },
    });
    const marker = join(tempDir!, "codex-cli-invoked");
    const fakeCli = join(tempDir!, "fake-codex.sh");
    writeFileSync(fakeCli, `#!/bin/sh\necho spawned > "${marker}"\nexit 1\n`, {
      mode: 0o755,
    });
    chmodSync(fakeCli, 0o755);
    process.env.QUOTA_AXI_CODEX_BINARY = fakeCli;

    const fixture = readFileSync(
      join(import.meta.dirname, "..", "fixtures", "codex", "oauth-snake.json"),
      "utf8",
    );
    const { fetchImpl, seen } = recordingFetch(() =>
      jsonResponse(JSON.parse(fixture)),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = await loadAdapter("codex");

    const result = await adapter.fetchQuota(overridesFor("codex"));

    expectOverrideAttribution(result);
    expect(seen).toContain(`Bearer ${OVERRIDE_TOKENS.codex}`);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(result.attempts)).not.toContain("cli-rpc");
    expectTokenHygiene(result, OVERRIDE_TOKENS.codex);
    expectNoOverrideBytesInEnvironment();
  });

  it("cursor uses only the override token and never reads the state database", async () => {
    const { fetchImpl, seen } = recordingFetch((url) =>
      url.endsWith("/GetPlanInfo")
        ? jsonResponse({ planInfo: { planName: "Pro" } })
        : jsonResponse({
            planUsage: { totalPercentUsed: 10 },
            billingCycleEnd: 1_893_456_000_000,
          }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = await loadAdapter("cursor");

    const result = await adapter.fetchQuota(overridesFor("cursor"));

    expectOverrideAttribution(result);
    expect(seen).not.toHaveLength(0);
    for (const header of seen) {
      expect(header).toBe(`Bearer ${OVERRIDE_TOKENS.cursor}`);
    }
    expectTokenHygiene(result, OVERRIDE_TOKENS.cursor);
  });

  it("copilot uses only the override token from the envelope, not apps.json", async () => {
    writeJson(process.env.GITHUB_COPILOT_APPS_JSON!, {
      "github.com": { oauth_token: LOCAL_DECOY, user: "fixture-user" },
    });
    const { fetchImpl, seen } = recordingFetch(() =>
      jsonResponse({
        login: "override-user",
        copilot_plan: "individual",
        quota_snapshots: { chat: { percent_remaining: 75 } },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = await loadAdapter("copilot");

    const result = await adapter.fetchQuota(overridesFor("copilot"));

    expectOverrideAttribution(result);
    expect(seen).toEqual([`Bearer ${OVERRIDE_TOKENS.copilot}`]);
    expectTokenHygiene(result, OVERRIDE_TOKENS.copilot);
  });

  it("grok uses only the override token and never resolves Grok CLI or Pi credentials", async () => {
    writeJson(process.env.GROK_AUTH_JSON!, {
      current: { key: LOCAL_DECOY, expires_at: "2035-01-01T00:00:00.000Z" },
    });
    const piBroker = {
      resolve: vi.fn(async () => {
        throw new Error("Pi credential resolution must not run");
      }),
      inspect: vi.fn(async () => {
        throw new Error("Pi credential inspection must not run");
      }),
    };
    const { fetchImpl, seen } = recordingFetch(
      () =>
        new Response(grpcCreditsBody(), {
          status: 200,
          headers: { "content-type": "application/grpc-web+proto" },
        }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = createGrokAdapter({ piXaiBroker: piBroker });

    const result = await adapter.fetchQuota(overridesFor("grok"));

    expectOverrideAttribution(result);
    expect(piBroker.resolve).not.toHaveBeenCalled();
    expect(piBroker.inspect).not.toHaveBeenCalled();
    expect(seen).toEqual([`Bearer ${OVERRIDE_TOKENS.grok}`]);
    expectTokenHygiene(result, OVERRIDE_TOKENS.grok);
  });

  it("kimi uses only the override token and never resolves Pi or CLI credentials", async () => {
    const broker = {
      resolve: vi.fn(async () => {
        throw new Error("Pi credential resolution must not run");
      }),
      inspect: vi.fn(async () => {
        throw new Error("Pi credential inspection must not run");
      }),
    };
    const cliSource = {
      resolve: vi.fn(async () => {
        throw new Error("Kimi Code CLI resolution must not run");
      }),
      inspect: vi.fn(async () => {
        throw new Error("Kimi Code CLI inspection must not run");
      }),
    };
    const readCache = vi.fn(() => undefined);
    const deleteCache = vi.fn();
    const { fetchImpl, seen } = recordingFetch(() =>
      jsonResponse({
        usage: { limit: 100, used: 10, resetTime: "2027-02-08T04:05:06Z" },
        limits: [],
      }),
    );
    const adapter = createKimiAdapter({
      broker,
      cliCredentialSource: cliSource,
      fetch: fetchImpl,
      readCachedProvider: readCache,
      deleteCachedProvider: deleteCache,
      now: () => Date.parse("2027-02-03T04:05:06.000Z"),
    });

    const result = await adapter.fetchQuota(overridesFor("kimi"));

    expectOverrideAttribution(result);
    expect(broker.resolve).not.toHaveBeenCalled();
    expect(cliSource.resolve).not.toHaveBeenCalled();
    expect(readCache).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
    expect(seen).toEqual([`Bearer ${OVERRIDE_TOKENS.kimi}`]);
    expectTokenHygiene(result, OVERRIDE_TOKENS.kimi);
  });
});

describe("override flights: truthful rejection without local fallback or cache", () => {
  it.each(["claude", "codex", "cursor", "copilot", "grok"] as const)(
    "%s reports override_rejected on HTTP 401 without touching the cache",
    async (provider) => {
      seedCacheWithFreshSnapshot(provider);
      const reject =
        provider === "grok"
          ? () =>
              new Response("nope", {
                status: 401,
                headers: { "content-type": "application/grpc-web+proto" },
              })
          : () => jsonResponse({ error: "nope" }, 401);
      const { fetchImpl } = recordingFetch(reject);
      vi.stubGlobal("fetch", fetchImpl);
      const adapter = await loadAdapter(provider);

      const result = await adapter.fetchQuota(overridesFor(provider));

      expectOverrideRejection(result);
      // The seeded local-source snapshot survives untouched: an override
      // flight says nothing about local credential validity.
      expect(readCachedProvider(provider)?.state.refreshedAt).toBe(
        "2026-08-10T00:00:00.000Z",
      );
      expectTokenHygiene(result, OVERRIDE_TOKENS[provider]);
    },
  );

  it("kimi reports override_rejected on HTTP 401 without touching the cache", async () => {
    const readCache = vi.fn(() => undefined);
    const deleteCache = vi.fn();
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: "nope" }, 401),
    );
    const adapter = createKimiAdapter({
      broker: neverCalledBroker(),
      cliCredentialSource: neverCalledCliSource(),
      fetch: fetchImpl,
      readCachedProvider: readCache,
      deleteCachedProvider: deleteCache,
      now: () => Date.now(),
    });

    const result = await adapter.fetchQuota(overridesFor("kimi"));

    expectOverrideRejection(result);
    expect(readCache).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
    expectTokenHygiene(result, OVERRIDE_TOKENS.kimi);
  });

  it("codex 429 surfaces rate limiting truthfully with the retry hint", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "300" },
        }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = await loadAdapter("codex");

    const before = Date.now();
    const result = await adapter.fetchQuota(overridesFor("codex"));

    expect(result.state.status).toBe("rate_limited");
    expect(result.state.error).toBe("Codex quota endpoint rate limited");
    expect(result.state.sourcesTried).toEqual([OVERRIDE_SOURCE]);
    const retryAt = Date.parse(result.state.retryAfter ?? "");
    expect(retryAt).toBeGreaterThanOrEqual(before + 299_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 301_000);
  });
});

describe("override flights: cache and parity invariants", () => {
  it("never persists an override snapshot to the quota cache", () => {
    writeCachedProviders([
      {
        provider: "claude",
        label: "Claude",
        source: "override",
        windows: [
          {
            id: "five_hour",
            label: "session",
            kind: "session",
            percentUsed: 10,
            percentRemaining: 90,
          },
        ],
        state: {
          status: "fresh",
          stale: false,
          refreshedAt: "2026-08-10T00:00:00.000Z",
          sourcesTried: ["override"],
        },
      },
    ]);

    expect(readCachedProvider("claude")).toBeUndefined();
  });

  it("envelope entries for other providers leave codex behavior identical", async () => {
    // No local codex credentials and no codex binary: the flight fails the
    // same way with or without an irrelevant override entry for kimi.
    const adapter = await loadAdapter("codex");
    vi.stubGlobal("fetch", vi.fn());
    const baseline = await adapter.fetchQuota({
      allowKeychainPrompt: false,
    });
    const withIrrelevantOverride = await adapter.fetchQuota({
      allowKeychainPrompt: false,
      credentialOverrides: {
        kimi: { kind: "bearer", token: OVERRIDE_TOKENS.kimi },
      },
    });

    expect(withIrrelevantOverride).toEqual(baseline);
    expect(baseline.source).not.toBe(OVERRIDE_SOURCE);
  });

  it.each(["claude", "codex", "cursor", "copilot", "grok", "kimi"] as const)(
    "%s behaves byte-for-byte identically when the envelope has no entry for it",
    async (provider) => {
      // Isolate every local resolution surface: no credential files, an empty
      // PATH (no codex binary, no sqlite3, no keychain tooling), an empty
      // cache, and a network that must not be reached without credentials.
      const emptyBin = join(tempDir!, "empty-bin");
      mkdirSync(emptyBin, { recursive: true });
      const pathSnapshot = process.env.PATH;
      process.env.PATH = emptyBin;
      const fetchSpy = vi.fn(async () => {
        throw new Error("network must not be reached without credentials");
      });
      vi.stubGlobal("fetch", fetchSpy);
      try {
        const adapter = await loadAdapter(provider);
        const baseline = await adapter.fetchQuota({
          allowKeychainPrompt: false,
        });
        const withEmptyOverrides = await adapter.fetchQuota({
          allowKeychainPrompt: false,
          credentialOverrides: {},
        });
        const otherProvider = provider === "kimi" ? "claude" : "kimi";
        const withIrrelevantOverride = await adapter.fetchQuota({
          allowKeychainPrompt: false,
          credentialOverrides: {
            [otherProvider]: {
              kind: "bearer",
              token: OVERRIDE_TOKENS[otherProvider],
            },
          },
        });

        // `refreshedAt` timestamps only exist on fresh results; these isolated
        // flights all fail deterministically, so structural equality holds.
        expect(withEmptyOverrides).toEqual(baseline);
        expect(withIrrelevantOverride).toEqual(baseline);
        expect(baseline.source).not.toBe(OVERRIDE_SOURCE);
        expect(baseline.state.sourcesTried).not.toContain(OVERRIDE_SOURCE);
        // With no local credentials and no applicable override, no provider
        // may reach the network at all.
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        if (pathSnapshot === undefined) delete process.env.PATH;
        else process.env.PATH = pathSnapshot;
      }
    },
  );
});

function seedCacheWithFreshSnapshot(provider: ProviderId): void {
  // Codex cache entries pass identity validation only for known window shapes.
  const window =
    provider === "codex"
      ? {
          id: "five_hour",
          label: "session",
          kind: "session" as const,
          percentUsed: 1,
          percentRemaining: 99,
        }
      : {
          id: "seeded",
          label: "seeded",
          kind: "monthly" as const,
          percentUsed: 1,
          percentRemaining: 99,
        };
  writeCachedProviders([
    {
      provider,
      label: provider,
      source: provider === "grok" ? "web" : "api",
      windows: [window],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-08-10T00:00:00.000Z",
        sourcesTried: ["api"],
      },
    },
  ]);
  expect(readCachedProvider(provider)).toBeDefined();
}

function neverCalledBroker() {
  return {
    resolve: vi.fn(async () => {
      throw new Error("Pi credential resolution must not run");
    }),
    inspect: vi.fn(async () => {
      throw new Error("Pi credential inspection must not run");
    }),
  } as never;
}

function neverCalledCliSource() {
  return {
    resolve: vi.fn(async () => {
      throw new Error("Kimi Code CLI resolution must not run");
    }),
    inspect: vi.fn(async () => {
      throw new Error("Kimi Code CLI inspection must not run");
    }),
  } as never;
}

// Minimal gRPC-web credits-config body: shared usage 10%, a valid weekly
// current period, and a prepaid balance - enough for normalization.
function grpcCreditsBody(): Uint8Array {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const period = concat(
    scalar(1, 2),
    message(2, timestamp(nowSeconds - 86_400)),
    message(3, timestamp(nowSeconds + 6 * 86_400)),
  );
  const config = concat(
    fixed32(1, 10),
    message(8, period),
    message(12, scalar(1, 450)),
  );
  return grpcFrame(message(1, config));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function scalar(field: number, value: number): Uint8Array {
  return concat(varint(field << 3), varint(value));
}

function fixed32(field: number, value: number): Uint8Array {
  const bytes = new Uint8Array(5);
  bytes[0] = (field << 3) | 5;
  new DataView(bytes.buffer).setFloat32(1, value, true);
  return bytes;
}

function message(field: number, value: Uint8Array): Uint8Array {
  return concat(varint((field << 3) | 2), varint(value.length), value);
}

function timestamp(epochSeconds: number): Uint8Array {
  return scalar(1, epochSeconds);
}

function grpcFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}
