import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCachedProviders } from "../../src/cache.js";
import { main } from "../../src/cli.js";
import {
  fetchQuota,
  normalizeGrokConsumerPayload,
} from "../../src/providers/grok.js";
import type { ProviderQuota, QuotaAxiResponse } from "../../src/types.js";

const CONSUMER_QUOTA_URL =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const originalGrokAuthJson = process.env.GROK_AUTH_JSON;
const originalGrokAuthPath = process.env.GROK_AUTH_PATH;
const originalGrokAuth = process.env.GROK_AUTH;
const originalGrokHome = process.env.GROK_HOME;
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
        resetsAt: "2026-07-27T20:00:00.000Z",
      },
      {
        id: "product:grok_build",
        label: "Grok Build",
        kind: "credits",
        percentUsed: 33.25,
        percentRemaining: 66.75,
        resetsAt: "2026-07-27T20:00:00.000Z",
      },
      {
        id: "product:chat",
        label: "Chat",
        kind: "credits",
        percentUsed: 100,
        percentRemaining: 0,
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

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      source: "web",
      state: { status: "fresh", sourcesTried: ["web"] },
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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "Grok quota response invalid" },
    });
  });

  it.each([
    [16, "auth_required", "Grok sign-in required"],
    [8, "rate_limited", "Grok quota endpoint rate limited"],
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

      const result = await fetchQuota({ allowKeychainPrompt: false });

      expect(result.state).toMatchObject({ status, error });
      expect(result.state.error).not.toContain("private-provider-diagnostic");
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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    const pending = fetchQuota({ allowKeychainPrompt: false });
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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer valid-key" }),
    });
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

    await fetchQuota({ allowKeychainPrompt: false });

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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

  it("does not use API-key auth entries", async () => {
    writeAuth({
      "https://api.x.ai/v1": {
        key: "api-key",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    await fetchQuota({ allowKeychainPrompt: false });

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

    await fetchQuota({ allowKeychainPrompt: false });

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

    await fetchQuota({ allowKeychainPrompt: false });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer inline-key" }),
    });
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

    const result = await fetchQuota({ allowKeychainPrompt: false });

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

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      source: "cache",
      windows: [{ percentUsed: 20, percentRemaining: 80 }],
      state: {
        status: "stale",
        stale: true,
        sourcesTried: ["web", "cache"],
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

    const jsonText = await captureCli(["--provider", "grok", "--json"]);
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

    const toon = await captureCli(["--provider", "grok"]);
    expect(toon).toContain("grok,credits,credits,100");
    expect(toon).not.toContain("grok,credits,credits,unknown");
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
