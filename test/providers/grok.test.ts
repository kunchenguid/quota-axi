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
import { writeCachedProviders } from "../../src/cache.js";
import { main } from "../../src/cli.js";
import { statusFromError } from "../../src/providers/common.js";
import {
  createGrokAdapter,
  fetchQuota,
  inspectAuth,
  normalizeGrokConsumerPayload,
} from "../../src/providers/grok.js";
import type { ProviderQuota, QuotaAxiResponse } from "../../src/types.js";

const CONSUMER_QUOTA_URL =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GROK_BUILD_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
const XAI_MODELS_URL = "https://api.x.ai/v1/models";
const originalGrokAuthJson = process.env.GROK_AUTH_JSON;
const originalGrokAuthPath = process.env.GROK_AUTH_PATH;
const originalGrokAuth = process.env.GROK_AUTH;
const originalGrokHome = process.env.GROK_HOME;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-grok-auth-"));
  process.env.GROK_AUTH_JSON = join(tempDir, "auth.json");
  delete process.env.GROK_AUTH_PATH;
  delete process.env.GROK_AUTH;
  process.env.GROK_HOME = join(tempDir, "grok-home");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.PATH = join(tempDir, "empty-bin");
  process.env.PATHEXT = ".CMD;.EXE";
  process.exitCode = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalGrokAuthJson === undefined) delete process.env.GROK_AUTH_JSON;
  else process.env.GROK_AUTH_JSON = originalGrokAuthJson;
  if (originalGrokAuthPath === undefined) delete process.env.GROK_AUTH_PATH;
  else process.env.GROK_AUTH_PATH = originalGrokAuthPath;
  if (originalGrokAuth === undefined) delete process.env.GROK_AUTH;
  else process.env.GROK_AUTH = originalGrokAuth;
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  if (originalPiCodingAgentDir === undefined)
    delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPathExt === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = originalPathExt;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writeAuth(value: unknown, file = process.env.GROK_AUTH_JSON!): void {
  writeJson(file, value);
}

function writeValidAuth(key = "valid-key"): void {
  writeAuth({
    current: {
      key,
      expires_at: "2035-01-01T00:00:00.000Z",
    },
  });
}

function writePiXaiAuth(value: unknown): void {
  writeJson(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), value);
}

function writeValidPiXaiOauth(
  access = "pi-xai-access-token-fixture",
  expires = Date.now() + 3_600_000,
): void {
  writePiXaiAuth({
    xai: {
      type: "oauth",
      access,
      refresh: "pi-xai-refresh-token-fixture",
      expires,
    },
  });
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

type ConsumerPayloadOptions = {
  percentUsed?: number;
  includePercent?: boolean;
  products?: Array<{ product?: number; usagePercent?: number }>;
  periodType?: 0 | 1 | 2;
  includePeriod?: boolean;
  includePeriodStart?: boolean;
  includePeriodEnd?: boolean;
  prepaid?: number;
  includePrepaid?: boolean;
  includeMonetaryFields?: boolean;
};

function consumerPayload(options: ConsumerPayloadOptions = {}): Uint8Array {
  const config: Uint8Array[] = [];
  const percentUsed = options.percentUsed ?? 22;
  if (options.includePercent !== false) config.push(fixed32(1, percentUsed));
  if (options.includeMonetaryFields) {
    config.push(message(2, scalar(1, 1_000)));
    config.push(message(3, scalar(1, 275)));
    config.push(message(4, timestamp(1_772_323_200)));
    config.push(message(5, timestamp(1_775_001_600)));
  }
  for (const product of options.products ?? []) {
    const fields: Uint8Array[] = [];
    if (product.product !== undefined) fields.push(scalar(1, product.product));
    if (product.usagePercent !== undefined)
      fields.push(fixed32(2, product.usagePercent));
    config.push(message(7, concat(...fields)));
  }
  if (options.includePeriod !== false) {
    const end = Date.parse("2026-07-27T20:00:00Z") / 1_000;
    const start = end - 7 * 86_400;
    const period: Uint8Array[] = [scalar(1, options.periodType ?? 2)];
    if (options.includePeriodStart !== false)
      period.push(message(2, timestamp(start)));
    if (options.includePeriodEnd !== false)
      period.push(message(3, timestamp(end)));
    config.push(message(8, concat(...period)));
  }
  if (options.includePrepaid !== false) {
    const prepaid = options.prepaid ?? 450;
    config.push(
      message(12, prepaid === 0 ? new Uint8Array() : scalar(1, prepaid)),
    );
  }
  return message(1, concat(...config));
}

function grpcResponse(
  payload = consumerPayload(),
  options: {
    raw?: boolean;
    trailerStatus?: number;
    trailerMessage?: string;
    headers?: Record<string, string>;
    status?: number;
  } = {},
): Response {
  let body = options.raw ? payload : grpcFrame(payload);
  if (!options.raw && options.trailerStatus !== undefined) {
    const trailerText = [
      `grpc-status: ${options.trailerStatus}`,
      options.trailerMessage
        ? `grpc-message: ${encodeURIComponent(options.trailerMessage)}`
        : undefined,
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\r\n");
    body = concat(body, grpcFrame(new TextEncoder().encode(trailerText), 0x80));
  }
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/grpc-web+proto",
      ...options.headers,
    },
  });
}

