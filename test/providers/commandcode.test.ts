import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createCommandCodeAdapter,
  COMMANDCODE_API_ORIGIN,
  COMMANDCODE_CREDITS_PATH,
  COMMANDCODE_SOURCE_ORDER,
  COMMANDCODE_WHOAMI_PATH,
  normalizeCommandCodePayload,
} from "../../src/providers/commandcode.js";
import { commandCodeCacheContextId } from "../../src/providers/commandcode-cache-context.js";
import type {
  CommandCodeEnvSource,
  CommandCodeFileSource,
} from "../../src/providers/commandcode-api-key.js";
import type { PiCommandCodeCredentialBroker } from "../../src/providers/pi-commandcode-credential.js";
import type {
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
} from "../../src/types.js";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const SYNTHETIC_KEY = "synthetic-commandcode-key-481";
const SIBLING_KEY = "synthetic-commandcode-sibling-992";

const WHOAMI = JSON.parse(
  readFileSync(
    join(process.cwd(), "test/fixtures/commandcode/whoami.json"),
    "utf8",
  ),
) as unknown;
const CREDITS = JSON.parse(
  readFileSync(
    join(process.cwd(), "test/fixtures/commandcode/credits.json"),
    "utf8",
  ),
) as unknown;
const CREDIT_ONLY = JSON.parse(
  readFileSync(
    join(process.cwd(), "test/fixtures/commandcode/credit-only.json"),
    "utf8",
  ),
) as unknown;
const MALFORMED_WINDOW = JSON.parse(
  readFileSync(
    join(process.cwd(), "test/fixtures/commandcode/malformed-window.json"),
    "utf8",
  ),
) as unknown;
const UNKNOWN_WINDOW = JSON.parse(
  readFileSync(
    join(process.cwd(), "test/fixtures/commandcode/unknown-window.json"),
    "utf8",
  ),
) as unknown;
const WHOAMI_ORG_LIMITS = JSON.parse(
  readFileSync(
    join(process.cwd(), "test/fixtures/commandcode/whoami-org-limits.json"),
    "utf8",
  ),
) as unknown;
const RESET_FORMATS = JSON.parse(
  readFileSync(
    join(process.cwd(), "test/fixtures/commandcode/reset-formats.json"),
    "utf8",
  ),
) as unknown;

