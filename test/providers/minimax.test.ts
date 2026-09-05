import { describe, expect, it, vi } from "vitest";
import {
  createMinimaxAdapter,
  minimaxAdapter,
  normalizeMinimaxPayload,
} from "../../src/providers/minimax.js";
import type {
  MinimaxCredentialBroker,
  MinimaxCredentialInspection,
  MinimaxCredentialResolution,
} from "../../src/providers/pi-minimax-credential.js";
import type { ProviderAdapter } from "../../src/types.js";

const NOW = Date.parse("2027-02-03T04:05:06.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };

/** A real captured response from an account with no active Token Plan seat. */
const UNPROVISIONED_PAYLOAD = {
  model_remains: [
    {
      start_time: 1_788_264_000_000,
      end_time: 1_788_278_400_000,
      remains_time: 12_889_929,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "general",
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1_788_105_600_000,
      weekly_end_time: 1_788_710_400_000,
      weekly_remains_time: 444_889_929,
      current_interval_status: 1,
      current_interval_remaining_percent: 100,
      current_weekly_status: 3,
      current_weekly_remaining_percent: 100,
    },
    {
      start_time: 1_788_192_000_000,
      end_time: 1_788_278_400_000,
      remains_time: 12_889_929,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "video",
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1_788_105_600_000,
      weekly_end_time: 1_788_710_400_000,
      weekly_remains_time: 444_889_929,
      current_interval_status: 3,
      current_interval_remaining_percent: 100,
      current_weekly_status: 3,
      current_weekly_remaining_percent: 100,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

/** A synthetic response for an account with a provisioned Token Plan seat. */
const PROVISIONED_PAYLOAD = {
  model_remains: [
    {
      start_time: 1_788_264_000_000,
      end_time: 1_788_278_400_000,
      current_interval_total_count: 5_000_000,
      current_interval_usage_count: 750_000,
      model_name: "general",
      current_weekly_total_count: 30_000_000,
      current_weekly_usage_count: 9_000_000,
      weekly_start_time: 1_788_105_600_000,
      weekly_end_time: 1_788_710_400_000,
      current_interval_remaining_percent: 85,
      current_weekly_remaining_percent: 70,
    },
    {
      start_time: 1_788_192_000_000,
      end_time: 1_788_278_400_000,
      current_interval_total_count: 10,
      current_interval_usage_count: 6,
      model_name: "video",
      current_weekly_total_count: 40,
      current_weekly_usage_count: 18,
      weekly_start_time: 1_788_105_600_000,
      weekly_end_time: 1_788_710_400_000,
      current_interval_remaining_percent: 40,
      current_weekly_remaining_percent: 55,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

describe("MiniMax request transport", () => {
  it("sends one fixed-origin POST with only the Pi-resolved key", async () => {
    const request = vi.fn(async () => jsonResponse(PROVISIONED_PAYLOAD));
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
      hostname: "www.minimaxi.com",
      pathname: "/v1/token_plan/remains",
      search: "",
    });
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      "Bearer synthetic-minimax-key-741",
    );
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^quota-axi\/\d+\.\d+\.\d+$/);
    expect(headers.get("cookie")).toBeNull();
    expect(report).toMatchObject({
      provider: "minimax",
      label: "MiniMax",
      source: "api",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["pi:minimax-cn"],
      },
      attempts: [{ source: "pi:minimax-cn", status: "success" }],
    });
    expect(JSON.stringify(report)).not.toContain("synthetic-minimax-key-741");
  });

  it("reports a shared account bound and a separate resource-scoped bound", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => jsonResponse(PROVISIONED_PAYLOAD)),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.windows).toEqual([
      {
        id: "interval",
        label: "interval",
        kind: "session",
        percentUsed: 15,
        percentRemaining: 85,
        resetsAt: "2026-09-01T16:00:00.000Z",
        windowSeconds: 14_400,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 30,
        percentRemaining: 70,
        resetsAt: "2026-09-06T16:00:00.000Z",
        windowSeconds: 604_800,
      },
      {
        id: "model:video:interval",
        label: "video interval",
        kind: "model",
        percentUsed: 60,
        percentRemaining: 40,
        resetsAt: "2026-09-01T16:00:00.000Z",
        windowSeconds: 86_400,
      },
      {
        id: "model:video:weekly",
        label: "video week",
        kind: "model",
        percentUsed: 45,
        percentRemaining: 55,
        resetsAt: "2026-09-06T16:00:00.000Z",
        windowSeconds: 604_800,
      },
    ]);
  });

  it("omits every window that has not been provisioned instead of trusting the vendor's optimistic 100%", async () => {
    // Regression fixture: a real account with no active Token Plan seat
    // reports current_*_total_count: 0 on every entry while still reporting
    // current_*_remaining_percent: 100, a known vendor-side false reading.
    const report = await testAdapter({
      fetch: vi.fn(async () => jsonResponse(UNPROVISIONED_PAYLOAD)),
    }).fetchQuota(OPTIONS);

    expect(report.windows).toEqual([]);
    expect(report.state.status).toBe("fresh");
  });

  it("normalizes windows directly from the payload without an adapter round trip", () => {
    expect(normalizeMinimaxPayload(PROVISIONED_PAYLOAD).windows).toHaveLength(
      4,
    );
    expect(normalizeMinimaxPayload(UNPROVISIONED_PAYLOAD).windows).toEqual([]);
  });

  it("skips malformed model_remains entries instead of throwing", () => {
    expect(
      normalizeMinimaxPayload({
        model_remains: [
          "not-an-object",
          null,
          {
            model_name: "general",
            current_interval_total_count: 100,
            current_interval_remaining_percent: 50,
            start_time: 0,
            end_time: 1000,
          },
        ],
        base_resp: { status_code: 0 },
      }).windows,
    ).toEqual([
      expect.objectContaining({ id: "interval", percentRemaining: 50 }),
    ]);
  });

  it("rejects a non-array model_remains and a non-object payload", () => {
    expect(() =>
      normalizeMinimaxPayload({
        model_remains: "not-an-array",
        base_resp: { status_code: 0 },
      }),
    ).toThrow();
    expect(() => normalizeMinimaxPayload("not-an-object")).toThrow();
    expect(() => normalizeMinimaxPayload(null)).toThrow();
  });

  it("treats a non-zero base_resp status_code as a rejected request", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          model_remains: [],
          base_resp: { status_code: 1013, status_msg: "unknown error" },
        }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_request_rejected",
    });
  });

  it("retires cache and reports auth_required on a base_resp auth mismatch", async () => {
    const remove = vi.fn();
    const report = await testAdapter({
      deleteCachedProvider: remove,
      fetch: vi.fn(async () =>
        jsonResponse({
          model_remains: [],
          base_resp: { status_code: 1004, status_msg: "auth mismatch" },
        }),
      ),
    }).fetchQuota(OPTIONS);

    expect(remove).toHaveBeenCalledWith("minimax");
    expect(report.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "provider_auth_rejected",
    });
    expect(report.windows).toEqual([]);
  });
});