function stubSuccessfulFetch(
  payload = consumerPayload(),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => grpcResponse(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function cachedGrok(source: "api" | "web"): ProviderQuota {
  return {
    provider: "grok",
    label: "Grok",
    source,
    windows: [
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: 20,
        percentRemaining: 80,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-20T00:00:00.000Z",
      sourcesTried: [source],
    },
  };
}

describe("Grok consumer quota parsing", () => {
  it("normalizes global, product, reset, prepaid, and account fields", () => {
    const result = normalizeGrokConsumerPayload(
      consumerPayload({
        percentUsed: 18.25,
        products: [
          { product: 2, usagePercent: 33.25 },
          { product: 4, usagePercent: 105 },
        ],
        prepaid: 450,
      }),
      { email: "person@example.invalid", teamId: "team_fixture" },
    );

    expect(result.account).toEqual({
      email: "person@example.invalid",
      organization: "team_fixture",
    });
    expect(result.credits).toEqual({ remaining: 450, unit: "credits" });
    expect(result.windows).toEqual([
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: 18.25,
        percentRemaining: 81.75,
        startsAt: "2026-07-20T20:00:00.000Z",
        resetsAt: "2026-07-27T20:00:00.000Z",
      },
      {
        id: "product:grok_build",
        label: "Grok Build",
        kind: "credits",
        percentUsed: 33.25,
        percentRemaining: 66.75,
        startsAt: "2026-07-20T20:00:00.000Z",
        resetsAt: "2026-07-27T20:00:00.000Z",
      },
      {
        id: "product:chat",
        label: "Chat",
        kind: "credits",
        percentUsed: 100,
        percentRemaining: 0,
        startsAt: "2026-07-20T20:00:00.000Z",
        resetsAt: "2026-07-27T20:00:00.000Z",
      },
    ]);
  });

  it("preserves an explicit zero even without a current period", () => {
    const result = normalizeGrokConsumerPayload(
      consumerPayload({
        percentUsed: 0,
        includePeriod: false,
        includePrepaid: false,
      }),
    );

    expect(result.windows).toEqual([
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: undefined,
      },
    ]);
  });

  it("applies omitted proto3 zero only when a valid current period is present", () => {
    const result = normalizeGrokConsumerPayload(
      consumerPayload({
        includePercent: false,
        products: [{ product: 2 }],
        prepaid: 0,
      }),
    );

    expect(result.windows).toMatchObject([
      { id: "credits", percentUsed: 0, percentRemaining: 100 },
      {
        id: "product:grok_build",
        percentUsed: 0,
        percentRemaining: 100,
      },
    ]);
    expect(result.credits).toEqual({ remaining: 0, unit: "credits" });
  });

  it("supports monthly periods and unknown product enum values", () => {
    const result = normalizeGrokConsumerPayload(
      consumerPayload({
        periodType: 1,
        products: [{ product: 99, usagePercent: 12.5 }],
      }),
    );

    expect(result.windows[1]).toMatchObject({
      id: "product:unknown_99",
      label: "Product 99",
      percentUsed: 12.5,
    });
  });

  it("rejects a missing config", () => {
    expect(() => normalizeGrokConsumerPayload(new Uint8Array())).toThrow(
      "Grok quota response invalid",
    );
  });

  it("rejects omitted percentages without a valid current period", () => {
    const payload = consumerPayload({
      includePercent: false,
      products: [{ product: 2 }],
      includePeriodEnd: false,
    });

    expect(() => normalizeGrokConsumerPayload(payload)).toThrow(
      "Grok quota response invalid",
    );
  });

  it("does not derive quota from monetary fields or billing dates", () => {
    const payload = consumerPayload({
      includePercent: false,
      products: [],
      includePeriod: false,
      includePrepaid: false,
      includeMonetaryFields: true,
    });

    expect(() => normalizeGrokConsumerPayload(payload)).toThrow(
      "Grok quota response invalid",
    );
  });
});

