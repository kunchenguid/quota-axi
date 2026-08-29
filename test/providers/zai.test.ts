import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createOpencodeAuthCredentialSource,
  createZaiAdapter,
  extractZaiCredential,
  normalizeRetryAfter,
  normalizeZaiPayload,
  opencodeAuthFilePath,
  type ZaiCredentialResolution,
  type ZaiCredentialSource,
} from "../../src/providers/zai.js";
import type {
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
} from "../../src/types.js";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const SYNTHETIC_KEY = "synthetic-zai-key-481";

const RESET_FIVE_HOUR = 1_786_643_056_425;
const RESET_WEEKLY = 1_786_759_220_997;
const RESET_MCP = 1_787_623_220_999;

const QUOTA_PAYLOAD = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 0,
        remaining: 4000,
        percentage: 0,
        nextResetTime: RESET_MCP,
        usageDetails: [{ modelCode: "search-prime", usage: 0 }],
      },
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 37,
        nextResetTime: RESET_FIVE_HOUR,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: 50,
        nextResetTime: RESET_WEEKLY,
      },
    ],
    level: "max",
  },
  success: true,
};

describe("Z.AI request transport", () => {
  it("makes one fixed-origin read-only request with a bare token", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(QUOTA_PAYLOAD),
    );
    const adapter = testAdapter({ fetch: request });

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
      hostname: "api.z.ai",
      port: "443",
      pathname: "/api/monitor/usage/quota/limit",
      search: "",
      hash: "",
    });
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(SYNTHETIC_KEY);
    expect(headers.get("accept-language")).toBe("en-US,en");
    expect(headers.get("user-agent")).toMatch(/^quota-axi\/\d+\.\d+\.\d+$/);
    expect(headers.get("cookie")).toBeNull();
    expect(
      [...headers.keys()].some((name) =>
        /device|fingerprint|account|session/i.test(name),
      ),
    ).toBe(false);
    expect(report).toMatchObject({
      provider: "zai",
      label: "Z.AI",
      source: "api",
      plan: "max",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["opencode:auth.json"],
      },
      attempts: [{ source: "opencode:auth.json", status: "success" }],
    });
    expect(report.account).toBeUndefined();
    expect(report.credits).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
  });

  it("targets the Zhipu host when the credential is scoped to zhipu", async () => {
    const request = vi.fn(async () => jsonResponse(QUOTA_PAYLOAD));
    const adapter = createZaiAdapter({
      credentialSource: credentialSource({
        status: "available",
        apiKey: SYNTHETIC_KEY,
        host: "open.bigmodel.cn",
        path: "/home/user/.local/share/opencode/auth.json",
      }),
      fetch: request,
      readCachedProvider: () => undefined,
      deleteCachedProvider: () => undefined,
      now: () => NOW,
    });

    await adapter.fetchQuota(OPTIONS);

    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.hostname).toBe("open.bigmodel.cn");
    expect(url.pathname).toBe("/api/monitor/usage/quota/limit");
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
    finish?.(jsonResponse(QUOTA_PAYLOAD));

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
      ["91", "2026-08-13T12:01:31.000Z"],
      ["Wed, 13 Aug 2026 12:06:07 GMT", "2026-08-13T12:06:07.000Z"],
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

  it("enforces the deadline when a fetch implementation does not honor abort", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => new Promise<Response>(() => {})),
      deadlineMs: 5,
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("request_timeout");
  });

  it("rejects invalid UTF-8, malformed JSON, and invalid schema", async () => {
    const cases: Array<[Response, string]> = [
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
      [jsonResponse({ code: 200, data: {} }), "schema_invalid"],
      [jsonResponse({ data: { limits: [] } }), "schema_invalid"],
    ];

    for (const [response, code] of cases) {
      const report = await testAdapter({
        fetch: vi.fn(async () => response),
      }).fetchQuota(OPTIONS);
      expect(report.state.error).toBe(code);
    }
  });

  it("parses a JSON body regardless of the declared content type", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify(QUOTA_PAYLOAD), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows.length).toBe(3);
  });
});

