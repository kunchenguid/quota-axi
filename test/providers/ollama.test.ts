import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createOllamaAdapter,
  normalizeOllamaUsage,
  OLLAMA_ENV_CREDENTIAL_SOURCE,
  OLLAMA_PI_CREDENTIAL_SOURCE,
  OLLAMA_USAGE_URL,
} from "../../src/providers/ollama.js";
import { createPiOllamaCredentialBroker } from "../../src/providers/pi-ollama-credential.js";
import type {
  PiOllamaCredentialInspection,
  PiOllamaCredentialResolution,
} from "../../src/providers/pi-ollama-credential.js";
import type { ProviderQuota } from "../../src/types.js";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const PI_KEY = "synthetic-ollama-pi-key-481";
const ENV_KEY = "synthetic-ollama-env-key-592";
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Pi Ollama Cloud credential broker", () => {
  it("reads the ollama-cloud API key from the default Pi auth file", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    writeAuth(authPath, {
      "ollama-cloud": {
        type: "api_key",
        key: PI_KEY,
      },
    });

    const broker = createPiOllamaCredentialBroker({
      environment: { HOME: home },
      homeDirectory: () => home,
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      credential: PI_KEY,
      path: authPath,
    });
    await expect(broker.inspect()).resolves.toEqual({
      status: "available",
      path: authPath,
    });
    expect(readdirSync(dirname(authPath))).toEqual(["auth.json"]);
  });

  it("supports a configured Pi agent directory and ignores other providers", async () => {
    const directory = temporaryDirectory();
    const authPath = join(directory, "auth.json");
    writeAuth(authPath, {
      "openai-codex": { type: "api_key", key: "unrelated" },
      "ollama-cloud": { type: "api_key", key: PI_KEY },
    });

    const broker = createPiOllamaCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: directory },
      homeDirectory: () => temporaryDirectory(),
    });

    await expect(broker.resolve()).resolves.toMatchObject({
      status: "available",
      credential: PI_KEY,
      path: authPath,
    });
  });

  it("reports absent, invalid, and unsupported Pi entries distinctly", async () => {
    const missing = createPiOllamaCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: temporaryDirectory() },
      homeDirectory: () => temporaryDirectory(),
    });
    await expect(missing.resolve()).resolves.toMatchObject({
      status: "missing",
    });

    const invalidPath = writeAuthFixture({
      "ollama-cloud": { type: "api_key", key: "$OLLAMA_API_KEY" },
    });
    const invalid = createPiOllamaCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: dirname(invalidPath) },
      homeDirectory: () => temporaryDirectory(),
    });
    await expect(invalid.resolve()).resolves.toMatchObject({
      status: "invalid",
    });

    const unsupportedPath = writeAuthFixture({
      "ollama-cloud": { type: "oauth", access: "not-an-api-key-entry" },
    });
    const unsupported = createPiOllamaCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: dirname(unsupportedPath) },
      homeDirectory: () => temporaryDirectory(),
    });
    await expect(unsupported.resolve()).resolves.toMatchObject({
      status: "unsupported",
    });
    await expect(unsupported.inspect()).resolves.toMatchObject({
      status: "unsupported",
      error: "unsupported_credential_type",
    });
  });

  it("bounds auth-file reads and never writes the Pi store", async () => {
    const directory = temporaryDirectory();
    const authPath = join(directory, "auth.json");
    const oversized = `${"x".repeat(65 * 1024)}\n`;
    writeFileSync(authPath, oversized, { mode: 0o600 });

    const broker = createPiOllamaCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: directory },
      homeDirectory: () => temporaryDirectory(),
    });
    await expect(broker.resolve()).resolves.toMatchObject({
      status: "invalid",
    });

    const after = readFileText(authPath);
    expect(after).toBe(oversized);
    expect(after.length).toBeGreaterThan(64 * 1024);
    expect(readdirSync(directory)).toEqual(["auth.json"]);
  });
});