describe("Grok consumer quota acquisition", () => {
  it("uses the exact read-only consumer operation, headers, and empty frame", async () => {
    writeValidAuth();
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "web",
      state: { status: "fresh", sourcesTried: ["web", "pi:xai"] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONSUMER_QUOTA_URL);
    expect(init).toMatchObject({ method: "POST" });
    expect(init.headers).toEqual({
      Authorization: "Bearer valid-key",
      Accept: "*/*",
      "Content-Type": "application/grpc-web+proto",
      Origin: "https://grok.com",
      Referer: "https://grok.com/?_s=usage",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
    });
    expect(Array.from(init.body as Uint8Array)).toEqual([0, 0, 0, 0, 0]);
    expect(init.headers).not.toHaveProperty("Cookie");
    expect(init.headers).not.toHaveProperty("x-grok-client-mode");
    expect(init.headers).not.toHaveProperty("x-grok-client-version");
  });

  it("accepts a compatible raw protobuf response", async () => {
    writeValidAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grpcResponse(consumerPayload(), { raw: true })),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "web",
      windows: [{ percentUsed: 22, percentRemaining: 78 }],
      state: { status: "fresh" },
    });
  });

  it.each([
    ["truncated", Uint8Array.from([0, 0, 0, 0, 8, 10])],
    ["malformed", Uint8Array.from([10, 5, 8])],
    ["compressed", grpcFrame(consumerPayload(), 1)],
    [
      "multiple data frames",
      concat(grpcFrame(consumerPayload()), grpcFrame(consumerPayload())),
    ],
  ])("rejects a %s response", async (_label, body) => {
    writeValidAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "Grok quota response invalid" },
    });
  });

  it.each([
    [16, "auth_required", "Grok sign-in required"],
    [8, "rate_limited", "Grok quota endpoint rate limited"],
    [7, "error", "Grok quota unavailable"],
    [13, "error", "Grok quota unavailable"],
  ])(
    "classifies gRPC trailer status %i without exposing its message",
    async (grpcStatus, status, error) => {
      writeValidAuth();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          grpcResponse(consumerPayload(), {
            trailerStatus: grpcStatus,
            trailerMessage: "private-provider-diagnostic",
          }),
        ),
      );

      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state).toMatchObject({ status, error });
      expect(result.state.error).not.toContain("private-provider-diagnostic");
    },
  );

  it.each([
    ["trailer", "OAuth access token expired"],
    ["header", "invalid credentials"],
    ["trailer", "bad-credentials"],
    ["header", "oauth2 credential could not be validated"],
    ["trailer", "access token could not be validated"],
  ])(
    "classifies credential-related gRPC permission denial in the %s as auth required",
    async (location, diagnostic) => {
      writeValidAuth();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          grpcResponse(
            consumerPayload(),
            location === "trailer"
              ? { trailerStatus: 7, trailerMessage: diagnostic }
              : {
                  headers: {
                    "grpc-status": "7",
                    "grpc-message": encodeURIComponent(diagnostic),
                  },
                },
          ),
        ),
      );

      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state).toMatchObject({
        status: "auth_required",
        error: "Grok sign-in required",
      });
      expect(result.state.error).not.toContain(diagnostic);
    },
  );

  it("honors nonzero gRPC status response headers before reading the body", async () => {
    writeValidAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        grpcResponse(consumerPayload(), {
          headers: { "grpc-status": "13", "grpc-message": "private-body" },
        }),
      ),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "error",
      error: "Grok quota unavailable",
    });
  });

  it("rejects responses larger than 64 KiB without exposing their bodies", async () => {
    writeValidAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(64 * 1024 + 1), { status: 200 }),
      ),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "error",
      error: "Grok quota response too large",
    });
  });

  it("times out the bounded request", async () => {
    vi.useFakeTimers();
    writeValidAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );
    const adapter = createGrokAdapter({
      piXaiBroker: {
        resolve: async () => ({ status: "missing" }),
        inspect: async () => ({ status: "missing" }),
      },
    });

    const pending = adapter.fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(result.state).toMatchObject({
      status: "error",
      error: "Grok quota request timed out",
    });
  });

  it("classifies HTTP rate limits and preserves retry-after", async () => {
    writeValidAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(undefined, {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      ),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("rate_limited");
    expect(result.state.error).toBe("Grok quota endpoint rate limited");
    expect(result.state.retryAfter).toBeDefined();
  });

  it.each([
    [401, "auth_required", "Grok sign-in required"],
    [403, "auth_required", "Grok sign-in required"],
    [503, "error", "Grok quota unavailable"],
  ])("classifies HTTP %i safely", async (httpStatus, status, error) => {
    writeValidAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private-body", { status: httpStatus })),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({ status, error });
    expect(result.state.error).not.toContain("private-body");
  });

  it("never launches an available Grok executable", async () => {
    writeValidAuth();
    const binDir = join(tempDir!, "bin");
    const marker = join(tempDir!, "grok-launched");
    mkdirSync(binDir, { recursive: true });
    const command =
      process.platform === "win32"
        ? join(binDir, "grok.CMD")
        : join(binDir, "grok");
    writeFileSync(
      command,
      process.platform === "win32"
        ? `@echo off\r\ntype nul > "${marker}"\r\n`
        : `#!/bin/sh\ntouch "${marker}"\n`,
    );
    chmodSync(command, 0o700);
    process.env.PATH = binDir;
    stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("Grok auth discovery", () => {
  it("continues past expired entries to use later valid credentials", async () => {
    writeAuth({
      expired: {
        key: "expired-key",
        expires_at: "2020-01-01T00:00:00.000Z",
      },
      valid: {
        key: "valid-key",
        email: "person@example.invalid",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer valid-key" }),
    });
  });

  it("continues after a rejected valid session to a later live session", async () => {
    writeAuth({
      rejected_session_fixture: {
        key: "rejected-session-token-fixture",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
      live_session_fixture: {
        key: "live-session-token-fixture",
        email: "live@example.invalid",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>)
        ?.Authorization;
      return authorization === "Bearer rejected-session-token-fixture"
        ? grpcResponse(new Uint8Array(), { status: 403 })
        : grpcResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      source: "web",
      account: { email: "live@example.invalid" },
      state: { status: "fresh", stale: false, authStatus: "usable" },
      attempts: [
        { source: "web", status: "success" },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.state.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("session-token-fixture");
  });

  it("prefers session-scoped auth over API-key entries", async () => {
    writeAuth({
      "https://api.x.ai/v1": {
        key: "api-key",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
      "https://accounts.x.ai/sign-in": {
        key: "session-key",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = stubSuccessfulFetch();

    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: false });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer session-key" }),
    });
  });

  it("uses OIDC auth records scoped to auth.x.ai", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "oidc-session-key",
        auth_mode: "oidc",
        email: "person@example.invalid",
        team_id: "team_fixture",
        expires_at: "2035-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.account).toMatchObject({
      email: "person@example.invalid",
      organization: "team_fixture",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer oidc-session-key",
      }),
    });
  });

  it("keeps official Grok Build OAuth authenticated when consumer quota is not exposed", async () => {
    writeAuth({
      "https://auth.x.ai::official-cli-fixture": {
        key: "official-build-oauth-token-fixture",
        auth_mode: "oidc",
        expires_at: "2035-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    const auth = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    expect(auth.sources[0]).toMatchObject({
      source: "auth-json",
      status: "available",
    });

    const fetchMock = vi.fn(async (url: string) =>
      url === GROK_BUILD_MODELS_URL
        ? new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : grpcResponse(new Uint8Array(), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: {
        status: "unavailable",
        authStatus: "usable",
        error: "Grok model access available; quota unavailable",
      },
      attempts: [
        {
          source: "web",
          status: "skipped",
          error: "model_auth_probe_live",
          credentialPresent: true,
        },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CONSUMER_QUOTA_URL,
      GROK_BUILD_MODELS_URL,
    ]);
    const modelRequest = fetchMock.mock.calls[1]?.[1] as
      | RequestInit
      | undefined;
    expect(modelRequest).toMatchObject({
      headers: {
        Authorization: "Bearer official-build-oauth-token-fixture",
        Accept: "application/json",
      },
    });
    expect(modelRequest?.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(
      "official-build-oauth-token-fixture",
    );
    expect(JSON.stringify(result)).not.toContain("fixture-refresh-token");
  });

  it("keeps official Grok Build OAuth usable when its model probe is rate limited", async () => {
    writeAuth({
      "https://auth.x.ai::official-cli-fixture": {
        key: "official-build-oauth-token-fixture",
        authMode: "oidc",
        expiresAt: "2035-01-01T00:00:00.000Z",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === GROK_BUILD_MODELS_URL
          ? new Response(undefined, {
              status: 429,
              headers: { "retry-after": "60" },
            })
          : grpcResponse(new Uint8Array(), { status: 403 }),
      ),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "rate_limited",
      authStatus: "usable",
      error: "Grok model access probe rate limited",
    });
    expect(result.state.retryAfter).toBeDefined();
    expect(result.state.status).not.toBe("auth_required");
    expect(JSON.stringify(result)).not.toContain(
      "official-build-oauth-token-fixture",
    );
  });

  it("does not use API-key auth entries", async () => {
    writeAuth({
      "https://api.x.ai/v1": {
        key: "api-key",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("auth_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads auth.json under GROK_HOME without an explicit path", async () => {
    delete process.env.GROK_AUTH_JSON;
    writeAuth(
      {
        current: {
          key: "home-key",
          expires_at: "2035-01-01T00:00:00.000Z",
        },
      },
      join(process.env.GROK_HOME!, "auth.json"),
    );
    const fetchMock = stubSuccessfulFetch();

    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: false });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer home-key" }),
    });
  });

  it("reads GROK_AUTH_PATH before GROK_HOME", async () => {
    delete process.env.GROK_AUTH_JSON;
    process.env.GROK_AUTH_PATH = join(tempDir!, "official-auth.json");
    writeAuth(
      {
        current: {
          key: "path-key",
          expires_at: "2035-01-01T00:00:00.000Z",
        },
      },
      process.env.GROK_AUTH_PATH,
    );
    writeAuth(
      {
        current: {
          key: "home-key",
          expires_at: "2035-01-01T00:00:00.000Z",
        },
      },
      join(process.env.GROK_HOME!, "auth.json"),
    );
    const fetchMock = stubSuccessfulFetch();

    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: false });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer path-key" }),
    });
  });

  it("reads inline GROK_AUTH before file fallbacks", async () => {
    delete process.env.GROK_AUTH_JSON;
    process.env.GROK_AUTH = JSON.stringify({
      "https://accounts.x.ai/sign-in": {
        key: "inline-key",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = stubSuccessfulFetch();

    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: false });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer inline-key" }),
    });
  });
});

describe("Grok expired access-token classification", () => {
  it("probes a stored-expired OIDC session and keeps access-token expired only on definitive rejection", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        email: "person@example.invalid",
        team_id: "team_fixture",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    const fetchMock = vi.fn(async () =>
      grpcResponse(new Uint8Array(), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const binDir = join(tempDir!, "bin");
    const marker = join(tempDir!, "grok-launched");
    mkdirSync(binDir, { recursive: true });
    const command =
      process.platform === "win32"
        ? join(binDir, "grok.CMD")
        : join(binDir, "grok");
    writeFileSync(
      command,
      process.platform === "win32"
        ? `@echo off\r\ntype nul > "${marker}"\r\n`
        : `#!/bin/sh\ntouch "${marker}"\n`,
    );
    chmodSync(command, 0o700);
    process.env.PATH = binDir;
    const authPath = process.env.GROK_AUTH_JSON!;
    const before = readFileSync(authPath);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: {
        status: "unavailable",
        stale: false,
        error: "Grok access token expired",
        authStatus: "expired_refreshable",
      },
      attempts: [
        {
          source: "web",
          status: "failed",
          error: "Grok sign-in required",
        },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(result.state.error).not.toMatch(/sign-in/i);
    expect(result.state.status).not.toBe("auth_required");
    // Shared helper still maps the phrase to auth_required; Grok owns soft expiry.
    expect(statusFromError(result.state.error!)).toBe("auth_required");
    // Stored expiry is advisory: first test consumer quota, then distinguish
    // its audience rejection from official Grok Build model auth rejection.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CONSUMER_QUOTA_URL,
      GROK_BUILD_MODELS_URL,
    ]);
    for (const [, probeInit] of fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >) {
      expect((probeInit.headers as Record<string, string>).Authorization).toBe(
        "Bearer expired-access-token",
      );
    }
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(authPath)).toEqual(before);
  });

  it("returns fresh consumer quota when the stored-expired session token is empirically live", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        email: "person@example.invalid",
        team_id: "team_fixture",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "web",
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
      },
      attempts: [
        { source: "web", status: "success" },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.state.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("expired-access-token");
    expect(JSON.stringify(result)).not.toContain("fixture-refresh-token");
  });

  it("keeps a stored-expired official session usable when the Grok Build catalog accepts it", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === GROK_BUILD_MODELS_URL
          ? new Response(JSON.stringify({ object: "list", data: [] }), {
              status: 200,
            })
          : grpcResponse(new Uint8Array(), { status: 403 }),
      ),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "unavailable",
      authStatus: "usable",
      error: "Grok model access available; quota unavailable",
    });
    expect(result.state.reason).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("expired-access-token");
    expect(JSON.stringify(result)).not.toContain("fixture-refresh-token");
  });

  it("tries each stored-expired session until one returns fresh quota", async () => {
    writeAuth({
      rejected_expired_session_fixture: {
        key: "rejected-expired-session-token-fixture",
        expires_at: "2020-01-01T00:00:00.000Z",
      },
      live_expired_session_fixture: {
        key: "live-expired-session-token-fixture",
        email: "live@example.invalid",
        expires_at: "2021-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>)
        ?.Authorization;
      return authorization === "Bearer rejected-expired-session-token-fixture"
        ? grpcResponse(new Uint8Array(), { status: 403 })
        : grpcResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      source: "web",
      account: { email: "live@example.invalid" },
      state: { status: "fresh", stale: false, authStatus: "usable" },
      attempts: [
        { source: "web", status: "success" },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(result.windows.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("session-token-fixture");
  });

  it("keeps true sign-in required when a rejected expired session has no refresh token", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn(async () =>
      grpcResponse(new Uint8Array(), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "Grok sign-in required",
        authStatus: "unusable",
      },
      attempts: [
        {
          source: "web",
          status: "failed",
          error: "Grok sign-in required",
        },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps true sign-in required when auth is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "Grok sign-in required",
        authStatus: "unusable",
      },
      attempts: [
        {
          source: "auth-json",
          status: "skipped",
          error: "credentials_missing",
        },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains expired-token classification on stale web cache fallback after probe rejection", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writeCachedProviders([cachedGrok("web")]);
    const fetchMock = vi.fn(async () =>
      grpcResponse(new Uint8Array(), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "cache",
      windows: [{ id: "credits", percentRemaining: 80 }],
      state: {
        status: "stale",
        stale: true,
        error: "Grok access token expired",
        authStatus: "expired_refreshable",
        sourcesTried: ["web", "pi:xai", "cache"],
      },
      attempts: [
        {
          source: "web",
          status: "failed",
          error: "Grok sign-in required",
        },
        {
          source: "pi:xai",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    });
    expect(result.state.error).not.toMatch(/sign-in/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exposes credentials_expired reason in default JSON without --full", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writeCachedProviders([cachedGrok("web")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grpcResponse(new Uint8Array(), { status: 403 })),
    );

    const jsonText = await captureCli(["--provider", "grok", "--json"]);
    const json = JSON.parse(jsonText) as QuotaAxiResponse;
    const grok = json.providers[0];

    expect(grok).toMatchObject({
      provider: "grok",
      state: {
        status: "stale",
        stale: true,
        error: "Grok access token expired",
        authStatus: "expired_refreshable",
        reason: "credentials_expired",
        remedyCommand: "grok",
      },
    });
    expect(grok.attempts).toBeUndefined();
    // `source` is a default-tier demotion, not a loss: `--full` still has it.
    expect(grok.source).toBeUndefined();
    expect(grok.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [
        {
          scope: "all_products",
          status: "unknown",
          boundedBy: ["credits"],
        },
      ],
    });
    expect(
      grok.quotaSemantics?.effectiveAvailability[0]?.effectivePercentRemaining,
    ).toBeUndefined();
    expect(json.help).toContain(
      "Tell your user: run `grok` once so the Grok CLI can refresh its own session token. quota-axi delegates that refresh to the Grok CLI and never rotates credentials itself.",
    );

    const fullText = await captureCli([
      "--provider",
      "grok",
      "--json",
      "--full",
    ]);
    const full = JSON.parse(fullText) as QuotaAxiResponse;
    expect(full.providers[0]?.source).toBe("cache");
    expect(full.providers[0]?.attempts).toEqual([
      {
        source: "web",
        status: "failed",
        error: "Grok sign-in required",
      },
      {
        source: "pi:xai",
        status: "skipped",
        error: "credentials_missing",
      },
    ]);

    // The remedy rides the provider's `attention[]` row; soft expiry keeps its
    // positive auth fact because the scope produces no `quota[]` row.
    const toon = await captureCli(["--provider", "grok"]);
    expect(toon).toContain(
      'grok,all,stale,"last refreshed 2026-07-20T00:00:00.000Z · Grok access token expired · reason credentials_expired (auth expired_refreshable)",grok',
    );
    expect(toon).toContain("grok,all_products,headroom_unknown,credits,none");
  });
});

describe("Grok dual-source CLI and Pi xAI usability", () => {
  it("fetches grok.com consumer credits with a valid Pi xAI oauth token", async () => {
    writeValidPiXaiOauth();
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.state.authStatus).toBe("usable");
    expect(result.source).toBe("web");
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.attempts).toEqual([
      {
        source: "auth-json",
        status: "skipped",
        error: "credentials_missing",
      },
      {
        source: "pi:xai",
        status: "success",
        credentialPresent: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("GetGrokCreditsConfig");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer pi-xai-access-token-fixture",
    );
    expect(JSON.stringify(result)).not.toContain("pi-xai-access-token-fixture");
    expect(JSON.stringify(result)).not.toContain(
      "pi-xai-refresh-token-fixture",
    );
  });

  it("reports a definitively rejected Pi oauth token as signed out", async () => {
    writeValidPiXaiOauth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grpcResponse(new Uint8Array(), { status: 403 })),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "auth_required",
      authStatus: "unusable",
      error: "Grok sign-in required",
    });
    expect(result.attempts).toContainEqual({
      source: "pi:xai",
      status: "failed",
      error: "Grok sign-in required",
      credentialPresent: true,
    });
  });

  it("keeps Pi xAI OAuth authenticated when consumer quota is not exposed", async () => {
    writeValidPiXaiOauth();
    const fetchMock = vi.fn(async (url: string) =>
      url === XAI_MODELS_URL
        ? new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
          })
        : grpcResponse(new Uint8Array(), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      windows: [],
      state: {
        status: "unavailable",
        authStatus: "usable",
        error: "Grok model access available; quota unavailable",
      },
      attempts: [
        {
          source: "auth-json",
          status: "skipped",
          error: "credentials_missing",
        },
        {
          source: "pi:xai",
          status: "skipped",
          error: "model_auth_probe_live",
          credentialPresent: true,
        },
      ],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CONSUMER_QUOTA_URL,
      XAI_MODELS_URL,
    ]);
    expect(JSON.stringify(result)).not.toContain("pi-xai-access-token-fixture");
  });

  it("preserves usable auth for a transient valid Pi oauth failure", async () => {
    writeValidPiXaiOauth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.authStatus).toBe("usable");
    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("Grok quota unavailable");
  });

  it("tries Pi oauth after a transient CLI quota failure", async () => {
    writeValidAuth("cli-transient-token");
    writeValidPiXaiOauth();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = (
        init?.headers as Record<string, string> | undefined
      )?.Authorization;
      if (authorization === "Bearer cli-transient-token") {
        throw new TypeError("network unavailable");
      }
      return grpcResponse(consumerPayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("web");
    expect(result.attempts).toEqual([
      { source: "web", status: "failed", error: "Grok quota unavailable" },
      { source: "pi:xai", status: "success", credentialPresent: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tries a stored-expired CLI bearer independently of transient Pi oauth", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "accepted-expired-cli-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writeValidPiXaiOauth();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = (
        init?.headers as Record<string, string> | undefined
      )?.Authorization;
      if (authorization === "Bearer pi-xai-access-token-fixture") {
        throw new TypeError("network unavailable");
      }
      return grpcResponse(consumerPayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("web");
    expect(result.attempts).toContainEqual({
      source: "web",
      status: "success",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats valid Pi xAI api_key as usable when Grok CLI auth is expired refreshable", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writePiXaiAuth({
      xai: {
        type: "api_key",
        key: "pi-xai-api-key-fixture-value",
      },
    });
    const fetchMock = vi.fn(async () =>
      grpcResponse(new Uint8Array(), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.authStatus).toBe("usable");
    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe(
      "Grok model access available; quota unavailable",
    );
    expect(result.state.reason).toBeUndefined();
    expect(result.attempts).toEqual([
      {
        source: "web",
        status: "failed",
        error: "Grok sign-in required",
      },
      {
        source: "pi:xai",
        status: "skipped",
        error: "model_auth_only",
        credentialPresent: true,
      },
    ]);
    // The official OIDC session is tested against consumer quota and the
    // Grok Build model catalog; the Pi api_key remains local-only.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(
      "pi-xai-api-key-fixture-value",
    );
    expect(JSON.stringify(result)).not.toContain("fixture-refresh-token");
  });

  it("emits grok CLI refresh advice for a refreshable CLI session whether Pi is present or hidden", async () => {
    const grokRefreshHelp =
      "Tell your user: run `grok` once so the Grok CLI can refresh its own session token. quota-axi delegates that refresh to the Grok CLI and never rotates credentials itself.";

    async function cliAdvice(pi: "present" | "hidden"): Promise<{
      grok: QuotaAxiResponse["providers"][number] | undefined;
      help: string[] | undefined;
      toon: string;
    }> {
      writeAuth({
        "https://auth.x.ai::fixture-client": {
          key: "expired-access-token",
          auth_mode: "oidc",
          expires_at: "2020-01-01T00:00:00.000Z",
          refresh_token: "fixture-refresh-token",
        },
      });
      const piAuthPath = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
      if (pi === "present") {
        writePiXaiAuth({
          xai: {
            type: "api_key",
            key: "pi-xai-api-key-fixture-value",
          },
        });
      } else if (existsSync(piAuthPath)) {
        rmSync(piAuthPath);
      }
      writeCachedProviders([cachedGrok("web")]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => grpcResponse(new Uint8Array(), { status: 403 })),
      );

      const json = JSON.parse(
        await captureCli(["--provider", "grok", "--json"]),
      ) as QuotaAxiResponse;
      return {
        grok: json.providers[0],
        help: json.help,
        toon: await captureCli(["--provider", "grok"]),
      };
    }

    const hidden = await cliAdvice("hidden");
    const present = await cliAdvice("present");

    expect(hidden.grok?.state.authStatus).toBe("expired_refreshable");
    expect(present.grok?.state.authStatus).toBe("usable");
    for (const result of [hidden, present]) {
      expect(result.grok?.state.status).toBe("stale");
      expect(result.grok?.state.reason).toBe("credentials_expired");
      expect(result.grok?.state.remedyCommand).toBe("grok");
      expect(result.help).toContain(grokRefreshHelp);
      expect(result.toon).toContain(
        `grok,all,stale,"last refreshed 2026-07-20T00:00:00.000Z · ${result.grok?.state.error} · reason credentials_expired (auth ${result.grok?.state.authStatus})",grok`,
      );
    }
  });

  it("does not emit grok refresh advice when Pi oauth fetches grok.com credits", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writeValidPiXaiOauth();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = (
        init?.headers as Record<string, string> | undefined
      )?.Authorization;
      return authorization === "Bearer pi-xai-access-token-fixture"
        ? grpcResponse(consumerPayload())
        : grpcResponse(new Uint8Array(), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const json = JSON.parse(
      await captureCli(["--provider", "grok", "--json"]),
    ) as QuotaAxiResponse;
    const grok = json.providers[0];

    expect(grok?.state.status).toBe("fresh");
    expect(grok?.state.authStatus).toBe("usable");
    expect(grok?.state.remedyCommand).toBeUndefined();
    expect(json.help?.join("\n") ?? "").not.toContain("open the Grok CLI");
  });

  it("emits grok refresh advice when neither the CLI session nor Pi oauth can fetch credits", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writeValidPiXaiOauth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grpcResponse(new Uint8Array(), { status: 403 })),
    );

    const json = JSON.parse(
      await captureCli(["--provider", "grok", "--json"]),
    ) as QuotaAxiResponse;
    const grok = json.providers[0];

    expect(grok?.state.status).not.toBe("fresh");
    expect(grok?.state.remedyCommand).toBe("grok");
    expect(json.help).toContain(
      "Tell your user: run `grok` once so the Grok CLI can refresh its own session token. quota-axi delegates that refresh to the Grok CLI and never rotates credentials itself.",
    );
  });

  it("does not emit Grok refresh advice for a transient CLI failure", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writePiXaiAuth({
      xai: {
        type: "api_key",
        key: "pi-xai-api-key-fixture-value",
      },
    });
    writeCachedProviders([cachedGrok("web")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const json = JSON.parse(
      await captureCli(["--provider", "grok", "--json"]),
    ) as QuotaAxiResponse;
    const grok = json.providers[0];

    expect(grok?.state.status).toBe("stale");
    expect(grok?.state.authStatus).toBe("usable");
    expect(grok?.state.reason).toBeUndefined();
    expect(grok?.state.remedyCommand).toBeUndefined();
    expect(json.help?.join("\n") ?? "").not.toContain("open the Grok CLI");
  });

  it("does not combine rejection and refreshability across CLI candidates", async () => {
    writeAuth({
      "https://auth.x.ai::rejected-client": {
        key: "rejected-access-token",
        auth_mode: "oidc",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      "https://auth.x.ai::transient-client": {
        key: "transient-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writePiXaiAuth({
      xai: {
        type: "api_key",
        key: "pi-xai-api-key-fixture-value",
      },
    });
    writeCachedProviders([cachedGrok("web")]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(grpcResponse(new Uint8Array(), { status: 403 }))
        .mockRejectedValueOnce(new TypeError("fetch failed")),
    );

    const json = JSON.parse(
      await captureCli(["--provider", "grok", "--json"]),
    ) as QuotaAxiResponse;
    const grok = json.providers[0];

    expect(grok?.state.status).toBe("stale");
    expect(grok?.state.authStatus).toBe("usable");
    expect(grok?.state.reason).toBeUndefined();
    expect(grok?.state.remedyCommand).toBeUndefined();
    expect(json.help?.join("\n") ?? "").not.toContain("open the Grok CLI");
  });

  it("reports Pi oauth as unneeded when the CLI bearer succeeds", async () => {
    writeValidAuth("cli-only-key");
    writeValidPiXaiOauth();
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.attempts).toEqual([
      { source: "web", status: "success" },
      {
        source: "pi:xai",
        status: "skipped",
        error: "quota_not_needed",
        credentialPresent: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps Grok CLI consumer quota when Pi xAI auth is missing", async () => {
    writeValidAuth("cli-only-key");
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.state.authStatus).toBe("usable");
    expect(result.source).toBe("web");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.attempts).toEqual([
      { source: "web", status: "success" },
      {
        source: "pi:xai",
        status: "skipped",
        error: "credentials_missing",
      },
    ]);
  });

  it("classifies both sources expired refreshable without claiming sign-out", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writePiXaiAuth({
      xai: {
        type: "oauth",
        access: "expired-pi-access",
        refresh: "expired-pi-refresh",
        expires: Date.now() - 60_000,
      },
    });
    vi.stubGlobal("fetch", vi.fn());

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      state: {
        status: "unavailable",
        error: "Grok access token expired",
        authStatus: "expired_refreshable",
      },
    });
    expect(result.state.status).not.toBe("auth_required");
  });

  it("fetches grok.com consumer credits with a stored-expired Pi xAI oauth token that is still accepted", async () => {
    writePiXaiAuth({
      xai: {
        type: "oauth",
        access: "expired-pi-access",
        refresh: "expired-pi-refresh",
        expires: Date.now() - 60_000,
      },
    });
    const fetchMock = stubSuccessfulFetch();

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.state.authStatus).toBe("usable");
    expect(result.source).toBe("web");
    expect(result.attempts).toEqual([
      {
        source: "auth-json",
        status: "skipped",
        error: "credentials_missing",
      },
      {
        source: "pi:xai",
        status: "success",
        credentialPresent: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("GetGrokCreditsConfig");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer expired-pi-access",
    );
    expect(JSON.stringify(result)).not.toContain("expired-pi-access");
    expect(JSON.stringify(result)).not.toContain("expired-pi-refresh");
  });

  it("keeps stored-expired Pi OAuth usable when the xAI catalog accepts it", async () => {
    writePiXaiAuth({
      xai: {
        type: "oauth",
        access: "expired-pi-access",
        refresh: "expired-pi-refresh",
        expires: Date.now() - 60_000,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === XAI_MODELS_URL
          ? new Response(JSON.stringify({ object: "list", data: [] }), {
              status: 200,
            })
          : grpcResponse(new Uint8Array(), { status: 403 }),
      ),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "unavailable",
      authStatus: "usable",
      error: "Grok model access available; quota unavailable",
    });
    expect(result.state.reason).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("expired-pi-access");
    expect(JSON.stringify(result)).not.toContain("expired-pi-refresh");
  });

  it("keeps Pi expiry classification when grok.com rejects the stored-expired Pi token", async () => {
    writePiXaiAuth({
      xai: {
        type: "oauth",
        access: "expired-pi-access",
        refresh: "expired-pi-refresh",
        expires: Date.now() - 60_000,
      },
    });
    const fetchMock = vi.fn(async () =>
      grpcResponse(new Uint8Array(), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "unavailable",
      error: "Pi xAI access token expired",
      authStatus: "expired_refreshable",
    });
    expect(result.attempts).toEqual([
      {
        source: "auth-json",
        status: "skipped",
        error: "credentials_missing",
      },
      {
        source: "pi:xai",
        status: "failed",
        error: "Grok sign-in required",
        credentialPresent: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CONSUMER_QUOTA_URL,
      XAI_MODELS_URL,
    ]);
    expect(JSON.stringify(result)).not.toContain("expired-pi-access");
  });

  it("fetches grok.com consumer credits with the expired Pi oauth token after the CLI session is rejected", async () => {
    writeAuth({
      "https://auth.x.ai::fixture-client": {
        key: "expired-access-token",
        auth_mode: "oidc",
        expires_at: "2020-01-01T00:00:00.000Z",
        refresh_token: "fixture-refresh-token",
      },
    });
    writePiXaiAuth({
      xai: {
        type: "oauth",
        access: "expired-pi-access",
        refresh: "expired-pi-refresh",
        expires: Date.now() - 60_000,
      },
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = (
        init?.headers as Record<string, string> | undefined
      )?.Authorization;
      return authorization === "Bearer expired-pi-access"
        ? grpcResponse(consumerPayload())
        : grpcResponse(new Uint8Array(), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(result.state.authStatus).toBe("usable");
    expect(result.source).toBe("web");
    expect(result.attempts).toEqual([
      {
        source: "web",
        status: "failed",
        error: "Grok sign-in required",
      },
      {
        source: "pi:xai",
        status: "success",
        credentialPresent: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CONSUMER_QUOTA_URL,
      GROK_BUILD_MODELS_URL,
      CONSUMER_QUOTA_URL,
    ]);
    expect(JSON.stringify(result)).not.toContain("expired-access-token");
    expect(JSON.stringify(result)).not.toContain("expired-pi-access");
  });

  it("preserves malformed Pi auth JSON as a resolution error", async () => {
    const piAuthPath = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
    mkdirSync(dirname(piAuthPath), { recursive: true });
    writeFileSync(piAuthPath, "{not-json");
    vi.stubGlobal("fetch", vi.fn());

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      authStatus: "unusable",
      status: "error",
      error: "Grok Pi credential resolution failed",
    });
    expect(result.attempts).toContainEqual({
      source: "pi:xai",
      status: "failed",
      error: "credential_resolution_failed",
    });
  });

  it("does not treat an unusable Pi refresh reference as refreshable", async () => {
    writePiXaiAuth({
      xai: {
        type: "oauth",
        access: "expired-pi-access",
        refresh: "$XAI_REFRESH_TOKEN",
        expires: Date.now() - 60_000,
      },
    });
    vi.stubGlobal("fetch", vi.fn());

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "auth_required",
      error: "Grok sign-in required",
      authStatus: "unusable",
    });
    expect(result.state.reason).toBeUndefined();
    expect(result.state.remedyCommand).toBeUndefined();
  });

  it("preserves Pi credential read failures without claiming sign-out", async () => {
    const adapter = createGrokAdapter({
      piXaiBroker: {
        resolve: async () => ({ status: "error" }),
        inspect: async () => ({
          status: "error",
          error: "credential_resolution_failed",
        }),
      },
    });

    const result = await adapter.fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const auth = await adapter.inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      state: {
        status: "error",
        error: "Grok Pi credential resolution failed",
        authStatus: "unusable",
      },
      attempts: [
        {
          source: "auth-json",
          status: "skipped",
          error: "credentials_missing",
        },
        {
          source: "pi:xai",
          status: "failed",
          error: "credential_resolution_failed",
        },
      ],
    });
    expect(result.state.error).not.toMatch(/sign-in/i);
    expect(auth.sources[1]).toEqual({
      source: "pi:xai",
      status: "error",
      error: "credential_resolution_failed",
    });
  });

  it("keeps Grok usable when Pi credential resolution fails", async () => {
    writeValidAuth();
    stubSuccessfulFetch();
    const adapter = createGrokAdapter({
      piXaiBroker: {
        resolve: async () => ({ status: "error" }),
        inspect: async () => ({
          status: "error",
          error: "credential_resolution_failed",
        }),
      },
    });

    const result = await adapter.fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
    });
    expect(result.attempts).toContainEqual({
      source: "pi:xai",
      status: "failed",
      error: "credential_resolution_failed",
    });
  });

  it("omits the Grok CLI remedy for Pi-only refreshable expiry", async () => {
    writePiXaiAuth({
      xai: {
        type: "oauth",
        access: "expired-pi-access",
        refresh: "expired-pi-refresh",
        expires: Date.now() - 60_000,
      },
    });
    vi.stubGlobal("fetch", vi.fn());

    const jsonText = await captureCli(["--provider", "grok", "--json"]);
    const json = JSON.parse(jsonText) as QuotaAxiResponse;
    const grok = json.providers[0];

    expect(grok).toMatchObject({
      state: {
        status: "unavailable",
        error: "Pi xAI access token expired",
        authStatus: "expired_refreshable",
      },
    });
    expect(grok?.state.reason).toBeUndefined();
    expect(grok?.state.remedyCommand).toBeUndefined();
    expect(json.help?.join("\n") ?? "").not.toContain("open the Grok CLI");
  });

  it("keeps transient consumer failures distinct from auth rejection when CLI auth is valid", async () => {
    writeValidAuth();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.authStatus).toBe("usable");
    expect(result.state.status).not.toBe("auth_required");
    expect(result.state.error).not.toMatch(/sign-in/i);
    expect(result.attempts?.[0]).toMatchObject({
      source: "web",
      status: "failed",
    });
  });

  it("exposes usable model auth without consumer windows in compact and JSON output", async () => {
    writePiXaiAuth({
      xai: {
        type: "api_key",
        key: "pi-xai-api-key-fixture-value",
      },
    });
    vi.stubGlobal("fetch", vi.fn());

    const jsonText = await captureCli(["--provider", "grok", "--json"]);
    const json = JSON.parse(jsonText) as QuotaAxiResponse;
    expect(json.providers[0]).toMatchObject({
      state: {
        status: "unavailable",
        authStatus: "usable",
        error: "Grok model access available; quota unavailable",
      },
    });
    expect(json.providers[0]?.state.reason).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("pi-xai-api-key-fixture-value");

    // A provider with no quota row still states its positive auth fact.
    const toon = await captureCli(["--provider", "grok"]);
    expect(toon).toContain(
      "grok,all,unavailable,Grok model access available; quota unavailable (auth usable),none",
    );
    expect(toon).not.toContain("credentials_expired");
    expect(toon).not.toContain("pi-xai-api-key-fixture-value");
  });

  it("reports both auth sources from inspectAuth", async () => {
    writeValidAuth();
    writeValidPiXaiOauth();
    const report = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    expect(report.sources).toEqual([
      {
        source: "auth-json",
        path: process.env.GROK_AUTH_JSON,
        status: "available",
      },
      {
        source: "pi:xai",
        status: "available",
      },
    ]);
  });
});