describe("Command Code request transport", () => {
  it("makes only the two fixed-origin read-only GETs", async () => {
    const request = sequentialFetch([
      jsonResponse(WHOAMI),
      jsonResponse(CREDITS),
    ]);
    const report = await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    const urls = request.mock.calls.map(([input, init]) => {
      const url = new URL(String(input));
      return {
        protocol: url.protocol,
        hostname: url.hostname,
        pathname: url.pathname,
        search: url.search,
        method: init?.method,
        redirect: init?.redirect,
        credentials: init?.credentials,
        authorization: new Headers(init?.headers).get("authorization"),
        accept: new Headers(init?.headers).get("accept"),
        userAgent: new Headers(init?.headers).get("user-agent"),
      };
    });
    expect(urls[0]).toMatchObject({
      protocol: "https:",
      hostname: "api.commandcode.ai",
      pathname: COMMANDCODE_WHOAMI_PATH,
      search: "?limits=1",
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      authorization: `Bearer ${SYNTHETIC_KEY}`,
      accept: "application/json",
    });
    expect(urls[0]?.userAgent).toMatch(/^quota-axi\/\d+\.\d+\.\d+$/);
    expect(urls[1]).toMatchObject({
      protocol: "https:",
      hostname: "api.commandcode.ai",
      pathname: COMMANDCODE_CREDITS_PATH,
      search: "?orgId=org_fixture",
      method: "GET",
    });
    expect(COMMANDCODE_API_ORIGIN).toBe("https://api.commandcode.ai");
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
    expect(report).toMatchObject({
      provider: "commandcode",
      label: "Command Code",
      source: "api",
      credits: { remaining: 55, unit: "credits" },
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
    expect(report.windows.map(({ id }) => id)).toEqual(["five_hour", "weekly"]);
    expect(report.windows[0]).toMatchObject({
      kind: "session",
      windowSeconds: 18_000,
      percentUsed: 20,
      percentRemaining: 80,
    });
    expect(report.windows[1]).toMatchObject({
      kind: "weekly",
      windowSeconds: 604_800,
      percentUsed: 15,
      percentRemaining: 85,
      resetsAt: new Date(1_789_400_000 * 1000).toISOString(),
    });
  });

  it("never calls model, chat, subscription, or summary endpoints", async () => {
    const request = sequentialFetch([
      jsonResponse(WHOAMI),
      jsonResponse(CREDITS),
    ]);
    await testAdapter({ fetch: request }).fetchQuota(OPTIONS);
    const paths = request.mock.calls.map(
      ([input]) => new URL(String(input)).pathname,
    );
    expect(paths.every((path) => path.startsWith("/alpha/"))).toBe(true);
    expect(paths.join(" ")).not.toMatch(
      /provider|models|chat|messages|subscriptions|summary/,
    );
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
      expect(JSON.stringify(report)).not.toContain("elsewhere.invalid");
    }
  });

  it("treats whoami HTTP 401 as a definitive rejection and 403 as non-definitive", async () => {
    const rejected = await testAdapter({
      fetch: vi.fn(async () => new Response("nope", { status: 401 })),
    }).fetchQuota(OPTIONS);
    expect(rejected.state).toMatchObject({
      status: "auth_required",
      error: "commandcode_sign_in_required",
      authStatus: "unusable",
    });

    const forbidden = await testAdapter({
      fetch: vi.fn(async () => new Response("nope", { status: 403 })),
    }).fetchQuota(OPTIONS);
    expect(forbidden.state).toMatchObject({
      status: "error",
      error: "provider_request_rejected",
    });
    expect(forbidden.state.authStatus).not.toBe("unusable");
  });

  it("keeps auth usable when whoami succeeds and credits fails", async () => {
    const request = sequentialFetch([
      jsonResponse(WHOAMI),
      new Response("nope", { status: 401 }),
    ]);
    const report = await testAdapter({ fetch: request }).fetchQuota(OPTIONS);
    expect(report.state.authStatus).toBe("usable");
    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("provider_request_rejected");
  });

  it("does not spawn a process even when credential refresh is enabled", async () => {
    const request = sequentialFetch([
      jsonResponse(WHOAMI),
      jsonResponse(CREDITS),
    ]);
    await testAdapter({ fetch: request }).fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
    const paths = request.mock.calls.map(
      ([input]) => new URL(String(input)).pathname,
    );
    expect(paths).toEqual([COMMANDCODE_WHOAMI_PATH, COMMANDCODE_CREDITS_PATH]);
  });
});

describe("Command Code credential selection", () => {
  it("selects the Pi source before environment and file sources", async () => {
    const request = sequentialFetch([
      jsonResponse(WHOAMI),
      jsonResponse(CREDITS),
    ]);
    const report = await testAdapter({
      fetch: request,
      officialEnv: envSource("resolved", SIBLING_KEY),
    }).fetchQuota(OPTIONS);
    expect(request.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${SYNTHETIC_KEY}` }),
    );
    expect(JSON.stringify(report)).not.toContain(SIBLING_KEY);
    expect(report.attempts?.[0]).toMatchObject({
      source: "pi:commandcode",
      status: "success",
    });
  });

  it("hands over from a whoami 401 to a healthy sibling and marks the predecessor degraded", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization");
        if (bearer === `Bearer ${SYNTHETIC_KEY}`) {
          return new Response(null, { status: 401 });
        }
        const url = new URL(String(_input));
        if (url.pathname === COMMANDCODE_WHOAMI_PATH)
          return jsonResponse(WHOAMI);
        return jsonResponse(CREDITS);
      },
    );
    const report = await testAdapter({
      fetch: request,
      officialEnv: envSource("resolved", SIBLING_KEY),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      {
        source: "pi:commandcode",
        status: "failed",
        error: "provider_auth_rejected",
      },
      { source: "env:COMMAND_CODE_API_KEY", status: "success" },
    ]);
    const withSemantics = withQuotaSemantics(
      report,
      "2026-09-14T12:00:00.000Z",
    );
    expect(withSemantics.state.degradedSources).toEqual([
      { source: "pi:commandcode", error: "provider_auth_rejected" },
    ]);
  });

  it("does not hand over on whoami timeout, 403, 429, or 5xx", async () => {
    for (const status of [403, 429, 503]) {
      const report = await testAdapter({
        fetch: vi.fn(async () => new Response(null, { status })),
        officialEnv: envSource("resolved", SIBLING_KEY),
      }).fetchQuota(OPTIONS);
      expect(report.attempts?.map(({ source }) => source)).toEqual([
        "pi:commandcode",
      ]);
    }
  });

  it("marks a present but broken Pi source as a credential that exists", async () => {
    const report = await testAdapter({
      piBroker: piBroker({
        status: "structurally_invalid",
        error: "commandcode_credential_invalid",
      }),
      officialEnv: envSource("resolved", SIBLING_KEY),
      fetch: sequentialFetch([jsonResponse(WHOAMI), jsonResponse(CREDITS)]),
    }).fetchQuota(OPTIONS);
    expect(report.attempts?.[0]).toMatchObject({
      source: "pi:commandcode",
      status: "skipped",
      credentialPresent: true,
    });
    expect(report.state.status).toBe("fresh");
  });
});

describe("Command Code payload normalization", () => {
  it("omits credits when a component is missing rather than treating it as zero", () => {
    const normalized = normalizeCommandCodePayload({
      monthlyCredits: 10,
      freeCredits: 1,
      windowLimits: {
        fiveHour: { used: 0, cap: 10, resetAt: "2026-09-14T18:00:00.000Z" },
        weekly: { used: 0, cap: 10, resetAt: "2026-09-21T00:00:00.000Z" },
      },
    });
    expect(normalized.credits).toBeUndefined();
    expect(normalized.windows).toHaveLength(2);
  });

  it("clamps over-cap usage to exhausted rather than a negative remainder", () => {
    const [window] = normalizeCommandCodePayload({
      monthlyCredits: 1,
      purchasedCredits: 0,
      freeCredits: 0,
      windowLimits: {
        fiveHour: { used: 12, cap: 10 },
        weekly: { used: 0, cap: 10 },
      },
    }).windows;
    expect(window).toMatchObject({
      id: "five_hour",
      percentUsed: 100,
      percentRemaining: 0,
    });
  });

  it("accepts millisecond, numeric-string, and ISO resets", () => {
    const normalized = normalizeCommandCodePayload(RESET_FORMATS);
    expect(normalized.windows[0]?.resetsAt).toBe(
      new Date(1_789_400_000_000).toISOString(),
    );
    expect(normalized.windows[1]?.resetsAt).toBe(
      new Date(1_789_400_000 * 1000).toISOString(),
    );
  });

  it("omits epoch and non-positive resets rather than emitting 1970", () => {
    const normalized = normalizeCommandCodePayload({
      monthlyCredits: 1,
      purchasedCredits: 0,
      freeCredits: 0,
      windowLimits: {
        limited: true,
        fiveHour: { used: 0, cap: 50, resetAt: 0 },
        weekly: {
          used: 5,
          cap: 50,
          resetAt: "1970-01-01T00:00:00.000Z",
        },
      },
    });
    expect(normalized.windows[0]).toMatchObject({
      id: "five_hour",
      percentRemaining: 100,
    });
    expect(normalized.windows[1]).toMatchObject({
      id: "weekly",
      percentRemaining: 90,
    });
    expect(normalized.windows[0]?.resetsAt).toBeUndefined();
    expect(normalized.windows[1]?.resetsAt).toBeUndefined();
  });

  it("returns a credit-only result when limited is false", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([
        jsonResponse({ org: { id: "org_fixture" } }),
        jsonResponse(CREDIT_ONLY),
      ]),
    }).fetchQuota(OPTIONS);
    expect(report.windows).toEqual([]);
    expect(report.credits).toEqual({ remaining: 12.5, unit: "credits" });
    expect(report.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
    });
    expect(report.credits?.unlimited).toBeUndefined();
    const semantics = withQuotaSemantics(
      report,
      "2026-09-14T12:00:00.000Z",
    ).quotaSemantics;
    expect(semantics?.effectiveAvailability).toEqual([]);
    expect(semantics?.status).not.toBe("known");
  });

  it("omits leftover rolling windows when limited is false", () => {
    const normalized = normalizeCommandCodePayload({
      monthlyCredits: 1,
      purchasedCredits: 0,
      freeCredits: 0,
      windowLimits: {
        limited: false,
        fiveHour: { used: 0, cap: 10, resetAt: 1_789_400_000 },
      },
    });
    expect(normalized.windows).toEqual([]);
    expect(normalized.untrustedWindowIds).toEqual([]);
    const semantics = withQuotaSemantics(
      {
        provider: "commandcode",
        label: "Command Code",
        source: "api",
        windows: normalized.windows,
        ...(normalized.credits ? { credits: normalized.credits } : {}),
        state: { status: "fresh", stale: false },
      },
      "2026-09-14T12:00:00.000Z",
    ).quotaSemantics;
    expect(semantics?.effectiveAvailability).toEqual([]);
    expect(
      semantics?.effectiveAvailability.some(
        (item) => item.scope === "included_credits" && item.status === "known",
      ),
    ).toBe(false);
    expect(semantics?.status).not.toBe("known");
  });

  it("emits an untrusted placeholder when one expected window is present and limited is omitted", () => {
    const normalized = normalizeCommandCodePayload({
      monthlyCredits: 1,
      purchasedCredits: 0,
      freeCredits: 0,
      windowLimits: {
        fiveHour: { used: 0, cap: 10, resetAt: 1_789_400_000 },
      },
    });
    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "weekly",
    ]);
    expect(normalized.untrustedWindowIds).toContain("weekly");
    expect(normalized.windows[1]?.percentRemaining).toBeUndefined();
  });

  it("names unknown scalar windowLimits keys as untrusted", () => {
    const normalized = normalizeCommandCodePayload({
      monthlyCredits: 1,
      purchasedCredits: 0,
      freeCredits: 0,
      windowLimits: {
        limited: true,
        fiveHour: { used: 0, cap: 10, resetAt: 1_789_400_000 },
        weekly: { used: 1, cap: 10, resetAt: 1_789_400_000 },
        extraCap: 3,
      },
    });
    expect(normalized.untrustedWindowIds).toContain("window:extracap");
  });

  it("emits an untrusted placeholder when limited is true and a required window is missing", () => {
    const normalized = normalizeCommandCodePayload(MALFORMED_WINDOW);
    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "five_hour",
      "weekly",
    ]);
    expect(normalized.untrustedWindowIds).toContain("weekly");
    expect(normalized.windows[1]).toMatchObject({
      id: "weekly",
      kind: "weekly",
    });
    expect(normalized.windows[1]?.percentRemaining).toBeUndefined();
  });

  it("names unknown added windowLimits as untrusted unknown windows", () => {
    const normalized = normalizeCommandCodePayload(UNKNOWN_WINDOW);
    expect(normalized.untrustedWindowIds).toContain("window:daily");
    expect(
      normalized.windows.find((window) => window.id === "window:daily"),
    ).toMatchObject({ kind: "unknown" });
  });
});

describe("Command Code effective availability", () => {
  it("publishes included_credits as the minimum of the trusted rolling windows", () => {
    const report: ProviderQuota = {
      provider: "commandcode",
      label: "Command Code",
      source: "api",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          kind: "session",
          percentUsed: 20,
          percentRemaining: 80,
          windowSeconds: 18_000,
          resetsAt: "2026-09-14T17:00:00.000Z",
        },
        {
          id: "weekly",
          label: "Weekly",
          kind: "weekly",
          percentUsed: 15,
          percentRemaining: 85,
          windowSeconds: 604_800,
          resetsAt: "2026-09-21T12:00:00.000Z",
        },
      ],
      state: { status: "fresh", stale: false },
    };
    const semantics = withQuotaSemantics(
      report,
      "2026-09-14T12:00:00.000Z",
    ).quotaSemantics;
    expect(semantics).toMatchObject({
      status: "known",
      effectiveAvailability: [
        {
          scope: "included_credits",
          status: "known",
          effectivePercentRemaining: 80,
          boundedBy: ["five_hour", "weekly"],
          limitingWindowIds: ["five_hour"],
        },
      ],
    });
    expect(JSON.stringify(semantics)).not.toContain("all_models");
  });

  it("does not publish a known included_credits scalar from one rolling window", () => {
    const report: ProviderQuota = {
      provider: "commandcode",
      label: "Command Code",
      source: "api",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          kind: "session",
          percentUsed: 20,
          percentRemaining: 80,
          windowSeconds: 18_000,
        },
      ],
      state: { status: "fresh", stale: false },
    };
    const semantics = withQuotaSemantics(
      report,
      "2026-09-14T12:00:00.000Z",
    ).quotaSemantics;
    expect(semantics?.effectiveAvailability).toEqual([]);
    expect(
      semantics?.effectiveAvailability.some(
        (item) => item.scope === "included_credits" && item.status === "known",
      ),
    ).toBe(false);
    expect(semantics?.status).not.toBe("known");
  });

  it("withholds the included_credits scalar when organization limits are present", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([
        jsonResponse(WHOAMI_ORG_LIMITS),
        jsonResponse(CREDITS),
      ]),
    }).fetchQuota(OPTIONS);
    expect(report.state.untrustedWindowIds).toContain("org_limit");
    const semantics = withQuotaSemantics(
      report,
      "2026-09-14T12:00:00.000Z",
    ).quotaSemantics;
    expect(semantics?.status).toBe("partial");
    expect(semantics?.effectiveAvailability[0]).toMatchObject({
      scope: "included_credits",
      status: "unknown",
    });
    expect(
      semantics?.effectiveAvailability[0]?.effectivePercentRemaining,
    ).toBeUndefined();
  });
});

describe("Command Code cache", () => {
  it("reuses same-context stale windows after a credits failure", async () => {
    const contextId = commandCodeCacheContextId(
      "pi:commandcode",
      "org:org_fixture",
    );
    const cached = cachedQuota();
    const report = await testAdapter({
      fetch: sequentialFetch([
        jsonResponse(WHOAMI),
        new Response(null, { status: 503 }),
      ]),
      readCachedProvider: (id) => (id === contextId ? cached : undefined),
    }).fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "stale",
      stale: true,
      authStatus: "usable",
      error: "provider_unavailable",
    });
    expect(report.windows.map(({ id }) => id)).toEqual(["five_hour", "weekly"]);
  });

  it("prefers a context-carrying credits failure over an earlier resolver error", async () => {
    const contextId = commandCodeCacheContextId(
      "env:COMMAND_CODE_API_KEY",
      "org:org_fixture",
    );
    const request = sequentialFetch([
      jsonResponse(WHOAMI),
      new Response(null, { status: 503 }),
    ]);
    const report = await testAdapter({
      piBroker: piBroker({
        status: "read_error",
        error: "credential_resolution_failed",
      }),
      officialEnv: envSource("resolved", SIBLING_KEY),
      fetch: request,
      readCachedProvider: (id) =>
        id === contextId ? cachedQuota() : undefined,
    }).fetchQuota(OPTIONS);

    expect(report.attempts?.[0]).toMatchObject({
      source: "pi:commandcode",
      status: "failed",
      error: "credential_resolution_failed",
      credentialPresent: true,
    });
    expect(request.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${SIBLING_KEY}` }),
    );
    expect(report.state).toMatchObject({
      status: "stale",
      stale: true,
      authStatus: "usable",
      error: "provider_unavailable",
    });
    expect(report.windows.map(({ id }) => id)).toEqual(["five_hour", "weekly"]);
  });

  it("does not use stale data when whoami fails before identity is known", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);
    expect(report.state.status).toBe("error");
    expect(report.state.stale).toBe(false);
    expect(report.windows).toEqual([]);
  });

  it("does not inherit a previous account's cache context after an unidentified whoami", async () => {
    const previous = commandCodeCacheContextId(
      "pi:commandcode",
      "org:org_fixture",
    );
    await testAdapter({
      fetch: sequentialFetch([jsonResponse(WHOAMI), jsonResponse(CREDITS)]),
    }).fetchQuota(OPTIONS);
    const report = await testAdapter({
      fetch: sequentialFetch([
        jsonResponse({}),
        new Response(null, { status: 503 }),
      ]),
      readCachedProvider: (id) => (id === previous ? cachedQuota() : undefined),
    }).fetchQuota(OPTIONS);
    expect(report.state.stale).toBe(false);
  });

  it("does not reuse a different account's snapshot", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([
        jsonResponse(WHOAMI),
        new Response(null, { status: 503 }),
      ]),
      readCachedProvider: (id) =>
        id === commandCodeCacheContextId("pi:commandcode", "org:other")
          ? cachedQuota()
          : undefined,
    }).fetchQuota(OPTIONS);
    expect(report.state.stale).toBe(false);
    expect(report.windows).toEqual([]);
  });
});

