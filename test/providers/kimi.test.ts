import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  createKimiAdapter,
  normalizeKimiPayload,
  normalizeRetryAfter,
} from "../../src/providers/kimi.js";
import type {
  KimiCodeCliCredentialInspection,
  KimiCodeCliCredentialResolution,
  KimiCodeCliCredentialSource,
} from "../../src/providers/kimi-code-cli-credential.js";
import type {
  KimiCredentialBroker,
  KimiCredentialInspection,
  KimiCredentialResolution,
} from "../../src/providers/pi-kimi-credential.js";
import type {
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
} from "../../src/types.js";

const NOW = Date.parse("2027-02-03T04:05:06.000Z");
const OPTIONS = { allowKeychainPrompt: false };

const PRINCIPAL = {
  limit: 640,
  used: 208,
  resetTime: "2027-02-08T17:00:00Z",
};

const SUCCESS_PAYLOAD = {
  usage: PRINCIPAL,
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: 80,
        remaining: 68,
        reset_at: "2027-02-03T09:05:06+00:00",
      },
    },
  ],
};

describe("Kimi request transport", () => {
  it("makes one fixed-origin read-only request with only the Pi-resolved key", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(SUCCESS_PAYLOAD),
    );
    const cliSource = cliCredentialSource({
      status: "available",
      accessToken: "lower-priority-cli-token",
    });
    const adapter = testAdapter({
      cliCredentialSource: cliSource,
      fetch: request,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    const url = new URL(String(input));
    expect({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || "443",
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    }).toEqual({
      protocol: "https:",
      hostname: "api.kimi.com",
      port: "443",
      pathname: "/coding/v1/usages",
      search: "",
      hash: "",
    });
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-kimi-key-741");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^quota-axi\/\d+\.\d+\.\d+$/);
    expect(headers.get("cookie")).toBeNull();
    expect(
      [...headers.keys()].some((name) =>
        /device|fingerprint|account|session/i.test(name),
      ),
    ).toBe(false);
    expect(report).toMatchObject({
      provider: "kimi",
      label: "Kimi",
      source: "api",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["pi:kimi-coding"],
      },
      attempts: [{ source: "pi:kimi-coding", status: "success" }],
    });
    expect(report.account).toBeUndefined();
    expect(report.plan).toBeUndefined();
    expect(report.credits).toBeUndefined();
    expect(cliSource.resolve).not.toHaveBeenCalled();
  });

  it.each(["missing", "unsupported"] as const)(
    "uses a fresh CLI credential after Pi reports %s",
    async (piStatus) => {
      const cliToken = "synthetic-cli-token-529";
      const request = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          jsonResponse(SUCCESS_PAYLOAD),
      );
      const adapter = testAdapter({
        broker: broker({ status: piStatus }),
        cliCredentialSource: cliCredentialSource({
          status: "available",
          accessToken: cliToken,
        }),
        fetch: request,
      });

      const report = await adapter.fetchQuota(OPTIONS);

      expect(request).toHaveBeenCalledOnce();
      const [input, init] = request.mock.calls[0];
      expect(String(input)).toBe("https://api.kimi.com/coding/v1/usages");
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "manual",
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${cliToken}`,
      );
      expect(report.state.sourcesTried).toEqual([
        "pi:kimi-coding",
        "kimi-code-cli",
      ]);
      expect(report.attempts).toEqual([
        {
          source: "pi:kimi-coding",
          status: "skipped",
          error:
            piStatus === "missing"
              ? "kimi_credential_unavailable"
              : "unsupported_credential_type",
        },
        { source: "kimi-code-cli", status: "success" },
      ]);
      expect(JSON.stringify(report)).not.toContain(cliToken);
    },
  );

  it("does not hide transport, decoding, or server failures by switching credentials", async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => {
        throw new Error("transport fixture");
      },
      async () =>
        new Response("{broken", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      async () => new Response(null, { status: 503 }),
      async () => new Response(null, { status: 401 }),
    ];

    for (const requestFailure of failures) {
      const cliSource = cliCredentialSource({
        status: "available",
        accessToken: "must-not-be-tried",
      });
      const report = await testAdapter({
        cliCredentialSource: cliSource,
        fetch: vi.fn(requestFailure),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).not.toBe("fresh");
      expect(cliSource.resolve).not.toHaveBeenCalled();
      expect(report.state.sourcesTried).toEqual(["pi:kimi-coding"]);
    }
  });

  it("coalesces concurrent acquisitions into one provider request", async () => {
    let finish: ((response: Response) => void) | undefined;
    const request = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const adapter = testAdapter({ fetch: request });

    const first = adapter.fetchQuota(OPTIONS);
    const second = adapter.fetchQuota(OPTIONS);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    finish?.(jsonResponse(SUCCESS_PAYLOAD));

    const [firstReport, secondReport] = await Promise.all([first, second]);
    expect(firstReport).toBe(secondReport);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects every redirect without a follow-up request", async () => {
    for (const status of [300, 301, 302, 303, 307, 308]) {
      const request = vi.fn(
        async () =>
          new Response("redirect payload", {
            status,
            headers: { location: "https://elsewhere.invalid/secret" },
          }),
      );
      const report = await testAdapter({ fetch: request }).fetchQuota(OPTIONS);
      expect(request).toHaveBeenCalledTimes(1);
      expect(report.state).toMatchObject({
        status: "error",
        stale: false,
        error: "redirect_rejected",
      });
    }
  });

  it.each([
    [503, "application/json", "provider_unavailable"],
    [200, "text/plain", "unexpected_content_type"],
  ] as const)(
    "awaits exactly one response cleanup for HTTP %i with %s",
    async (status, contentType, expectedError) => {
      let finishCleanup: (() => void) | undefined;
      const cancel = vi.fn(
        async () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("synthetic body"));
          },
          cancel,
        }),
        { status, headers: { "content-type": contentType } },
      );
      const reportPromise = testAdapter({
        fetch: vi.fn(async () => response),
      }).fetchQuota(OPTIONS);

      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      let settled = false;
      void reportPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      finishCleanup?.();
      const report = await reportPromise;

      expect(report.state.error).toBe(expectedError);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [503, "application/json", "provider_unavailable"],
    [200, "text/plain", "unexpected_content_type"],
  ] as const)(
    "closes a loopback streaming response and socket for HTTP %i with %s",
    async (status, contentType, expectedError) => {
      const fixture = await streamingServer(status, contentType);
      try {
        const report = await testAdapter({
          fetch: fixture.transport,
        }).fetchQuota(OPTIONS);

        expect(report.state.error).toBe(expectedError);
        await settlesWithin(fixture.responseClosed, "response close");
        await settlesWithin(fixture.socketClosed, "request socket close");
      } finally {
        await fixture.close();
      }
    },
  );

  it("enforces the total deadline while credential resolution is pending", async () => {
    const request = vi.fn();
    const broker: KimiCredentialBroker = {
      resolve: async () => new Promise<KimiCredentialResolution>(() => {}),
      inspect: async () => "available",
    };
    const cliSource = cliCredentialSource({
      status: "available",
      accessToken: "must-not-be-tried-after-timeout",
    });
    const report = await testAdapter({
      broker,
      cliCredentialSource: cliSource,
      fetch: request,
      deadlineMs: 5,
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("request_timeout");
    expect(request).not.toHaveBeenCalled();
    expect(cliSource.resolve).not.toHaveBeenCalled();
  });

  it("enforces the deadline when a fetch implementation does not honor abort", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => new Promise<Response>(() => {})),
      deadlineMs: 5,
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("request_timeout");
  });

  it("propagates deadline cancellation to the transport signal", async () => {
    let transportAborted = false;
    const report = await testAdapter({
      fetch: vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                transportAborted = true;
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      ),
      deadlineMs: 5,
    }).fetchQuota(OPTIONS);

    expect(transportAborted).toBe(true);
    expect(report.state.error).toBe("request_timeout");
  });

  it("cancels a pending response body at the total deadline", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull: async () => new Promise<void>(() => {}),
      cancel,
    });
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      deadlineMs: 5,
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("request_timeout");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects declared and streamed bodies over 262144 bytes", async () => {
    const declaredCancel = vi.fn();
    const declaredBody = new ReadableStream<Uint8Array>({
      pull: vi.fn(),
      cancel: declaredCancel,
    });
    const declared = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(declaredBody, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": "262145",
            },
          }),
      ),
    }).fetchQuota(OPTIONS);
    expect(declared.state.error).toBe("response_too_large");
    expect(declaredCancel).toHaveBeenCalledOnce();

    const cancel = vi.fn();
    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(262_145));
      },
      cancel,
    });
    const streamed = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(streamedBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    }).fetchQuota(OPTIONS);
    expect(streamed.state.error).toBe("response_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects wrong content type, invalid UTF-8, malformed JSON, and invalid schema", async () => {
    const cases: Array<[Response, string]> = [
      [
        new Response(JSON.stringify(SUCCESS_PAYLOAD), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
        "unexpected_content_type",
      ],
      [
        new Response(Uint8Array.from([0xc3, 0x28]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "response_invalid_utf8",
      ],
      [
        new Response("{unfinished", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "malformed_json",
      ],
      [jsonResponse({ usage: { limit: 0, used: 0 } }), "schema_invalid"],
    ];

    for (const [response, code] of cases) {
      const report = await testAdapter({
        fetch: vi.fn(async () => response),
      }).fetchQuota(OPTIONS);
      expect(report.state.error).toBe(code);
    }
  });

  it.each([
    [401, "auth_required", "provider_auth_rejected"],
    [403, "auth_required", "provider_auth_rejected"],
    [408, "error", "provider_timeout"],
    [429, "rate_limited", "provider_rate_limited"],
    [503, "error", "provider_unavailable"],
    [418, "error", "provider_request_rejected"],
  ])(
    "maps HTTP %i to bounded status and error",
    async (status, expectedStatus, code) => {
      const report = await testAdapter({
        fetch: vi.fn(
          async () => new Response("sensitive provider text", { status }),
        ),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe(expectedStatus);
      expect(report.state.error).toBe(code);
      expect(JSON.stringify(report)).not.toContain("sensitive provider text");
    },
  );

  it("normalizes integer and HTTP-date Retry-After and ignores invalid values", async () => {
    const now = () => NOW;
    for (const [value, expected] of [
      ["91", "2027-02-03T04:06:37.000Z"],
      ["Wed, 03 Feb 2027 05:06:07 GMT", "2027-02-03T05:06:07.000Z"],
      ["Wednesday, 03-Feb-27 05:06:07 GMT", "2027-02-03T05:06:07.000Z"],
      ["Wed Feb  3 05:06:07 2027", "2027-02-03T05:06:07.000Z"],
      ["Thursday, 03-Feb-27 05:06:07 GMT", undefined],
      ["1.5", undefined],
      ["soon", undefined],
    ] as const) {
      const report = await testAdapter({
        now,
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 429,
              headers: { "retry-after": value },
            }),
        ),
      }).fetchQuota(OPTIONS);
      expect(report.state.retryAfter).toBe(expected);
    }
    expect(normalizeRetryAfter("-1", NOW)).toBeUndefined();
  });

  it("maps local failures without exposing error text", async () => {
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    try {
      const sentinel = "SENTINEL-transport-secret-628159";
      const network = await testAdapter({
        fetch: vi.fn(async () => {
          throw new Error(sentinel);
        }),
      }).fetchQuota(OPTIONS);
      const tls = await testAdapter({
        fetch: vi.fn(async () => {
          throw { cause: { code: "CERT_SIGNATURE_FAILURE" }, sentinel };
        }),
      }).fetchQuota(OPTIONS);

      expect(network.state.error).toBe("network_unavailable");
      expect(tls.state.error).toBe("tls_failed");
      expect(JSON.stringify([network, tls])).not.toContain(sentinel);
      expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(
        true,
      );
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});

describe("Kimi payload normalization", () => {
  it("normalizes a principal weekly detail by itself", () => {
    expect(normalizeKimiPayload({ usage: { limit: 250, used: 55 } })).toEqual({
      windows: [
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed: 22,
          percentRemaining: 78,
        },
      ],
      diagnostics: [],
    });
  });

  it.each([
    [300, "TIME_UNIT_MINUTE"],
    [18_000, "TIME_UNIT_SECOND"],
    [5, "TIME_UNIT_HOUR"],
  ])(
    "identifies only an actual five-hour duration (%s %s)",
    (duration, timeUnit) => {
      const normalized = normalizeKimiPayload({
        usage: { limit: 900, remaining: 603 },
        limits: [
          {
            window: { duration, timeUnit },
            detail: { limit: 72, used: 9 },
          },
        ],
      });

      expect(normalized.windows[1]).toMatchObject({
        id: "five_hour",
        label: "session",
        kind: "session",
        windowSeconds: 18_000,
        percentUsed: 12.5,
        percentRemaining: 87.5,
      });
    },
  );

  it("accepts finite JSON numbers and strict numeric strings", () => {
    const normalized = normalizeKimiPayload({
      usage: { limit: " 8.0e2\n", used: 136 },
      limits: [
        {
          window: {
            duration: "5e0",
            timeUnit: "TIME_UNIT_HOUR",
          },
          detail: { limit: "64", remaining: "48.0" },
        },
      ],
    });
    expect(normalized.windows.map((window) => window.percentUsed)).toEqual([
      17, 25,
    ]);
  });

  it("derives used from remaining and gives explicit used precedence", () => {
    const remainingOnly = normalizeKimiPayload({
      usage: { limit: 700, remaining: 511 },
    }).windows[0];
    const inconsistent = normalizeKimiPayload({
      usage: { limit: 700, used: 119, remaining: 1 },
    }).windows[0];

    expect(remainingOnly.percentUsed).toBe(27);
    expect(inconsistent.percentUsed).toBe(17);
  });

  it("clamps percentages and derives the complement from the normalized used value", () => {
    const above = normalizeKimiPayload({
      usage: { limit: 40, used: 73 },
    }).windows[0];
    const below = normalizeKimiPayload({
      usage: { limit: 40, remaining: 99 },
    }).windows[0];

    expect([above.percentUsed, above.percentRemaining]).toEqual([100, 0]);
    expect([below.percentUsed, below.percentRemaining]).toEqual([0, 100]);
  });

  it.each([
    [{ used: 1 }, "missing limit"],
    [{ limit: 0, used: 0 }, "zero limit"],
    [{ limit: -8, used: 1 }, "negative limit"],
    [{ limit: "Infinity", used: 1 }, "nonfinite text"],
    [{ limit: "0x40", used: 1 }, "hex text"],
    [{ limit: "01", used: 1 }, "leading zero text"],
    [{ limit: 40, used: -1 }, "negative used"],
    [{ limit: 40, used: true }, "boolean used"],
    [{ limit: 40, used: [] }, "array used"],
  ])("rejects invalid principal numeric fields: %s", (detail) => {
    expect(() => normalizeKimiPayload({ usage: detail })).toThrow(
      "schema_invalid",
    );
  });

  it("uses the first valid reset alias and normalizes offsets and long fractions", () => {
    const aliases = ["resetTime", "resetAt", "reset_time", "reset_at"];
    for (const alias of aliases) {
      const normalized = normalizeKimiPayload({
        usage: {
          limit: 90,
          used: 18,
          [alias]: "2027-04-05T18:07:08.987654321+02:30",
        },
      });
      expect(normalized.windows[0].resetsAt).toBe("2027-04-05T15:37:08.987Z");
    }

    const fallback = normalizeKimiPayload({
      usage: {
        limit: 90,
        used: 18,
        resetTime: "not-a-time",
        resetAt: "2027-04-05T18:07:08Z",
      },
    });
    expect(fallback.windows[0].resetsAt).toBe("2027-04-05T18:07:08.000Z");
    expect(
      normalizeKimiPayload({
        usage: { limit: 90, used: 18, resetTime: "2027-02-30T00:00:00Z" },
      }).windows[0].resetsAt,
    ).toBeUndefined();
  });

  it("treats omitted, null, and empty limits as empty and diagnoses non-arrays", () => {
    for (const limits of [undefined, null, []]) {
      const payload: Record<string, unknown> = {
        usage: { limit: 44, used: 11 },
      };
      if (limits !== undefined) payload.limits = limits;
      const normalized = normalizeKimiPayload(payload);
      expect(normalized.windows).toHaveLength(1);
      expect(normalized.diagnostics).toEqual([]);
    }

    const invalid = normalizeKimiPayload({
      usage: { limit: 44, used: 11 },
      limits: { future: true },
    });
    expect(invalid.windows).toHaveLength(1);
    expect(invalid.diagnostics).toEqual([{ code: "limits_invalid" }]);
  });

  it("preserves wire order for unknown limits, malformed entries, and duplicate five-hour entries", () => {
    const normalized = normalizeKimiPayload({
      usage: { limit: 100, used: 29, futureField: "ignored" },
      limits: [
        {
          window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
          detail: { limit: 50, used: 5 },
          extra: { ignored: true },
        },
        { detail: { limit: 0, used: 0 } },
        {
          window: { duration: 5, timeUnit: "TIME_UNIT_FORTNIGHT" },
          detail: { limit: 50, used: 10 },
        },
        {
          window: { duration: 18_000, timeUnit: "TIME_UNIT_SECOND" },
          detail: { limit: 50, used: 15 },
        },
      ],
    });

    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "weekly",
      "five_hour",
      "limit:3",
      "limit:4",
    ]);
    expect(normalized.windows[2].windowSeconds).toBeUndefined();
    expect(normalized.windows[3]).toMatchObject({
      kind: "unknown",
      label: "limit 4",
      windowSeconds: 18_000,
    });
    expect(normalized.diagnostics).toEqual([
      { code: "detail_invalid", index: 2 },
    ]);
  });

  it("skips only invalid additional details", () => {
    const normalized = normalizeKimiPayload({
      usage: { limit: 120, used: 24 },
      limits: [
        null,
        { detail: { limit: "NaN", used: 1 } },
        { detail: { limit: 30, remaining: 21 } },
      ],
    });
    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "weekly",
      "limit:3",
    ]);
    expect(normalized.diagnostics).toEqual([
      { code: "detail_invalid", index: 1 },
      { code: "detail_invalid", index: 2 },
    ]);
  });

  it("never projects account, plan, monthly, extra-usage, or model fields", () => {
    const normalized = normalizeKimiPayload({
      account: { email: "private@example.invalid" },
      plan: "private-plan",
      monthly: { limit: 1, used: 1 },
      extraUsage: { limit: 1, used: 1 },
      models: [{ name: "private-model" }],
      usage: { limit: 70, used: 7 },
    });
    const serialized = JSON.stringify(normalized);
    for (const prohibited of [
      "private@example.invalid",
      "private-plan",
      "monthly",
      "extraUsage",
      "private-model",
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });
});

describe("Kimi credential outcomes and cache policy", () => {
  it.each([
    ["missing", "kimi_credential_unavailable"],
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
        readCachedProvider: () => cachedQuota(),
      }).fetchQuota(OPTIONS);

      expect(request).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith("kimi");
      expect(report.state).toMatchObject({
        status: "auth_required",
        stale: false,
        error: code,
      });
      expect(report.windows).toEqual([]);
    },
  );

  it("uses eligible cached windows after an unexpected resolver failure", async () => {
    const cached = cachedQuota();
    const report = await testAdapter({
      broker: broker({ status: "error" }),
      readCachedProvider: () => cached,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "cache",
      windows: cached.windows,
      state: {
        status: "stale",
        stale: true,
        error: "credential_resolution_failed",
        refreshedAt: cached.state.refreshedAt,
        sourcesTried: ["pi:kimi-coding", "cache"],
      },
    });
  });

  it("uses stale cache for transient HTTP and parser failures", async () => {
    for (const response of [
      new Response(null, { status: 408 }),
      new Response(null, { status: 502 }),
      new Response("broken", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      jsonResponse({ usage: { limit: 0, used: 0 } }),
    ]) {
      const report = await testAdapter({
        fetch: vi.fn(async () => response),
        readCachedProvider: () => cachedQuota(),
      }).fetchQuota(OPTIONS);
      expect(report.state.status).toBe("stale");
      expect(report.source).toBe("cache");
    }
  });

  it("preserves Retry-After on a stale rate-limited report", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      ),
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "stale",
      error: "provider_rate_limited",
      retryAfter: "2027-02-03T04:07:06.000Z",
    });
  });

  it("drops passed reset windows but preserves other eligible windows", async () => {
    const cached = cachedQuota([
      quotaWindow("five_hour", "session", "2027-02-03T04:05:06.000Z"),
      quotaWindow("weekly", "weekly", "2027-02-04T04:05:06.000Z"),
      quotaWindow("limit:3", "unknown", "2027-02-03T04:05:05.999Z"),
    ]);
    const report = await transientWithCache(cached);

    expect(report.windows.map(({ id }) => id)).toEqual(["weekly"]);
  });

  it("expires no-reset session and weekly windows at their exact age limits", async () => {
    const windows = [
      quotaWindow("five_hour", "session"),
      quotaWindow("weekly", "weekly"),
      quotaWindow("limit:2", "unknown"),
    ];
    const justBeforeFiveHours = await transientWithCache(
      cachedQuota(windows, NOW - 18_000_000 + 1),
    );
    expect(justBeforeFiveHours.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "weekly",
      "limit:2",
    ]);

    const atFiveHours = await transientWithCache(
      cachedQuota(windows, NOW - 18_000_000),
    );
    expect(atFiveHours.windows.map(({ id }) => id)).toEqual(["weekly"]);

    const atSevenDays = await transientWithCache(
      cachedQuota(windows, NOW - 7 * 24 * 60 * 60 * 1_000),
    );
    expect(atSevenDays.state.status).toBe("error");
    expect(atSevenDays.windows).toEqual([]);
  });

  it("returns the current failure when no stale window survives", async () => {
    const report = await transientWithCache(
      cachedQuota(
        [quotaWindow("weekly", "weekly", "2027-02-03T04:05:05.000Z")],
        NOW - 1_000,
      ),
    );
    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", stale: false, error: "provider_unavailable" },
    });
  });

  it("retires cache after provider auth rejection", async () => {
    const remove = vi.fn();
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 403 })),
      deleteCachedProvider: remove,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(remove).toHaveBeenCalledWith("kimi");
    expect(report.state.status).toBe("auth_required");
    expect(report.source).toBe("unavailable");
  });

  it("does not use cache from an untrusted provenance", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      readCachedProvider: () => ({ ...cachedQuota(), source: "web" }),
    }).fetchQuota(OPTIONS);
    expect(report.state.status).toBe("error");
    expect(report.source).toBe("unavailable");
  });

  it("reports auth availability without a path or credential", async () => {
    for (const [inspection, expected] of [
      ["available", { status: "available" }],
      ["missing", { status: "missing" }],
      [
        "unsupported",
        { status: "invalid", error: "unsupported_credential_type" },
      ],
      ["error", { status: "invalid", error: "credential_resolution_failed" }],
    ] as const) {
      const report = await testAdapter({
        broker: broker({ status: "missing" }, inspection),
      }).inspectAuth(OPTIONS);
      expect(report).toEqual({
        provider: "kimi",
        sources: [
          { source: "pi:kimi-coding", ...expected },
          { source: "kimi-code-cli", status: "missing" },
        ],
      });
      expect(JSON.stringify(report)).not.toMatch(
        /path|apiKey|token|fingerprint/i,
      );
    }
  });

  it.each([
    ["available", "available", undefined],
    ["missing", "missing", undefined],
    ["invalid", "invalid", "kimi_code_cli_credential_invalid"],
    ["expired", "expired", "kimi_code_cli_credential_expired"],
    ["error", "invalid", "credential_resolution_failed"],
  ] as const)(
    "reports CLI credential state %s without a path or value",
    async (inspection, expectedStatus, error) => {
      const report = await testAdapter({
        cliCredentialSource: cliCredentialSource(
          { status: "missing" },
          inspection,
        ),
      }).inspectAuth(OPTIONS);

      expect(report.sources[1]).toEqual({
        source: "kimi-code-cli",
        status: expectedStatus,
        ...(error ? { error } : {}),
      });
      expect(report.sources[1].path).toBeUndefined();
    },
  );

  it.each([
    ["invalid", "kimi_code_cli_credential_invalid"],
    ["expired", "kimi_code_cli_credential_expired"],
  ] as const)(
    "fails closed for a %s CLI credential after Pi is unavailable",
    async (status, error) => {
      const request = vi.fn();
      const remove = vi.fn();
      const report = await testAdapter({
        broker: broker({ status: "missing" }),
        cliCredentialSource: cliCredentialSource({ status }),
        fetch: request,
        deleteCachedProvider: remove,
      }).fetchQuota(OPTIONS);

      expect(request).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith("kimi");
      expect(report.state).toMatchObject({
        status: "auth_required",
        stale: false,
        error,
        sourcesTried: ["pi:kimi-coding", "kimi-code-cli"],
      });
    },
  );

  it("preserves stale cache after a CLI credential read failure", async () => {
    const remove = vi.fn();
    const report = await testAdapter({
      broker: broker({ status: "missing" }),
      cliCredentialSource: cliCredentialSource({ status: "error" }),
      readCachedProvider: () => cachedQuota(),
      deleteCachedProvider: remove,
    }).fetchQuota(OPTIONS);

    expect(remove).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      source: "cache",
      state: {
        status: "stale",
        error: "credential_resolution_failed",
        sourcesTried: ["pi:kimi-coding", "kimi-code-cli", "cache"],
      },
      attempts: [
        {
          source: "pi:kimi-coding",
          status: "skipped",
          error: "kimi_credential_unavailable",
        },
        {
          source: "kimi-code-cli",
          status: "failed",
          error: "credential_resolution_failed",
        },
      ],
    });
  });

  it("never exposes a sentinel credential through reports or attempts", async () => {
    const sentinel = "KIMI-SENTINEL-DO-NOT-LEAK-938475";
    const report = await testAdapter({
      broker: broker({ status: "available", apiKey: sentinel }),
      fetch: vi.fn(
        async () =>
          new Response(`provider body includes ${sentinel}`, { status: 500 }),
      ),
    }).fetchQuota(OPTIONS);

    expect(JSON.stringify(report)).not.toContain(sentinel);
    expect(report.attempts).toEqual([
      {
        source: "pi:kimi-coding",
        status: "failed",
        error: "provider_unavailable",
      },
    ]);
  });
});

function testAdapter(
  overrides: Parameters<typeof createKimiAdapter>[0] = {},
): ProviderAdapter {
  return createKimiAdapter({
    broker: broker({
      status: "available",
      apiKey: "synthetic-kimi-key-741",
    }),
    cliCredentialSource: cliCredentialSource({ status: "missing" }),
    fetch: vi.fn(async () =>
      jsonResponse(SUCCESS_PAYLOAD),
    ) as unknown as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function broker(
  resolution: KimiCredentialResolution,
  inspection: KimiCredentialInspection = resolution.status === "available"
    ? "available"
    : resolution.status,
): KimiCredentialBroker {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => inspection),
  };
}

function cliCredentialSource(
  resolution: KimiCodeCliCredentialResolution,
  inspection: KimiCodeCliCredentialInspection = resolution.status,
): KimiCodeCliCredentialSource {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => inspection),
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cachedQuota(
  windows: QuotaWindow[] = [
    quotaWindow("five_hour", "session", "2027-02-03T09:05:06.000Z"),
    quotaWindow("weekly", "weekly", "2027-02-08T04:05:06.000Z"),
  ],
  refreshedAt = NOW - 60_000,
): ProviderQuota {
  return {
    provider: "kimi",
    label: "Kimi",
    source: "api",
    windows,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(refreshedAt).toISOString(),
      sourcesTried: ["pi:kimi-coding"],
    },
  };
}

function quotaWindow(
  id: string,
  kind: QuotaWindow["kind"],
  resetsAt?: string,
): QuotaWindow {
  return {
    id,
    label: id,
    kind,
    percentUsed: 31.25,
    percentRemaining: 68.75,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

async function transientWithCache(
  cached: ProviderQuota,
): Promise<ProviderQuota> {
  return testAdapter({
    fetch: vi.fn(async () => new Response(null, { status: 503 })),
    readCachedProvider: () => cached,
  }).fetchQuota(OPTIONS);
}

type StreamingServerFixture = {
  transport: typeof globalThis.fetch;
  responseClosed: Promise<void>;
  socketClosed: Promise<void>;
  close(): Promise<void>;
};

async function streamingServer(
  status: number,
  contentType: string,
): Promise<StreamingServerFixture> {
  const responseClose = deferred();
  const socketClose = deferred();
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.once("close", responseClose.resolve);
    response.socket?.once("close", socketClose.resolve);
    response.writeHead(status, { "content-type": contentType });
    response.write("synthetic streaming response");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const loopbackUrl = `http://127.0.0.1:${address.port}/usage`;

  return {
    transport: async (input, init) => {
      expect(String(input)).toBe("https://api.kimi.com/coding/v1/usages");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
      });
      return globalThis.fetch(loopbackUrl, init);
    },
    responseClosed: responseClose.promise,
    socketClosed: socketClose.promise,
    async close() {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function settlesWithin(
  promise: Promise<void>,
  description: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} did not settle`)),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
