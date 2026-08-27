import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpencodeGoAdapter,
  createOpencodeGoCredentialSource,
  extractOpencodeGoCredential,
  normalizeOpencodeGoPayload,
} from "../../src/providers/opencode-go.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import type { ProviderAdapter, ProviderQuota } from "../../src/types.js";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false };
const API_KEY = "synthetic-opencode-go-key-493";
type LiveUsagePayload = {
  usage: {
    rolling: { status: string; percent: number; resetsAt: string };
    weekly: { status: string; percent: number; resetsAt: string };
    monthly: { status: string; percent: number; resetsAt: string };
  };
  useBalance?: boolean;
};

const SUCCESS_PAYLOAD = JSON.parse(
  readFileSync(join("test", "fixtures", "opencode-go", "usage.json"), "utf8"),
) as LiveUsagePayload;

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("OpenCode Go credential discovery", () => {
  it("finds the api key from the OpenCode auth file", () => {
    const path = authFile({ "opencode-go": { type: "api", key: API_KEY } });
    const source = createOpencodeGoCredentialSource(() => path);

    expect(source.resolve()).toEqual({
      status: "available",
      apiKey: API_KEY,
      path,
    });
    expect(source.inspect()).toEqual({ status: "available", path });
  });

  it("requires an opencode-go api entry and literal key", () => {
    const path = authFile({ "opencode-go": { type: "oauth", key: API_KEY } });
    expect(extractOpencodeGoCredential({}, path)).toEqual({
      status: "missing",
      path,
    });
    expect(
      extractOpencodeGoCredential(JSON.parse(readFileSync(path, "utf8")), path),
    ).toEqual({
      status: "invalid",
      path,
      error: "opencode_go_credential_invalid",
    });
    expect(
      extractOpencodeGoCredential(
        { "opencode-go": { type: "api", key: "$OPEN_CODE_KEY" } },
        path,
      ),
    ).toMatchObject({ status: "invalid" });
  });

  it("reports missing auth without making a network request", async () => {
    const request = vi.fn();
    const path = join(temp(), "missing-auth.json");
    const report = await createOpencodeGoAdapter({
      credentialSource: createOpencodeGoCredentialSource(() => path),
      fetch: request,
      readCachedProvider: () => undefined,
      deleteCachedProvider: vi.fn(),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      provider: "opencode-go",
      plan: "go",
      windows: [],
      state: {
        status: "auth_required",
        error: "opencode_go_credential_unavailable",
      },
    });
  });
});

describe("OpenCode Go usage normalization", () => {
  it("normalizes all three windows from the verified live response shape", () => {
    const normalized = normalizeOpencodeGoPayload(SUCCESS_PAYLOAD, NOW);

    expect(normalized).toMatchObject({ diagnostics: [] });
    expect(normalized.useBalance).toBeUndefined();
    expect(normalized.windows).toEqual([
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: "2026-08-24T17:00:00.000Z",
        windowSeconds: 18_000,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 3,
        percentRemaining: 97,
        resetsAt: "2026-08-30T12:00:00.000Z",
        windowSeconds: 604_800,
      },
      {
        id: "monthly",
        label: "month",
        kind: "monthly",
        percentUsed: 73,
        percentRemaining: 27,
        resetsAt: "2026-09-12T12:00:00.000Z",
      },
    ]);
  });

  it("does not infer a monthly 30-day cycle or fabricate a cycle start", () => {
    const monthly = normalizeOpencodeGoPayload(SUCCESS_PAYLOAD, NOW).windows[2];

    expect(monthly.id).toBe("monthly");
    expect(monthly.resetsAt).toBe("2026-09-12T12:00:00.000Z");
    expect(monthly.windowSeconds).toBeUndefined();
    expect(monthly.startsAt).toBeUndefined();
  });

  it("canonicalizes a non-ISO resetsAt to an ISO timestamp", () => {
    const normalized = normalizeOpencodeGoPayload(
      {
        ...SUCCESS_PAYLOAD,
        usage: {
          ...SUCCESS_PAYLOAD.usage,
          monthly: {
            status: "ok",
            percent: 40,
            resetsAt: "Sat, 12 Sep 2026 12:00:00 GMT",
          },
        },
      },
      NOW,
    );

    expect(normalized.windows[2]?.resetsAt).toBe("2026-09-12T12:00:00.000Z");
  });

  it("keeps valid windows but marks missing or unfamiliar usage conservatively", () => {
    const normalized = normalizeOpencodeGoPayload(
      {
        ...SUCCESS_PAYLOAD,
        usage: {
          ...SUCCESS_PAYLOAD.usage,
          weekly: undefined,
          dailyQuota: {
            status: "ok",
            percent: 1,
            resetsAt: "2026-08-25T12:00:00.000Z",
          },
          dailyUsage: { status: "pending" },
        },
      },
      NOW,
    );

    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "monthly",
    ]);
    expect(normalized.diagnostics).toEqual([
      { windowId: "weekly", code: "usage_missing" },
      { windowId: "unknown:dailyQuota", code: "usage_invalid" },
      { windowId: "unknown:dailyUsage", code: "usage_invalid" },
    ]);
  });

  it("retains useBalance without inventing credits or a balance amount", () => {
    const normalized = normalizeOpencodeGoPayload(
      {
        ...SUCCESS_PAYLOAD,
        useBalance: true,
      },
      NOW,
    );

    expect(normalized.useBalance).toBe(true);
    expect(normalized).not.toHaveProperty("credits");
    expect(normalized).not.toHaveProperty("balance");
    expect(normalized).not.toHaveProperty("runway");
  });
});