describe("Command Code auth inspection", () => {
  it("is local-only and never prints a credential", async () => {
    const request = vi.fn(async () => jsonResponse(WHOAMI));
    const report = await testAdapter({ fetch: request }).inspectAuth(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.provider).toBe("commandcode");
    expect(report.sources.map(({ source }) => source)).toEqual([
      ...COMMANDCODE_SOURCE_ORDER,
    ]);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
  });
});

function testAdapter(
  overrides: Partial<Parameters<typeof createCommandCodeAdapter>[0]> = {},
): ProviderAdapter {
  return createCommandCodeAdapter({
    piBroker: piBroker({ status: "resolved", credential: SYNTHETIC_KEY }),
    officialEnv: envSource("absent"),
    legacyEnv: envSource("absent"),
    cliSource: fileSource("absent"),
    ompSource: fileSource("absent"),
    fetch: vi.fn(async () => jsonResponse(CREDITS)) as unknown as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function piBroker(
  resolution: Awaited<ReturnType<PiCommandCodeCredentialBroker["resolve"]>>,
): PiCommandCodeCredentialBroker {
  return {
    resolve: async () => resolution,
    inspect: async () =>
      resolution.status === "resolved"
        ? { status: "available", path: "/tmp/pi/auth.json" }
        : resolution.status === "absent"
          ? { status: "missing", path: "/tmp/pi/auth.json" }
          : {
              status: "invalid",
              path: "/tmp/pi/auth.json",
              error: "commandcode_credential_invalid",
            },
  };
}

function envSource(
  status: "resolved" | "absent" | "invalid",
  credential = SYNTHETIC_KEY,
): CommandCodeEnvSource {
  return {
    resolve: async () =>
      status === "resolved"
        ? { status: "resolved", credential }
        : status === "absent"
          ? { status: "absent" }
          : {
              status: "structurally_invalid",
              error: "commandcode_credential_invalid",
            },
    inspect: async () =>
      status === "resolved"
        ? { status: "available" }
        : status === "absent"
          ? { status: "missing" }
          : { status: "invalid", error: "commandcode_credential_invalid" },
  };
}

function fileSource(
  status: "resolved" | "absent" | "invalid",
  credential = SYNTHETIC_KEY,
): CommandCodeFileSource {
  return {
    resolve: async () =>
      status === "resolved"
        ? { status: "resolved", credential }
        : status === "absent"
          ? { status: "absent" }
          : {
              status: "structurally_invalid",
              error: "commandcode_credential_invalid",
            },
    inspect: async () =>
      status === "resolved"
        ? { status: "available", path: "/tmp/commandcode/auth.json" }
        : status === "absent"
          ? { status: "missing", path: "/tmp/commandcode/auth.json" }
          : {
              status: "invalid",
              path: "/tmp/commandcode/auth.json",
              error: "commandcode_credential_invalid",
            },
  };
}

function sequentialFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cachedQuota(): ProviderQuota {
  return {
    provider: "commandcode",
    label: "Command Code",
    source: "api",
    windows: [
      quotaWindow("five_hour", "session", "2026-09-14T17:00:00.000Z"),
      quotaWindow("weekly", "weekly", "2026-09-21T12:00:00.000Z"),
    ],
    credits: { remaining: 55, unit: "credits" },
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(NOW - 60_000).toISOString(),
      sourcesTried: ["pi:commandcode"],
    },
  };
}

function quotaWindow(
  id: string,
  kind: QuotaWindow["kind"],
  resetsAt: string,
): QuotaWindow {
  return {
    id,
    label: id,
    kind,
    percentUsed: 20,
    percentRemaining: 80,
    windowSeconds: id === "five_hour" ? 18_000 : 604_800,
    resetsAt,
  };
}