describe("Ollama Cloud quota provider", () => {
  it("makes one fixed-origin read-only request and normalizes fractions", async () => {
    const request = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({
        limits: {
          session: { usage: 0.069 },
          weekly: { usage: "0.331" },
        },
        activity: {
          cost: "999.00",
          period: { starting_at: "not-a-quota-window" },
        },
      }),
    );
    const adapter = testAdapter({
      fetch: request,
      piResolution: availablePiResolution(),
      environment: {},
      now: () => NOW,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    expect(input).toBe(OLLAMA_USAGE_URL);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${PI_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("cookie")).toBeNull();
    expect(report).toMatchObject({
      provider: "ollama",
      label: "Ollama Cloud",
      source: "api",
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(NOW).toISOString(),
        sourcesTried: [OLLAMA_PI_CREDENTIAL_SOURCE],
      },
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 7,
          percentRemaining: 93,
        },
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed: 33,
          percentRemaining: 67,
        },
      ],
    });
    expect(report.windows.every((window) => !window.resetsAt)).toBe(true);
    expect(report.windows.every((window) => !window.windowSeconds)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(PI_KEY);
    expect(JSON.stringify(report)).not.toContain("999.00");
  });

  it("returns a fresh empty report for an empty or unusable payload", async () => {
    for (const payload of [
      {},
      { limits: {} },
      { limits: { session: { usage: "unknown" }, weekly: { usage: 1.5 } } },
    ]) {
      const report = await testAdapter({
        piResolution: availablePiResolution(),
        fetch: vi.fn(async () => jsonResponse(payload)),
      }).fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        provider: "ollama",
        source: "api",
        windows: [],
        state: { status: "fresh", stale: false },
      });
    }
  });

  it("normalizes only finite usage fractions in the inclusive range", () => {
    expect(
      normalizeOllamaUsage({
        limits: {
          session: { usage: 0 },
          weekly: { usage: 1 },
        },
      }),
    ).toEqual({
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 0,
          percentRemaining: 100,
        },
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed: 100,
          percentRemaining: 0,
        },
      ],
    });
    expect(
      normalizeOllamaUsage({
        limits: {
          session: { usage: -0.1 },
          weekly: { usage: Number.NaN },
        },
      }).windows,
    ).toEqual([]);
  });

  it("keeps the two sources in order and falls through a rejected Pi key", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse({ limits: { session: { usage: 0.1 } } }),
      );
    const adapter = testAdapter({
      piResolution: availablePiResolution(),
      environment: { OLLAMA_API_KEY: ENV_KEY },
      fetch: request,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${PI_KEY}`);
    expect(
      new Headers(request.mock.calls[1][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${ENV_KEY}`);
    expect(report).toMatchObject({
      source: "api",
      state: {
        status: "fresh",
        sourcesTried: [
          OLLAMA_PI_CREDENTIAL_SOURCE,
          OLLAMA_ENV_CREDENTIAL_SOURCE,
        ],
      },
      windows: [{ id: "five_hour", percentUsed: 10, percentRemaining: 90 }],
    });
    expect(report.attempts).toEqual([
      {
        source: OLLAMA_PI_CREDENTIAL_SOURCE,
        status: "failed",
        error: "provider_auth_rejected",
      },
      { source: OLLAMA_ENV_CREDENTIAL_SOURCE, status: "success" },
    ]);
  });

  it("stops at a Pi auth read error and preserves stale cache", async () => {
    const request = vi.fn(async () => jsonResponse({ limits: {} }));
    const deleteCache = vi.fn();
    const report = await testAdapter({
      piResolution: {
        status: "error",
        path: "/tmp/pi-agent/auth.json",
      },
      environment: { OLLAMA_API_KEY: ENV_KEY },
      fetch: request,
      readCachedProvider: () => cachedQuota(),
      deleteCachedProvider: deleteCache,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      source: "cache",
      state: {
        status: "stale",
        stale: true,
        error: "credential_resolution_failed",
        sourcesTried: [OLLAMA_PI_CREDENTIAL_SOURCE, "cache"],
      },
    });
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it("does not retry a sibling source after a transient provider failure", async () => {
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    const report = await testAdapter({
      piResolution: availablePiResolution(),
      environment: { OLLAMA_API_KEY: ENV_KEY },
      fetch: request,
      readCachedProvider: () => undefined,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledOnce();
    expect(report.state).toMatchObject({
      status: "unavailable",
      error: "provider_unavailable",
    });
  });

  it("preserves a cached report for transient failures", async () => {
    const cached = cachedQuota();
    const deleteCache = vi.fn();
    const report = await testAdapter({
      piResolution: availablePiResolution(),
      fetch: vi.fn(async () => new Response(null, { status: 429 })),
      readCachedProvider: () => cached,
      deleteCachedProvider: deleteCache,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "cache",
      state: { status: "stale", stale: true, error: "provider_rate_limited" },
      windows: cached.windows,
    });
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it("retires the cache only after a definitive auth result", async () => {
    const deleteCache = vi.fn();
    const report = await testAdapter({
      piResolution: availablePiResolution(),
      environment: {},
      fetch: vi.fn(async () => new Response(null, { status: 403 })),
      readCachedProvider: () => cachedQuota(),
      deleteCachedProvider: deleteCache,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
    expect(report.windows).toEqual([]);
    expect(deleteCache).toHaveBeenCalledWith("ollama");
  });

  it("reports both auth sources without exposing their values", async () => {
    const piPath = join("/tmp", "pi-agent", "auth.json");
    const adapter = testAdapter({
      piInspection: { status: "available", path: piPath },
      environment: { OLLAMA_API_KEY: ENV_KEY },
    });

    const report = await adapter.inspectAuth(OPTIONS);

    expect(report).toEqual({
      provider: "ollama",
      sources: [
        {
          source: OLLAMA_PI_CREDENTIAL_SOURCE,
          path: piPath,
          status: "available",
        },
        { source: OLLAMA_ENV_CREDENTIAL_SOURCE, status: "available" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(PI_KEY);
    expect(JSON.stringify(report)).not.toContain(ENV_KEY);
  });

  it("keeps quota semantics unknown without inventing a joint bound", async () => {
    const report = await testAdapter({
      piResolution: availablePiResolution(),
      fetch: vi.fn(async () =>
        jsonResponse({ limits: { session: { usage: 0.2 } } }),
      ),
    }).fetchQuota(OPTIONS);

    const enriched = withQuotaSemantics(report, new Date(NOW).toISOString());

    expect(enriched.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: ["five_hour"],
    });
  });
});

function testAdapter(
  options: {
    piResolution?: PiOllamaCredentialResolution;
    piInspection?: PiOllamaCredentialInspection;
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    readCachedProvider?: (provider: "ollama") => ProviderQuota | undefined;
    deleteCachedProvider?: (provider: "ollama") => void;
    now?: () => number;
    deadlineMs?: number;
  } = {},
) {
  const piResolution = options.piResolution ?? {
    status: "missing" as const,
    path: "/tmp/pi-agent/auth.json",
  };
  const piInspection = options.piInspection ?? {
    status: piResolution.status,
    path: piResolution.path,
  };
  const piBroker = {
    resolve: vi.fn(async () => piResolution),
    inspect: vi.fn(async () => ({
      status: piInspection.status,
      path: piInspection.path,
      ...(piInspection.error ? { error: piInspection.error } : {}),
    })),
  };

  return createOllamaAdapter({
    piBroker,
    environment: options.environment ?? {},
    fetch:
      options.fetch ??
      (async () => jsonResponse({ limits: { session: { usage: 0 } } })),
    readCachedProvider: options.readCachedProvider ?? (() => undefined),
    deleteCachedProvider: options.deleteCachedProvider ?? (() => undefined),
    now: options.now ?? (() => NOW),
    deadlineMs: options.deadlineMs ?? 15_000,
  });
}

function availablePiResolution() {
  return {
    status: "available" as const,
    credential: PI_KEY,
    path: "/tmp/pi-agent/auth.json",
  };
}

function cachedQuota(): ProviderQuota {
  return {
    provider: "ollama",
    label: "Ollama Cloud",
    source: "api",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 20,
        percentRemaining: 80,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(NOW - 60_000).toISOString(),
      sourcesTried: [OLLAMA_PI_CREDENTIAL_SOURCE],
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-ollama-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAuth(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function writeAuthFixture(value: unknown): string {
  const directory = temporaryDirectory();
  const path = join(directory, "auth.json");
  writeAuth(path, value);
  return path;
}

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}
