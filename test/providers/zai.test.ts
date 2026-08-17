import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createZaiAdapter,
  normalizeZaiPayload,
} from "../../src/providers/zai.js";
import type {
  ZaiCredentialBroker,
  ZaiCredentialInspection,
  ZaiCredentialResolution,
} from "../../src/providers/pi-zai-credential.js";
import type { ProviderAdapter, ProviderQuota } from "../../src/types.js";

const fixtureDir = join(import.meta.dirname, "..", "fixtures", "zai");
const NOW = Date.parse("2026-08-17T04:05:06.000Z");
const OPTIONS = { allowKeychainPrompt: false };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
}

describe("Z.AI quota parsing", () => {
  it("maps a token-plan payload to session, weekly, and MCP windows", () => {
    const result = normalizeZaiPayload(fixture("tokens.json"));

    expect(result.plan).toBe("pro");
    expect(result.diagnostics).toEqual([]);
    expect(result.windows).toEqual([
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 17,
        percentRemaining: 83,
        windowSeconds: 18_000,
        resetsAt: "2026-06-29T09:22:51.179Z",
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 3,
        percentRemaining: 97,
        windowSeconds: 604_800,
        resetsAt: "2026-07-06T02:38:06.997Z",
      },
      {
        id: "mcp_monthly",
        label: "mcp tools",
        kind: "monthly",
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: "2026-07-29T02:38:06.976Z",
      },
    ]);
  });

  it("prefers exact credit usage over the rounded percentage", () => {
    const result = normalizeZaiPayload(fixture("credits.json"));

    expect(result.plan).toBe("lite");
    expect(result.windows).toMatchObject([
      { id: "five_hour", percentUsed: 0, percentRemaining: 100 },
      { id: "weekly", percentUsed: 98.55, percentRemaining: 1.45 },
    ]);
    // The payload's own rounded percentage is 98; quota-axi keeps the exact ratio.
    expect(result.windows[1].resetsAt).toBe("2026-08-14T05:34:39.998Z");
  });

  it("identifies windows by their unit and number, not array position", () => {
    const live = fixture("live.json") as {
      data: { limits: unknown[] };
    };
    const reversed = {
      ...live,
      data: { ...live.data, limits: [...live.data.limits].reverse() },
    };

    expect(normalizeZaiPayload(reversed).windows.map(({ id }) => id)).toEqual([
      "mcp_monthly",
      "weekly",
      "five_hour",
    ]);
    expect(normalizeZaiPayload(fixture("live.json")).windows).toMatchObject([
      { id: "five_hour", percentUsed: 53 },
      { id: "weekly", percentUsed: 11 },
      { id: "mcp_monthly", percentUsed: 0 },
    ]);
  });

  it("keeps an unfamiliar period honest instead of naming it", () => {
    const result = normalizeZaiPayload(
      envelope([
        { type: "TOKENS_LIMIT", unit: 4, number: 3, percentage: 40 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10 },
      ]),
    );

    expect(result.windows).toMatchObject([
      {
        id: "3d",
        label: "3d",
        kind: "unknown",
        percentUsed: 40,
        windowSeconds: 259_200,
      },
      { id: "five_hour", kind: "session", percentUsed: 10 },
    ]);
    expect(result.diagnostics).toEqual([
      { code: "limit_unrecognized", index: 1 },
    ]);
  });

  it("does not guess a duration for an unknown unit or limit type", () => {
    const result = normalizeZaiPayload(
      envelope([
        { type: "TOKENS_LIMIT", unit: 9, number: 2, percentage: 25 },
        { type: "FUTURE_LIMIT", unit: 3, number: 5, percentage: 60 },
        { type: "TIME_LIMIT", unit: 3, number: 5, percentage: 5 },
      ]),
    );

    expect(result.windows).toMatchObject([
      { id: "limit:1", kind: "unknown", percentUsed: 25 },
      { id: "limit:2", kind: "unknown", percentUsed: 60 },
      { id: "limit:3", kind: "unknown", percentUsed: 5 },
    ]);
    expect(
      result.windows.every(({ windowSeconds }) => windowSeconds === undefined),
    ).toBe(true);
    expect(result.diagnostics).toEqual([
      { code: "limit_unrecognized", index: 1 },
      { code: "limit_unrecognized", index: 2 },
      { code: "limit_unrecognized", index: 3 },
    ]);
  });

  it("reports a limit with no usable numbers as invalid rather than zero", () => {
    const result = normalizeZaiPayload(
      envelope([
        { type: "TOKENS_LIMIT", unit: 3, number: 5 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12 },
      ]),
    );

    expect(result.windows).toMatchObject([{ id: "weekly", percentUsed: 12 }]);
    expect(result.diagnostics).toEqual([{ code: "limit_invalid", index: 1 }]);
  });

  it("clamps a percentage the provider reports out of range", () => {
    const result = normalizeZaiPayload(
      envelope([{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 140 }]),
    );

    expect(result.windows).toMatchObject([
      { id: "weekly", percentUsed: 100, percentRemaining: 0 },
    ]);
  });

  it("accepts an empty limits list without inventing windows", () => {
    expect(normalizeZaiPayload(envelope([])).windows).toEqual([]);
  });

  it("rejects malformed and unsuccessful payloads loudly", () => {
    for (const payload of [
      null,
      [],
      "quota",
      { code: 200, success: true },
      { code: 200, success: true, data: {} },
      { code: 200, success: true, data: { limits: {} } },
      { msg: "no envelope status", data: { limits: [] } },
    ]) {
      expect(
        () => normalizeZaiPayload(payload),
        JSON.stringify(payload) ?? "undefined",
      ).toThrow("schema_invalid");
    }
    expect(() =>
      normalizeZaiPayload({ code: 401, success: false, msg: "token invalid" }),
    ).toThrow("provider_response_rejected");
    expect(() =>
      normalizeZaiPayload({ code: 500, data: { limits: [] } }),
    ).toThrow("provider_response_rejected");
  });
});