describe("Z.AI payload normalization", () => {
  it("maps the live capture to five-hour, weekly, and MCP-month windows", () => {
    const normalized = normalizeZaiPayload(QUOTA_PAYLOAD);
    expect(normalized.plan).toBe("max");
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.windows).toEqual([
      {
        id: "mcp_month",
        label: "MCP month",
        kind: "monthly",
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: new Date(RESET_MCP).toISOString(),
      },
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 37,
        percentRemaining: 63,
        windowSeconds: 18_000,
        resetsAt: new Date(RESET_FIVE_HOUR).toISOString(),
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 50,
        percentRemaining: 50,
        windowSeconds: 604_800,
        resetsAt: new Date(RESET_WEEKLY).toISOString(),
      },
    ]);
  });

  it("identifies the two TOKENS_LIMIT windows by unit and number, not order", () => {
    const reordered = {
      data: {
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            number: 1,
            percentage: 50,
            nextResetTime: RESET_WEEKLY,
          },
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 37,
            nextResetTime: RESET_FIVE_HOUR,
          },
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            percentage: 0,
            nextResetTime: RESET_MCP,
          },
        ],
        level: "max",
      },
    };
    const byId = Object.fromEntries(
      normalizeZaiPayload(reordered).windows.map((window) => [
        window.id,
        window,
      ]),
    );
    expect(Object.keys(byId).sort()).toEqual([
      "five_hour",
      "mcp_month",
      "weekly",
    ]);
    expect(byId.five_hour.kind).toBe("session");
    expect(byId.five_hour.windowSeconds).toBe(18_000);
    expect(byId.weekly.kind).toBe("weekly");
    expect(byId.weekly.windowSeconds).toBe(604_800);
    expect(byId.mcp_month.kind).toBe("monthly");
  });

  it("identifies CREDIT_LIMIT windows by the same unit and number magic values", () => {
    const normalized = normalizeZaiPayload({
      data: {
        limits: [
          {
            type: "CREDIT_LIMIT",
            unit: 3,
            number: 5,
            percentage: 10,
            nextResetTime: RESET_FIVE_HOUR,
          },
          {
            type: "CREDIT_LIMIT",
            unit: 6,
            number: 1,
            percentage: 47,
            nextResetTime: RESET_WEEKLY,
          },
        ],
        level: "max",
      },
    });
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.windows).toEqual([
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 10,
        percentRemaining: 90,
        windowSeconds: 18_000,
        resetsAt: new Date(RESET_FIVE_HOUR).toISOString(),
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 47,
        percentRemaining: 53,
        windowSeconds: 604_800,
        resetsAt: new Date(RESET_WEEKLY).toISOString(),
      },
    ]);
  });

  it("reports CREDIT_LIMIT windows as trusted in the provider report", async () => {
    const report = await testAdapter({
      fetch: (async () =>
        jsonResponse({
          data: {
            limits: [
              {
                type: "CREDIT_LIMIT",
                unit: 3,
                number: 5,
                percentage: 10,
                nextResetTime: RESET_FIVE_HOUR,
              },
              {
                type: "CREDIT_LIMIT",
                unit: 6,
                number: 1,
                percentage: 47,
                nextResetTime: RESET_WEEKLY,
              },
            ],
            level: "max",
          },
        })) as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.state.untrustedWindowIds).toBeUndefined();
    expect(report.windows.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "five_hour", kind: "session" },
      { id: "weekly", kind: "weekly" },
    ]);
  });

  it("derives MCP percentage from currentValue/usage when percentage is absent", () => {
    const normalized = normalizeZaiPayload({
      data: {
        limits: [
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            usage: 4000,
            currentValue: 1200,
            nextResetTime: RESET_MCP,
          },
        ],
      },
    });
    expect(normalized.windows[0]).toMatchObject({
      id: "mcp_month",
      percentUsed: 30,
      percentRemaining: 70,
    });
  });

  it("flags unrecognized limit entries as untrusted unknown windows", () => {
    const normalized = normalizeZaiPayload({
      data: {
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 10,
            nextResetTime: RESET_FIVE_HOUR,
          },
          {
            type: "UNKNOWN_LIMIT",
            unit: 9,
            number: 2,
            percentage: 5,
            nextResetTime: RESET_MCP,
          },
        ],
      },
    });
    expect(normalized.windows.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "five_hour", kind: "session" },
      { id: "limit:2", kind: "unknown" },
    ]);
    expect(normalized.diagnostics).toEqual([
      { code: "entry_unrecognized", index: 2 },
    ]);
  });

  it("downgrades a duplicate recognized window to an unknown limit", () => {
    const normalized = normalizeZaiPayload({
      data: {
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 12,
            nextResetTime: RESET_FIVE_HOUR,
          },
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 80,
            nextResetTime: RESET_FIVE_HOUR,
          },
        ],
      },
    });
    expect(normalized.windows).toEqual([
      expect.objectContaining({
        id: "five_hour",
        kind: "session",
        windowSeconds: 18_000,
      }),
      expect.objectContaining({
        id: "limit:2",
        label: "limit 2",
        kind: "unknown",
        percentUsed: 80,
        percentRemaining: 20,
      }),
    ]);
    expect(normalized.windows[1].windowSeconds).toBeUndefined();
    expect(normalized.diagnostics).toEqual([
      { code: "entry_unrecognized", index: 2 },
    ]);
  });

  it("flags a duplicate recognized window as untrusted in the provider report", async () => {
    const report = await testAdapter({
      fetch: (async () =>
        jsonResponse({
          data: {
            limits: [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 12,
                nextResetTime: RESET_FIVE_HOUR,
              },
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 80,
                nextResetTime: RESET_FIVE_HOUR,
              },
            ],
          },
        })) as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(report.state.untrustedWindowIds).toEqual(["limit:2"]);
    expect(report.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "limit:2",
    ]);
  });

  it("tolerates a missing envelope by reading limits from the root", () => {
    const normalized = normalizeZaiPayload({
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 1,
          percentage: 50,
          nextResetTime: RESET_WEEKLY,
        },
      ],
    });
    expect(normalized.windows.map(({ id }) => id)).toEqual(["weekly"]);
  });

  it("skips structurally invalid entries as diagnostics without a window", () => {
    const normalized = normalizeZaiPayload({
      data: {
        limits: [
          "not-an-object",
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            percentage: 1,
            nextResetTime: RESET_MCP,
          },
        ],
      },
    });
    expect(normalized.windows.map(({ id }) => id)).toEqual(["mcp_month"]);
    expect(normalized.diagnostics).toEqual([
      { code: "entry_invalid", index: 1 },
    ]);
  });

  it("throws schema_invalid for a missing or non-array limits field", () => {
    expect(() => normalizeZaiPayload({ data: {} })).toThrow();
    expect(() => normalizeZaiPayload({ data: { limits: "no" } })).toThrow();
    expect(() => normalizeZaiPayload({ data: { limits: [] } })).toThrow();
  });
});