describe("MiniMax credential outcomes and cache policy", () => {
  it.each([
    ["missing", "minimax_credential_unavailable"],
    ["unsupported", "unsupported_credential_type"],
  ] as const)(
    "makes no request for %s credentials and retires cache",
    async (status, code) => {
      const request = vi.fn();
      const remove = vi.fn();
      const report = await testAdapter({
        broker: broker({ status }),
        fetch: request,
        deleteCachedProvider: remove,
      }).fetchQuota(OPTIONS);

      expect(request).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith("minimax");
      expect(report.state).toMatchObject({
        status: "auth_required",
        stale: false,
        error: code,
      });
      expect(report.windows).toEqual([]);
    },
  );

  it("makes no request for an expired credential with no testable access token and retires cache", async () => {
    const request = vi.fn();
    const remove = vi.fn();
    const report = await testAdapter({
      broker: broker({ status: "expired", refreshable: true }),
      fetch: request,
      deleteCachedProvider: remove,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("minimax");
    expect(report.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "pi_minimax_credential_expired",
    });
    expect(report.windows).toEqual([]);
  });

  it("probes a stored-expired access token instead of declaring sign-out from local metadata alone", async () => {
    const request = vi.fn(async () => jsonResponse(PROVISIONED_PAYLOAD));
    const report = await testAdapter({
      broker: broker({
        status: "expired",
        refreshable: true,
        credential: "stale-but-still-live-token",
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state).toMatchObject({ status: "fresh", stale: false });
    expect(report.windows).not.toEqual([]);
  });

  it("reports auth_required when a stored-expired access token is empirically rejected", async () => {
    const remove = vi.fn();
    const report = await testAdapter({
      broker: broker({
        status: "expired",
        refreshable: true,
        credential: "stale-and-actually-dead-token",
      }),
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
      deleteCachedProvider: remove,
    }).fetchQuota(OPTIONS);

    expect(remove).toHaveBeenCalledWith("minimax");
    expect(report.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "provider_auth_rejected",
    });
  });

  it("reports an honest error after an unexpected resolver failure instead of serving cache", async () => {
    const report = await testAdapter({
      broker: broker({ status: "error" }),
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("unavailable");
    expect(report.state).toMatchObject({
      status: "error",
      stale: false,
      error: "credential_resolution_failed",
    });
    expect(report.windows).toEqual([]);
  });

  it("never serves cached windows for transient HTTP and parser failures", async () => {
    for (const response of [
      new Response(null, { status: 408 }),
      new Response(null, { status: 502 }),
      new Response("broken", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]) {
      const report = await testAdapter({
        fetch: vi.fn(async () => response),
      }).fetchQuota(OPTIONS);
      expect(report.state.status).toBe("error");
      expect(report.state.stale).toBe(false);
      expect(report.source).toBe("unavailable");
      expect(report.windows).toEqual([]);
    }
  });

  it("reports rate_limited with Retry-After instead of falling back to cache", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      ),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("unavailable");
    expect(report.state).toMatchObject({
      status: "rate_limited",
      stale: false,
      error: "provider_rate_limited",
      retryAfter: "2027-02-03T04:07:06.000Z",
    });
    expect(report.windows).toEqual([]);
  });

  it("retires cache and reports auth_required on a definitive 401/403", async () => {
    for (const status of [401, 403]) {
      const remove = vi.fn();
      const report = await testAdapter({
        fetch: vi.fn(async () => new Response(null, { status })),
        deleteCachedProvider: remove,
      }).fetchQuota(OPTIONS);

      expect(remove).toHaveBeenCalledWith("minimax");
      expect(report.state).toMatchObject({
        status: "auth_required",
        error: "provider_auth_rejected",
        stale: false,
      });
      expect(report.source).toBe("unavailable");
    }
  });
});

describe("MiniMax auth inspection", () => {
  it("reports available, unsupported, missing, and error inspections", async () => {
    const cases: [MinimaxCredentialInspection, string | undefined][] = [
      ["available", undefined],
      ["unsupported", "unsupported_credential_type"],
      ["missing", undefined],
      ["error", "credential_resolution_failed"],
    ];
    for (const [inspection, error] of cases) {
      const report = await createMinimaxAdapter({
        broker: {
          resolve: vi.fn(async () => ({ status: inspection }) as never),
          inspect: vi.fn(async () => inspection),
        },
      }).inspectAuth(OPTIONS);

      expect(report).toEqual({
        provider: "minimax",
        sources: [
          {
            source: "pi:minimax-cn",
            status:
              inspection === "unsupported" || inspection === "error"
                ? "invalid"
                : inspection,
            ...(error ? { error } : {}),
          },
        ],
      });
    }
  });

  it("does not throw when the broker inspection rejects", async () => {
    const report = await createMinimaxAdapter({
      broker: {
        resolve: vi.fn(),
        inspect: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    }).inspectAuth(OPTIONS);

    expect(report.sources[0]).toMatchObject({
      status: "invalid",
      error: "credential_resolution_failed",
    });
  });

  it("reports expired without a testable access token, without a network call", async () => {
    const request = vi.fn();
    const report = await createMinimaxAdapter({
      broker: broker({ status: "expired", refreshable: true }),
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.sources[0]).toMatchObject({
      status: "expired",
      error: "pi_minimax_credential_expired",
    });
  });

  it("probes a stored-expired access token and reports available when the server still accepts it", async () => {
    const request = vi.fn(async () => jsonResponse(PROVISIONED_PAYLOAD));
    const report = await createMinimaxAdapter({
      broker: broker({
        status: "expired",
        refreshable: true,
        credential: "stale-but-still-live-token",
      }),
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.sources[0]).toEqual({
      source: "pi:minimax-cn",
      status: "available",
    });
  });

  it("reports available when the credential is renewed between inspect() and resolve()", async () => {
    const request = vi.fn();
    const report = await createMinimaxAdapter({
      broker: {
        inspect: vi.fn(async () => "expired"),
        resolve: vi.fn(async () => ({
          status: "available",
          kind: "oauth",
          credential: "freshly-renewed-token",
        })),
      },
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.sources[0]).toEqual({
      source: "pi:minimax-cn",
      status: "available",
    });
  });

  it("reports missing when the credential disappears between inspect() and resolve()", async () => {
    const request = vi.fn();
    const report = await createMinimaxAdapter({
      broker: {
        inspect: vi.fn(async () => "expired"),
        resolve: vi.fn(async () => ({ status: "missing" })),
      },
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.sources[0]).toEqual({
      source: "pi:minimax-cn",
      status: "missing",
    });
  });

  it("reports unsupported when the credential's type changes between inspect() and resolve()", async () => {
    const request = vi.fn();
    const report = await createMinimaxAdapter({
      broker: {
        inspect: vi.fn(async () => "expired"),
        resolve: vi.fn(async () => ({ status: "unsupported" })),
      },
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.sources[0]).toEqual({
      source: "pi:minimax-cn",
      status: "invalid",
      error: "unsupported_credential_type",
    });
  });

  it("keeps reporting expired when a stored-expired access token is empirically rejected", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const report = await createMinimaxAdapter({
      broker: broker({
        status: "expired",
        refreshable: true,
        credential: "stale-and-actually-dead-token",
      }),
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.sources[0]).toMatchObject({
      status: "expired",
      error: "pi_minimax_credential_expired",
    });
  });

  it("does not report a confirmed expiry when probing a stored-expired token only fails transiently", async () => {
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    const report = await createMinimaxAdapter({
      broker: broker({
        status: "expired",
        refreshable: true,
        credential: "stale-token-server-is-just-down",
      }),
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.sources[0]).not.toMatchObject({
      status: "expired",
      error: "pi_minimax_credential_expired",
    });
    expect(report.sources[0]).toMatchObject({
      status: "error",
      error: "provider_unavailable",
    });
  });

  it("does not report a confirmed expiry when the re-resolve needed to probe it fails transiently", async () => {
    const request = vi.fn();
    const report = await createMinimaxAdapter({
      broker: {
        inspect: vi.fn(async () => "expired"),
        resolve: vi.fn(async () => {
          throw new Error("credential store became unreadable");
        }),
      },
      fetch: request,
    }).inspectAuth(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.sources[0]).not.toMatchObject({
      status: "expired",
      error: "pi_minimax_credential_expired",
    });
    expect(report.sources[0]).toMatchObject({
      status: "error",
      error: "credential_resolution_failed",
    });
  });
});

describe("MiniMax adapter identity", () => {
  it("exposes the expected id, label, and default adapter", () => {
    expect(minimaxAdapter.id).toBe("minimax");
    expect(minimaxAdapter.label).toBe("MiniMax");
  });

  it("coalesces concurrent fetchQuota calls into one request", async () => {
    const request = vi.fn(async () => jsonResponse(PROVISIONED_PAYLOAD));
    const adapter = testAdapter({ fetch: request });

    const [first, second] = await Promise.all([
      adapter.fetchQuota(OPTIONS),
      adapter.fetchQuota(OPTIONS),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function broker(
  resolution: MinimaxCredentialResolution,
): MinimaxCredentialBroker {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () =>
      resolution.status === "available"
        ? "available"
        : resolution.status === "expired"
          ? "expired"
          : resolution.status,
    ),
  };
}

function testAdapter(
  overrides: Parameters<typeof createMinimaxAdapter>[0] = {},
): ProviderAdapter {
  return createMinimaxAdapter({
    broker: broker({
      status: "available",
      kind: "api_key",
      credential: "synthetic-minimax-key-741",
    }),
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}