describe("Z.AI request transport", () => {
  it("makes one fixed-origin read-only request with only the Pi-resolved key", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(fixture("live.json")),
    );

    const report = await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    const url = new URL(String(input));
    expect({
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
    }).toEqual({
      protocol: "https:",
      hostname: "api.z.ai",
      pathname: "/api/monitor/usage/quota/limit",
      search: "",
    });
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-zai-key-518");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^quota-axi\/\d+\.\d+\.\d+$/);
    expect(headers.get("cookie")).toBeNull();

    expect(report).toMatchObject({
      provider: "zai",
      label: "Z.AI",
      source: "api",
      plan: "pro",
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-08-17T04:05:06.000Z",
        sourcesTried: ["pi:zai"],
      },
      attempts: [{ source: "pi:zai", status: "success" }],
    });
    expect(report.state.untrustedWindowIds).toBeUndefined();
    expect(report.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "weekly",
      "mcp_monthly",
    ]);
    expect(JSON.stringify(report)).not.toContain("synthetic-zai-key-518");
  });

  it("surfaces unrecognized limits as untrusted window ids", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse(
          envelope([
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20 },
            { type: "TOKENS_LIMIT", unit: 9, number: 4, percentage: 30 },
            { type: "TOKENS_LIMIT", unit: 3, number: 5 },
          ]),
        ),
      ) as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(report.state.untrustedWindowIds).toEqual(["limit:2", "invalid:3"]);
    expect(report.windows.map(({ id }) => id)).toEqual(["weekly", "limit:2"]);
  });

  it("reports a missing Pi credential as auth_required and retires the cache", async () => {
    const deleteCachedProvider = vi.fn();
    const readCachedProvider = vi.fn(() => cachedQuota());
    const request = vi.fn();

    const report = await testAdapter({
      broker: broker({ status: "missing" }),
      fetch: request as unknown as typeof fetch,
      deleteCachedProvider,
      readCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(deleteCachedProvider).toHaveBeenCalledWith("zai");
    expect(readCachedProvider).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      provider: "zai",
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: "zai_credential_unavailable",
        sourcesTried: ["pi:zai"],
      },
      attempts: [
        {
          source: "pi:zai",
          status: "skipped",
          error: "zai_credential_unavailable",
        },
      ],
    });
  });

  it("reports an expired Pi OAuth record as auth_required without refreshing", async () => {
    const report = await testAdapter({
      broker: broker({ status: "expired", refreshable: true }),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "pi_zai_credential_expired",
    });
  });

  it("treats provider rejection as definitive auth failure", async () => {
    const deleteCachedProvider = vi.fn();

    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
      deleteCachedProvider,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(deleteCachedProvider).toHaveBeenCalledWith("zai");
    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "auth_required", error: "provider_auth_rejected" },
    });
  });

  it("honors a Retry-After header on a rate-limited response", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "rate_limited",
      error: "provider_rate_limited",
      retryAfter: "2026-08-17T04:07:06.000Z",
    });
  });

  it("falls back to a formerly fresh snapshot on a transient failure", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "cache",
      state: {
        status: "stale",
        stale: true,
        error: "provider_unavailable",
        sourcesTried: ["pi:zai", "cache"],
      },
    });
    expect(report.windows.map(({ id }) => id)).toEqual(["weekly"]);
  });

  it("does not reuse a cached snapshot from another source", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      readCachedProvider: () => ({
        ...cachedQuota(),
        source: "web" as const,
      }),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "error", error: "provider_unavailable" },
    });
  });

  it("reports a malformed body as an error instead of empty quota", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response("<html>gateway</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "malformed_json" },
    });
  });

  it("abandons a request that outlives the deadline", async () => {
    const report = await testAdapter({
      deadlineMs: 5,
      fetch: vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ) as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "request_timeout",
    });
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const request = vi.fn(async () => jsonResponse(fixture("live.json")));
    const adapter = testAdapter({ fetch: request as unknown as typeof fetch });

    const [first, second] = await Promise.all([
      adapter.fetchQuota(OPTIONS),
      adapter.fetchQuota(OPTIONS),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

describe("Z.AI auth inspection", () => {
  it("reports the Pi source status without exposing the credential", async () => {
    await expect(testAdapter().inspectAuth(OPTIONS)).resolves.toEqual({
      provider: "zai",
      sources: [{ source: "pi:zai", status: "available" }],
    });

    await expect(
      testAdapter({
        broker: broker({ status: "unsupported" }),
      }).inspectAuth(OPTIONS),
    ).resolves.toEqual({
      provider: "zai",
      sources: [
        {
          source: "pi:zai",
          status: "invalid",
          error: "unsupported_credential_type",
        },
      ],
    });

    await expect(
      testAdapter({
        broker: broker({ status: "expired", refreshable: false }),
      }).inspectAuth(OPTIONS),
    ).resolves.toEqual({
      provider: "zai",
      sources: [
        {
          source: "pi:zai",
          status: "expired",
          error: "pi_zai_credential_expired",
        },
      ],
    });
  });
});

function testAdapter(
  overrides: Parameters<typeof createZaiAdapter>[0] = {},
): ProviderAdapter {
  return createZaiAdapter({
    broker: broker({
      status: "available",
      kind: "api_key",
      credential: "synthetic-zai-key-518",
    }),
    fetch: vi.fn(async () =>
      jsonResponse(fixture("live.json")),
    ) as unknown as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function broker(
  resolution: ZaiCredentialResolution,
  inspection: ZaiCredentialInspection = resolution.status,
): ZaiCredentialBroker {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => inspection),
  };
}

function envelope(limits: unknown[], level = "pro"): unknown {
  return {
    code: 200,
    msg: "Operation successful",
    data: { limits, level },
    success: true,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cachedQuota(): ProviderQuota {
  return {
    provider: "zai",
    label: "Z.AI",
    source: "api",
    windows: [
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 41,
        percentRemaining: 59,
        windowSeconds: 604_800,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(NOW - 60_000).toISOString(),
      sourcesTried: ["pi:zai"],
    },
  };
}