describe("Z.AI credential discovery", () => {
  const PATH = "/home/user/.local/share/opencode/auth.json";

  it.each([
    ["zai-coding-plan", { "zai-coding-plan": { key: "k" } }],
    ["zai", { zai: { apiKey: "k" } }],
    ["z-ai", { "z-ai": { api_key: "k" } }],
    ["z.ai", { "z.ai": { token: "k" } }],
    ["zhipu", { zhipu: { accessToken: "k" } }],
    ["zhipuai", { zhipuai: { auth_token: "k" } }],
  ])("extracts the key from a %s object entry", (providerId, entry) => {
    const resolution = extractZaiCredential(entry, PATH);
    expect(resolution.status).toBe("available");
    if (resolution.status !== "available") return;
    expect(resolution.apiKey).toBe("k");
    expect(resolution.host).toBe(
      providerId === "zhipu" || providerId === "zhipuai"
        ? "open.bigmodel.cn"
        : "api.z.ai",
    );
  });

  it("accepts a bare string entry", () => {
    const resolution = extractZaiCredential({ zai: "literal-key" }, PATH);
    expect(resolution).toEqual({
      status: "available",
      apiKey: "literal-key",
      host: "api.z.ai",
      path: PATH,
    });
  });

  it("prefers the first matching provider id in declaration order", () => {
    const resolution = extractZaiCredential(
      { zhipu: { key: "cn-key" }, "zai-coding-plan": { key: "global-key" } },
      PATH,
    );
    expect(resolution).toMatchObject({
      apiKey: "global-key",
      host: "api.z.ai",
    });
  });

  it("reports missing when no provider id is present", () => {
    expect(extractZaiCredential({ openai: { key: "k" } }, PATH)).toEqual({
      status: "missing",
      path: PATH,
    });
  });

  it("reports missing when the matching entry has no extractable key", () => {
    expect(extractZaiCredential({ zai: { type: "api" } }, PATH)).toEqual({
      status: "missing",
      path: PATH,
    });
  });

  it.each([
    ["a control byte", { zai: { key: "line-one\nline-two" } }],
    ["an environment reference", { zai: { key: "${ZAI_API_KEY}" } }],
    ["a command reference", { zai: { key: "!op read op://zai/key" } }],
    ["a blank value", { zai: { key: "   " } }],
    ["a bare string with a control byte", { zai: "line-one\rline-two" }],
  ])("rejects a key holding %s", (_label, entry) => {
    expect(extractZaiCredential(entry, PATH)).toEqual({
      status: "missing",
      path: PATH,
    });
  });

  it("makes no request when the stored key is not a usable literal secret", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      credentialSource: credentialSource(
        extractZaiCredential({ zai: { key: "bad\nkey" } }, PATH),
      ),
      fetch: request,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "zai_credential_unavailable",
    });
  });

  it("reports invalid for a non-object auth document", () => {
    expect(extractZaiCredential("not-an-object", PATH)).toEqual({
      status: "invalid",
      path: PATH,
      error: "json_parse_error",
    });
  });

  it("makes no request and retires cache for missing credentials", async () => {
    const request = vi.fn();
    const remove = vi.fn();
    const report = await testAdapter({
      credentialSource: credentialSource({ status: "missing", path: PATH }),
      fetch: request,
      deleteCachedProvider: remove,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("zai");
    expect(report.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "zai_credential_unavailable",
    });
    expect(report.windows).toEqual([]);
  });

  it("makes no request and retires cache for invalid credentials", async () => {
    const request = vi.fn();
    const remove = vi.fn();
    const report = await testAdapter({
      credentialSource: credentialSource({
        status: "invalid",
        path: PATH,
        error: "json_parse_error",
      }),
      fetch: request,
      deleteCachedProvider: remove,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("zai");
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "zai_credential_invalid",
    });
  });

  it("serves stale cache and keeps it when the auth file cannot be read", async () => {
    const request = vi.fn();
    const remove = vi.fn();
    const report = await testAdapter({
      credentialSource: credentialSource({
        status: "error",
        path: PATH,
        error: "file_read_error",
      }),
      fetch: request,
      deleteCachedProvider: remove,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(report.source).toBe("cache");
    expect(report.state).toMatchObject({
      status: "stale",
      stale: true,
      error: "credential_resolution_failed",
    });
    expect(report.windows.length).toBeGreaterThan(0);
    expect(report.attempts).toEqual([
      {
        source: "opencode:auth.json",
        status: "failed",
        error: "credential_resolution_failed",
      },
    ]);
  });

  it("resolves an unreadable auth file to an error, not an invalid credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-zai-"));
    try {
      const authFile = join(directory, "auth.json");
      mkdirSync(authFile);
      const source = createOpencodeAuthCredentialSource(() => authFile);

      expect(source.resolve()).toEqual({
        status: "error",
        path: authFile,
        error: "file_read_error",
      });
      expect(source.inspect()).toEqual({
        status: "error",
        path: authFile,
        error: "file_read_error",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves a malformed auth file to an invalid credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-zai-"));
    try {
      const authFile = join(directory, "auth.json");
      writeFileSync(authFile, "{broken");
      const source = createOpencodeAuthCredentialSource(() => authFile);

      expect(source.resolve()).toEqual({
        status: "invalid",
        path: authFile,
        error: "json_parse_error",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves the auth path from XDG_DATA_HOME", () => {
    const original = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/custom/xdg";
      expect(opencodeAuthFilePath()).toBe("/custom/xdg/opencode/auth.json");
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });
});

describe("Z.AI cache fallback", () => {
  it("drops cache on a definitive 401 auth rejection", async () => {
    const remove = vi.fn();
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
      deleteCachedProvider: remove,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(remove).toHaveBeenCalledWith("zai");
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
    expect(report.source).toBe("unavailable");
    expect(report.windows).toEqual([]);
  });

  it("uses stale cache for transient HTTP failures", async () => {
    for (const response of [
      new Response(null, { status: 408 }),
      new Response(null, { status: 502 }),
      new Response(null, { status: 503 }),
    ]) {
      const report = await testAdapter({
        fetch: vi.fn(async () => response),
        readCachedProvider: () => cachedQuota(),
      }).fetchQuota(OPTIONS);
      expect(report.state.status).toBe("stale");
      expect(report.source).toBe("cache");
    }
  });

  it("carries the cached plan label into a stale report", async () => {
    const report = await transientWithCache(cachedQuota());

    expect(report.state.status).toBe("stale");
    expect(report.plan).toBe("max");
  });

  it("omits plan on a stale report when the cache has none", async () => {
    const withoutPlan = cachedQuota();
    delete withoutPlan.plan;
    const report = await transientWithCache(withoutPlan);

    expect(report.state.status).toBe("stale");
    expect(report.plan).toBeUndefined();
  });

  it("does not fall back to cache for malformed responses", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response("{broken", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("malformed_json");
    expect(report.source).toBe("unavailable");
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
      retryAfter: "2026-08-13T12:02:00.000Z",
    });
  });

  it("drops passed-reset windows but preserves other eligible windows", async () => {
    const cached = cachedQuota([
      quotaWindow("five_hour", "session", "2026-08-13T12:00:00.000Z"),
      quotaWindow("weekly", "weekly", "2026-08-18T12:00:00.000Z"),
      quotaWindow("mcp_month", "monthly", "2026-08-20T12:00:00.000Z"),
    ]);
    const report = await transientWithCache(cached);

    expect(report.windows.map(({ id }) => id)).toEqual(["weekly", "mcp_month"]);
  });

  it("expires no-reset session and monthly windows at their age limits", async () => {
    const windows = [
      quotaWindow("five_hour", "session"),
      quotaWindow("weekly", "weekly"),
      quotaWindow("mcp_month", "monthly"),
    ];
    const justBeforeFiveHours = await transientWithCache(
      cachedQuota(windows, NOW - 18_000_000 + 1),
    );
    expect(justBeforeFiveHours.windows.map(({ id }) => id).sort()).toEqual([
      "five_hour",
      "mcp_month",
      "weekly",
    ]);

    const atFiveHours = await transientWithCache(
      cachedQuota(windows, NOW - 18_000_000),
    );
    expect(atFiveHours.windows.map(({ id }) => id).sort()).toEqual([
      "mcp_month",
      "weekly",
    ]);

    const atMonth = await transientWithCache(
      cachedQuota(windows, NOW - 30 * 24 * 60 * 60 * 1_000),
    );
    expect(atMonth.state.status).toBe("error");
    expect(atMonth.windows).toEqual([]);
  });
});

describe("Z.AI auth inspection", () => {
  it.each([
    ["available", "available", undefined],
    ["missing", "missing", undefined],
    ["invalid", "invalid", "json_parse_error"],
    ["error", "error", "file_read_error"],
  ] as const)(
    "reports %s credential state with the probed path and no value",
    async (status, expectedStatus, error) => {
      const path = "/home/user/.local/share/opencode/auth.json";
      const report = await testAdapter({
        credentialSource: credentialSource(
          status === "available"
            ? {
                status: "available",
                apiKey: SYNTHETIC_KEY,
                host: "api.z.ai",
                path,
              }
            : status === "missing"
              ? { status: "missing", path }
              : { status, path, error: error ?? "json_parse_error" },
        ),
      }).inspectAuth(OPTIONS);

      expect(report).toEqual({
        provider: "zai",
        sources: [
          {
            source: "opencode:auth.json",
            path,
            status: expectedStatus,
            ...(error ? { error } : {}),
          },
        ],
      });
      expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
    },
  );
});

function testAdapter(
  overrides: Partial<Parameters<typeof createZaiAdapter>[0]> = {},
): ProviderAdapter {
  return createZaiAdapter({
    credentialSource: credentialSource({
      status: "available",
      apiKey: SYNTHETIC_KEY,
      host: "api.z.ai",
      path: "/home/user/.local/share/opencode/auth.json",
    }),
    fetch: vi.fn(async () =>
      jsonResponse(QUOTA_PAYLOAD),
    ) as unknown as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function credentialSource(
  resolution: ZaiCredentialResolution,
): ZaiCredentialSource {
  const inspection =
    resolution.status === "available"
      ? { status: "available" as const, path: resolution.path }
      : resolution.status === "missing"
        ? { status: "missing" as const, path: resolution.path }
        : {
            status: resolution.status,
            path: resolution.path,
            error: resolution.error,
          };
  return {
    resolve: vi.fn(() => resolution),
    inspect: vi.fn(() => inspection),
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
    quotaWindow("five_hour", "session", "2026-08-13T15:00:00.000Z"),
    quotaWindow("weekly", "weekly", "2026-08-18T12:00:00.000Z"),
    quotaWindow("mcp_month", "monthly", "2026-08-28T12:00:00.000Z"),
  ],
  refreshedAt = NOW - 60_000,
): ProviderQuota {
  return {
    provider: "zai",
    label: "Z.AI",
    source: "api",
    plan: "max",
    windows,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(refreshedAt).toISOString(),
      sourcesTried: ["opencode:auth.json"],
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
    percentUsed: 31,
    percentRemaining: 69,
    ...(id === "five_hour"
      ? { windowSeconds: 18_000 }
      : id === "weekly"
        ? { windowSeconds: 604_800 }
        : {}),
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