describe("OpenCode Go request and failure handling", () => {
  it("calls the official fixed-origin endpoint with a bearer key", async () => {
    const request = vi.fn(async () => jsonResponse(SUCCESS_PAYLOAD));
    const report = await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    const url = new URL(String(input));
    expect({
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    }).toEqual({
      protocol: "https:",
      hostname: "opencode.ai",
      pathname: "/zen/go/v1/usage",
      search: "",
      hash: "",
    });
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(report).toMatchObject({
      provider: "opencode-go",
      label: "OpenCode Go",
      plan: "go",
      source: "api",
      state: { status: "fresh", stale: false },
      attempts: [{ source: "opencode:auth.json", status: "success" }],
    });
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });

  it("computes effective all-model availability as the minimum remaining value", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => jsonResponse(SUCCESS_PAYLOAD)),
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, new Date(NOW).toISOString());
    const scope = interpreted.quotaSemantics?.effectiveAvailability[0];

    expect(scope).toMatchObject({
      scope: "all_models",
      status: "known",
      effectivePercentRemaining: 27,
      boundedBy: ["five_hour", "weekly", "monthly"],
      limitingWindowIds: ["monthly"],
    });
    expect(interpreted.windows[2].windowSeconds).toBeUndefined();
  });

  it("keeps availability partial for every unfamiliar usage member", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          ...SUCCESS_PAYLOAD,
          usage: {
            ...SUCCESS_PAYLOAD.usage,
            daily: { status: "ok", remaining: 5 },
          },
        }),
      ),
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, new Date(NOW).toISOString());

    expect(report.state.untrustedWindowIds).toEqual(["unknown:daily"]);
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["unknown:daily"],
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "unknown",
          boundedBy: ["five_hour", "weekly", "monthly"],
        },
      ],
    });
  });

  it("keeps availability partial when a reported window already expired", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          ...SUCCESS_PAYLOAD,
          usage: {
            ...SUCCESS_PAYLOAD.usage,
            rolling: {
              ...SUCCESS_PAYLOAD.usage.rolling,
              resetsAt: "2026-08-23T17:00:00.000Z",
            },
          },
        }),
      ),
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, new Date(NOW).toISOString());

    expect(report.state.untrustedWindowIds).toEqual(["five_hour"]);
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["five_hour"],
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "unknown",
          boundedBy: ["weekly", "monthly"],
        },
      ],
    });
  });

  it("preserves absolute reset timestamps regardless of the local clock", async () => {
    const later = NOW + 10_000;
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(NOW)
      .mockReturnValue(later);
    const report = await testAdapter({
      fetch: vi.fn(async () => jsonResponse(SUCCESS_PAYLOAD)),
      now,
    }).fetchQuota(OPTIONS);

    expect(report.windows[0]?.resetsAt).toBe("2026-08-24T17:00:00.000Z");
    expect(report.state.refreshedAt).toBe(new Date(later).toISOString());
  });

  it("validates resets against body completion time", async () => {
    const completedAt = NOW + 10_000;
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(NOW)
      .mockReturnValue(completedAt);
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          ...SUCCESS_PAYLOAD,
          usage: {
            ...SUCCESS_PAYLOAD.usage,
            rolling: {
              ...SUCCESS_PAYLOAD.usage.rolling,
              resetsAt: new Date(NOW + 2_000).toISOString(),
            },
          },
        }),
      ),
      now,
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(
      report,
      new Date(completedAt).toISOString(),
    );

    expect(report.state.refreshedAt).toBe(new Date(completedAt).toISOString());
    expect(report.state.untrustedWindowIds).toEqual(["five_hour"]);
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["five_hour"],
    });
  });

  it("keeps balance-backed exhaustion non-definitive", async () => {
    const exhausted = {
      ...SUCCESS_PAYLOAD,
      useBalance: true,
      usage: {
        rolling: { ...SUCCESS_PAYLOAD.usage.rolling, percent: 100 },
        weekly: { ...SUCCESS_PAYLOAD.usage.weekly, percent: 100 },
        monthly: { ...SUCCESS_PAYLOAD.usage.monthly, percent: 100 },
      },
    };
    const report = await testAdapter({
      fetch: vi.fn(async () => jsonResponse(exhausted)),
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, new Date(NOW).toISOString());

    expect(report.useBalance).toBe(true);
    expect(interpreted.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
      status: "known",
      effectivePercentRemaining: 0,
      runway: { status: "unknown" },
    });
  });

  it("rejects malformed balance fallback metadata", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          ...SUCCESS_PAYLOAD,
          useBalance: "true",
          usage: {
            rolling: { ...SUCCESS_PAYLOAD.usage.rolling, percent: 100 },
            weekly: { ...SUCCESS_PAYLOAD.usage.weekly, percent: 100 },
            monthly: { ...SUCCESS_PAYLOAD.usage.monthly, percent: 100 },
          },
        }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "schema_invalid" },
    });
  });

  it.each([
    [401, "auth_required", "provider_auth_rejected"],
    [403, "auth_required", "provider_entitlement_required"],
    [429, "rate_limited", "provider_rate_limited"],
    [503, "error", "provider_unavailable"],
  ] as const)(
    "maps HTTP %i to %s/%s without exposing the response body",
    async (status, expectedStatus, expectedError) => {
      const report = await testAdapter({
        fetch: vi.fn(
          async () => new Response("provider secret body", { status }),
        ),
      }).fetchQuota(OPTIONS);

      expect(report.state).toMatchObject({
        status: expectedStatus,
        error: expectedError,
      });
      expect(JSON.stringify(report)).not.toContain("provider secret body");
    },
  );

  it("rejects redirects, unexpected content, invalid JSON, and transport errors", async () => {
    const cases: Array<[Response | Error, string]> = [
      [
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.invalid/secret" },
        }),
        "redirect_rejected",
      ],
      [
        new Response(JSON.stringify(SUCCESS_PAYLOAD), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
        "unexpected_content_type",
      ],
      [
        new Response("{unfinished", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "malformed_json",
      ],
      [new Error("network secret"), "network_unavailable"],
    ];
    for (const [response, expectedError] of cases) {
      const report = await testAdapter({
        fetch: vi.fn(async () => {
          if (response instanceof Error) throw response;
          return response;
        }),
      }).fetchQuota(OPTIONS);
      expect(report.state.error).toBe(expectedError);
    }
  });

  it("rejects duplicate response keys at every object depth", async () => {
    const duplicatePayloads = [
      `{
        "usage": {},
        "usage": {
          "rolling": {"status":"ok","percent":90,"resetsAt":"2026-08-24T17:00:00.000Z"}
        }
      }`,
      `{
        "usage": {
          "rolling": {"status":"ok","percent":0,"resetsAt":"2026-08-24T17:00:00.000Z"},
          "rolling": {"status":"ok","percent":90,"resetsAt":"2026-08-24T17:00:00.000Z"}
        }
      }`,
      `{
        "usage": {
          "rolling": {
            "status":"ok",
            "percent":0,
            "percent":90,
            "resetsAt":"2026-08-24T17:00:00.000Z"
          }
        }
      }`,
    ];

    for (const duplicatePayload of duplicatePayloads) {
      const report = await testAdapter({
        fetch: vi.fn(
          async () =>
            new Response(duplicatePayload, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      }).fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        source: "unavailable",
        windows: [],
        state: { status: "error", error: "schema_invalid" },
      });
    }
  });

  it("reuses reset-valid stale cache for a transient provider failure", async () => {
    const cached = { ...cachedReport(), useBalance: true };
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      readCachedProvider: () => cached,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "opencode-go",
      source: "cache",
      useBalance: true,
      state: { status: "stale", stale: true, error: "provider_unavailable" },
    });
    expect(report.windows).toHaveLength(3);
  });

  it("does not use a stale cache for definitive invalid-key auth", async () => {
    const remove = vi.fn();
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
      readCachedProvider: () => cachedReport(),
      deleteCachedProvider: remove,
    }).fetchQuota(OPTIONS);

    expect(remove).toHaveBeenCalledWith("opencode-go");
    expect(report.source).toBe("unavailable");
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
  });

  it("does not use stale cache for a current entitlement rejection", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 403 })),
      readCachedProvider: () => cachedReport(),
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("unavailable");
    expect(report.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "provider_entitlement_required",
    });
  });

  it("does not wait for a hanging stream cancellation after the deadline", async () => {
    const reader = {
      read: vi.fn(
        () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
      ),
      cancel: vi.fn(() => new Promise<void>(() => {})),
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    const startedAt = Date.now();

    const report = await testAdapter({
      deadlineMs: 5,
      fetch: vi.fn(async () => response),
    }).fetchQuota(OPTIONS);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "request_timeout" },
    });
  });
});

function testAdapter(
  overrides: Partial<Parameters<typeof createOpencodeGoAdapter>[0]> = {},
): ProviderAdapter {
  return createOpencodeGoAdapter({
    credentialSource: {
      resolve: () => ({
        status: "available",
        apiKey: API_KEY,
        path: "fixture",
      }),
      inspect: () => ({ status: "available", path: "fixture" }),
    },
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function cachedReport(): ProviderQuota {
  return {
    provider: "opencode-go",
    label: "OpenCode Go",
    source: "api",
    plan: "go",
    windows: normalizeOpencodeGoPayload(SUCCESS_PAYLOAD, NOW).windows,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(NOW - 60_000).toISOString(),
    },
  };
}

function authFile(value: unknown): string {
  const directory = temp();
  const path = join(directory, "auth.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function temp(): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "quota-axi-opencode-go-"));
  return tempDir;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