describe("Grok cache provenance", () => {
  it("rejects a legacy CLI-proxy cache entry after exact-source failure", async () => {
    writeValidAuth();
    writeCachedProviders([cachedGrok("api")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", stale: false },
    });
  });

  it("uses a same-source cached snapshot as stale fallback", async () => {
    writeValidAuth();
    writeCachedProviders([cachedGrok("web")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result).toMatchObject({
      source: "cache",
      windows: [{ percentUsed: 20, percentRemaining: 80 }],
      state: {
        status: "stale",
        stale: true,
        sourcesTried: ["web", "pi:xai", "cache"],
      },
    });
  });
});

describe("Grok CLI rendering regression", () => {
  it("renders exact-source proto3 zero numerically in JSON and TOON", async () => {
    writeValidAuth();
    const payload = consumerPayload({
      includePercent: false,
      products: [],
      prepaid: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grpcResponse(payload)),
    );

    const jsonText = await captureCli([
      "--provider",
      "grok",
      "--json",
      "--full",
    ]);
    const json = JSON.parse(jsonText) as QuotaAxiResponse;
    expect(json.providers[0]).toMatchObject({
      provider: "grok",
      source: "web",
      windows: [
        {
          id: "credits",
          percentUsed: 0,
          percentRemaining: 100,
        },
      ],
    });

    const toon = await captureCli(["--provider", "grok", "--full"]);
    expect(toon).toContain("grok,credits,credits,100");
    expect(toon).not.toContain("grok,credits,credits,unknown");
    expect(await captureCli(["--provider", "grok"])).toContain(
      "grok,all_products,100",
    );
  });
});

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type StubDelegate = {
  /** Absolute path the stub writes one line to on each invocation. */
  invocationLog: string;
  invocationCount(): number;
};

/**
 * Install a fake `grok` on PATH. It records that it ran and, when asked to,
 * rewrites the store the way the real CLI does after rotating a session: a new
 * access token with a future expiry, beside a new refresh token. Nothing reads
 * its stdout, so it also prints noise the way the real CLI does.
 */
function stubGrokCli(
  options: {
    rotateTo?: string;
    rotatedExpiresAt?: string;
    clearStore?: boolean;
  } = {},
): StubDelegate {
  const binDir = join(tempDir!, "stub-bin");
  mkdirSync(binDir, { recursive: true });
  const invocationLog = join(tempDir!, "grok-invocations.log");
  const authFile = join(process.env.GROK_HOME!, "auth.json");
  const rewrite = options.clearStore
    ? `echo '{}' > ${JSON.stringify(authFile)}`
    : options.rotateTo
      ? `echo ${shellSingleQuote(
          JSON.stringify({
            "https://auth.x.ai::client": {
              key: options.rotateTo,
              auth_mode: "oidc",
              oidc_issuer: "https://auth.x.ai",
              // Opaque presence marker: quota-axi must not inspect this field.
              refresh_token: true,
              expires_at:
                options.rotatedExpiresAt ?? "2035-01-01T00:00:00.000Z",
            },
          }),
        )} > ${JSON.stringify(authFile)}`
      : "";
  // Only shell builtins: the delegate runs with the PATH quota-axi hands it,
  // which in these tests holds nothing but the stub itself.
  writeFileSync(
    join(binDir, "grok"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(invocationLog)}`,
      'echo "Available models:"',
      rewrite,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "grok"), 0o755);
  process.env.PATH = binDir;
  return {
    invocationLog,
    invocationCount: () =>
      existsSync(invocationLog)
        ? readFileSync(invocationLog, "utf8").trimEnd().split("\n").length
        : 0,
  };
}

/** Point the adapter at the store the Grok CLI itself owns. */
function useCliOwnedStore(): string {
  delete process.env.GROK_AUTH_JSON;
  const authFile = join(process.env.GROK_HOME!, "auth.json");
  mkdirSync(dirname(authFile), { recursive: true });
  return authFile;
}

function writeExpiredCliAuth(key: string, refreshable = true): void {
  writeAuth(
    {
      "https://auth.x.ai::client": {
        key,
        auth_mode: "oidc",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2020-01-01T00:00:00.000Z",
        // Deliberately not a token fixture. Only field presence is observable.
        ...(refreshable ? { refresh_token: true } : {}),
      },
    },
    useCliOwnedStore(),
  );
}

/** 401 for the stale bearer, fresh consumer quota for the rotated one. */
function stubBearerAwareFetch(liveKey: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    return headers.Authorization === `Bearer ${liveKey}`
      ? grpcResponse()
      : new Response(new Uint8Array(), { status: 401 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Grok delegated credential refresh", () => {
  it("recovers live quota by letting the Grok CLI rotate its own session", async () => {
    writeExpiredCliAuth("stale-key");
    const delegate = stubGrokCli({ rotateTo: "rotated-key" });
    const fetchMock = stubBearerAwareFetch("rotated-key");

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: true,
    });

    expect(result).toMatchObject({
      source: "web",
      state: { status: "fresh", stale: false },
    });
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.state.sourcesTried).toContain("grok-cli-refresh");
    expect(result.attempts?.slice(0, 3)).toEqual([
      {
        source: "web",
        status: "failed",
        error: "Grok sign-in required",
      },
      { source: "grok-cli-refresh", status: "success" },
      { source: "web", status: "success" },
    ]);
    // The vendor CLI ran exactly once, with its own smallest read-only command.
    expect(delegate.invocationCount()).toBe(1);
    expect(readFileSync(delegate.invocationLog, "utf8").trim()).toBe("models");
    // Rotation happened in the CLI, not here: quota-axi only made read-only
    // consumer-quota/model-catalog requests with bearers it read from stores.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CONSUMER_QUOTA_URL,
      GROK_BUILD_MODELS_URL,
      CONSUMER_QUOTA_URL,
    ]);
  });

  it("probes a rewritten bearer even when its expiry metadata remains expired", async () => {
    writeExpiredCliAuth("stale-key");
    stubGrokCli({
      rotateTo: "rotated-key",
      rotatedExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    const fetchMock = stubBearerAwareFetch("rotated-key");

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: true,
    });

    expect(result).toMatchObject({
      source: "web",
      state: { status: "fresh", authStatus: "usable" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("adopts a store the Grok CLI cleared after rejecting the session", async () => {
    writeExpiredCliAuth("stale-key");
    stubGrokCli({ clearStore: true });
    const fetchMock = stubBearerAwareFetch("unused-key");

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: true,
    });

    expect(result.state).toMatchObject({
      status: "auth_required",
      authStatus: "unusable",
      error: "Grok sign-in required",
    });
    expect(result.attempts?.slice(0, 3)).toEqual([
      {
        source: "web",
        status: "failed",
        error: "Grok sign-in required",
      },
      { source: "grok-cli-refresh", status: "success" },
      {
        source: "auth-json",
        status: "skipped",
        error: "credentials_invalid",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never performs a refresh-token request itself", async () => {
    writeExpiredCliAuth("stale-key");
    stubGrokCli({ rotateTo: "rotated-key" });
    const fetchMock = stubBearerAwareFetch("rotated-key");

    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: true });

    for (const [url, init] of fetchMock.mock.calls as Array<
      [string, RequestInit]
    >) {
      const request = JSON.stringify({
        url,
        headers: init.headers,
        body:
          init.body === undefined ? null : Array.from(init.body as Uint8Array),
      });
      expect(request).not.toContain("grant_type");
      expect(url).not.toMatch(/token|oauth|auth\.x\.ai/i);
    }
  });

  it("stays read-only when delegated refresh is turned off", async () => {
    writeExpiredCliAuth("stale-key");
    const delegate = stubGrokCli({ rotateTo: "rotated-key" });
    stubBearerAwareFetch("rotated-key");

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(delegate.invocationCount()).toBe(0);
    expect(result.state.status).not.toBe("fresh");
    expect(result.state.sourcesTried).not.toContain("grok-cli-refresh");
  });

  it("does not delegate for a transient failure", async () => {
    writeExpiredCliAuth("stale-key");
    const delegate = stubGrokCli({ rotateTo: "rotated-key" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(), { status: 500 })),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: true,
    });

    expect(delegate.invocationCount()).toBe(0);
    expect(result.state.sourcesTried).not.toContain("grok-cli-refresh");
  });

  it("does not delegate when the store holds no refresh path", async () => {
    writeExpiredCliAuth("stale-key", false);
    const delegate = stubGrokCli({ rotateTo: "rotated-key" });
    stubBearerAwareFetch("rotated-key");

    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: true });

    expect(delegate.invocationCount()).toBe(0);
  });

  it("does not delegate for a relocated store the Grok CLI would not rewrite", async () => {
    const relocated = join(tempDir!, "relocated-auth.json");
    writeAuth(
      {
        "https://auth.x.ai::client": {
          key: "stale-key",
          auth_mode: "oidc",
          oidc_issuer: "https://auth.x.ai",
          expires_at: "2020-01-01T00:00:00.000Z",
          refresh_token: true,
        },
      },
      relocated,
    );
    process.env.GROK_AUTH_JSON = relocated;
    const delegate = stubGrokCli({ rotateTo: "rotated-key" });
    stubBearerAwareFetch("rotated-key");

    await fetchQuota({ allowKeychainPrompt: false, refreshCredentials: true });

    expect(delegate.invocationCount()).toBe(0);
  });

  it("reports a missing Grok CLI as a skipped refresh instead of failing", async () => {
    writeExpiredCliAuth("stale-key");
    process.env.PATH = join(tempDir!, "empty-bin");
    stubBearerAwareFetch("rotated-key");

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: true,
    });

    expect(result.attempts).toContainEqual({
      source: "grok-cli-refresh",
      status: "skipped",
      error: "refresh_command_not_found",
    });
    expect(result.state.status).not.toBe("fresh");
  });
});

async function captureCli(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath: "quota-axi",
    stdout: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  });
  return chunks.join("");
}
