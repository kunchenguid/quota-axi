import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeCachedProviders } from "../../src/cache.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  BOB_API_KEY_SOURCE,
  BOB_PROFILE_URL,
  BOB_SOURCE_ORDER,
  BOBSHELL_API_KEY_SOURCE,
  createBobAdapter,
  normalizeBobPayload,
} from "../../src/providers/bob.js";
import {
  bobCacheContextId,
  clearBobReadingContextId,
  publishBobReadingContextId,
} from "../../src/providers/bob-cache-context.js";
import type {
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
} from "../../src/types.js";

// Inside the fixture cycle: its `refresh_at` is 2026-06-12T00:00:00Z.
const NOW = Date.parse("2026-05-27T00:00:00.000Z");
const RESET = "2026-06-12T00:00:00.000Z";
const CYCLE_START = "2026-05-12T00:00:00.000Z";
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
// Synthetic. No real Bob key or account data appears in this tree.
const SYNTHETIC_KEY = "synthetic-bob-key-481";
const OTHER_KEY = "synthetic-bob-key-992";
const REJECTED_BODY = {
  error: "unauthorized",
  message: "API Key verification failed: Invalid or expired API Key",
};

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(process.cwd(), `test/fixtures/bob/${name}.json`), "utf8"),
  ) as unknown;

const PRO_PLUS = fixture("profile-pro-plus");

type Instance = Record<string, unknown> & { teams: Record<string, unknown>[] };

/** The Pro+ fixture with one instance or team field changed. */
function profile(
  instance: Record<string, unknown> = {},
  team: Record<string, unknown> = {},
): unknown {
  const copy = structuredClone(PRO_PLUS) as { instances: Instance[] };
  Object.assign(copy.instances[0].teams[0], team);
  Object.assign(copy.instances[0], instance);
  return copy;
}

const MONTHLY_BUDGET: QuotaWindow = {
  id: "monthly_budget",
  label: "month",
  kind: "monthly",
  percentUsed: 25,
  percentRemaining: 75,
  startsAt: CYCLE_START,
  resetsAt: RESET,
  limitCredits: 180,
  usedCredits: 45,
  remainingCredits: 135,
  creditUnit: "bobcoins",
};

describe("Bob request transport", () => {
  it("makes one fixed-origin read-only GET with the apikey scheme", async () => {
    const request = sequentialFetch([jsonResponse(PRO_PLUS)]);
    await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    expect(String(input)).toBe(
      "https://api.us-east.bob.ibm.com/admin/v1/profile",
    );
    expect(BOB_PROFILE_URL).toBe(String(input));
    expect({
      method: init?.method,
      redirect: init?.redirect,
      credentials: init?.credentials,
    }).toEqual({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `apikey ${SYNTHETIC_KEY}`,
    );
  });

  it("does not follow a redirect, so the key reaches only the fixed origin", async () => {
    const request = sequentialFetch([
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.invalid/admin/v1/profile" },
      }),
    ]);
    const report = await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("provider_error:302");
  });

  it("declares the documented key before the older one", () => {
    expect([...BOB_SOURCE_ORDER]).toEqual([
      BOB_API_KEY_SOURCE,
      BOBSHELL_API_KEY_SOURCE,
    ]);
  });
});

/**
 * The provider onboarding matrix in skills/provider-onboarding/SKILL.md. Two
 * of its seven cases cannot arise for this provider and are asserted as such
 * rather than skipped: a Bob API key carries no expiry field, and the two key
 * variables are never tried in turn, so a rejection has no sibling to reach.
 */
describe("Bob credential matrix", () => {
  it("primary healthy: reports the monthly budget in Bobcoins, never USD", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(PRO_PLUS)]),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.state.authStatus).toBe("usable");
    expect(report.source).toBe("api");
    expect(report.plan).toBe("pro plus plan");
    expect(report.windows).toEqual([MONTHLY_BUDGET]);
    expect(report.windows[0]).not.toHaveProperty("spentUsd");
    expect(report.attempts).toEqual([
      { source: BOB_API_KEY_SOURCE, status: "success" },
    ]);
  });

  it("stored-expired plus live sibling: cannot arise, and a rejection tries no other key", async () => {
    const request = sequentialFetch([jsonResponse(REJECTED_BODY, 401)]);
    await testAdapter({
      environment: () => ({
        BOB_API_KEY: SYNTHETIC_KEY,
        BOBSHELL_API_KEY: SYNTHETIC_KEY,
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reads the older variable when it is the only one set", async () => {
    const request = sequentialFetch([jsonResponse(PRO_PLUS)]);
    const report = await testAdapter({
      environment: () => ({ BOB_API_KEY: "  ", BOBSHELL_API_KEY: OTHER_KEY }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`apikey ${OTHER_KEY}`);
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      {
        source: BOB_API_KEY_SOURCE,
        status: "skipped",
        error: "bob_credential_unavailable",
      },
      { source: BOBSHELL_API_KEY_SOURCE, status: "success" },
    ]);
  });

  it("structurally invalid present: never sent, and reported as a credential that exists", async () => {
    const request = sequentialFetch([]);
    const report = await testAdapter({
      environment: () => ({ BOB_API_KEY: "$BOB_KEY_REFERENCE" }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toBe("bob_credential_invalid");
    expect(report.attempts?.[0]).toEqual({
      source: BOB_API_KEY_SOURCE,
      status: "failed",
      error: "bob_credential_invalid",
      credentialPresent: true,
    });
  });

  it("absent source: no request, no credentialPresent marker", async () => {
    const request = sequentialFetch([]);
    const report = await testAdapter({
      environment: () => ({ BOB_API_KEY: "", BOBSHELL_API_KEY: "   " }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "bob_credential_unavailable",
    });
    for (const attempt of report.attempts ?? []) {
      expect(attempt.status).toBe("skipped");
      expect(attempt.credentialPresent).toBeUndefined();
    }
  });

  it("all rejected: a JSON 401 is a sign-out that retires this key's cache", async () => {
    const { restore } = useCacheDir();
    try {
      seedCachedBob(SYNTHETIC_KEY);
      const deleteCachedProvider = vi.fn();
      const report = await testAdapter({
        fetch: sequentialFetch([jsonResponse(REJECTED_BODY, 401)]),
        deleteCachedProvider,
      }).fetchQuota(OPTIONS);

      expect(report.state).toMatchObject({
        status: "auth_required",
        authStatus: "unusable",
        error: "provider_auth_rejected",
      });
      expect(report.windows).toEqual([]);
      expect(deleteCachedProvider).toHaveBeenCalledWith("bob");
    } finally {
      restore();
    }
  });

  it("refreshable expiry: cannot arise, and the adapter declares no refresh delegate", () => {
    expect(Object.keys(testAdapter()).sort()).toEqual([
      "fetchQuota",
      "id",
      "inspectAuth",
      "label",
    ]);
  });

  it("transient failure: no auth verdict, cache preserved, stale served", async () => {
    const { restore } = useCacheDir();
    try {
      seedCachedBob(SYNTHETIC_KEY);
      const deleteCachedProvider = vi.fn();
      const report = await testAdapter({
        fetch: sequentialFetch([new Response("down", { status: 503 })]),
        deleteCachedProvider,
      }).fetchQuota(OPTIONS);

      expect(report.state).toMatchObject({
        status: "stale",
        stale: true,
        error: "provider_error:503",
      });
      expect(report.source).toBe("cache");
      expect(deleteCachedProvider).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("Bob key conflict and gateway", () => {
  it("sends nothing when the two variables hold different keys", async () => {
    const request = sequentialFetch([]);
    const report = await testAdapter({
      environment: () => ({
        BOB_API_KEY: SYNTHETIC_KEY,
        BOBSHELL_API_KEY: OTHER_KEY,
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "error",
      error: "bob_api_key_conflict",
    });
    expect(report.state.authStatus).toBeUndefined();
    expect(report.attempts).toEqual(
      BOB_SOURCE_ORDER.map((source) => ({
        source,
        status: "skipped",
        error: "bob_api_key_conflict",
        credentialPresent: true,
      })),
    );
  });

  it("treats an unusable second value that differs as the same conflict", async () => {
    const request = sequentialFetch([]);
    const report = await testAdapter({
      environment: () => ({
        BOB_API_KEY: SYNTHETIC_KEY,
        BOBSHELL_API_KEY: "$OTHER_KEY",
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.error).toBe("bob_api_key_conflict");
  });

  it("reads once when both variables hold the same key", async () => {
    const request = sequentialFetch([jsonResponse(PRO_PLUS)]);
    const report = await testAdapter({
      environment: () => ({
        BOB_API_KEY: SYNTHETIC_KEY,
        BOBSHELL_API_KEY: SYNTHETIC_KEY,
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state.status).toBe("fresh");
  });

  it.each([
    ["another host", "https://gateway.example.invalid"],
    ["the default host over http", "http://api.us-east.bob.ibm.com"],
    ["a path on the default host", "https://api.us-east.bob.ibm.com/other"],
    ["an unparseable value", "not a url"],
  ])("sends no key to %s", async (_label, gateway) => {
    const request = sequentialFetch([]);
    const report = await testAdapter({
      environment: () => ({
        BOB_API_KEY: SYNTHETIC_KEY,
        BOB_GATEWAY_URL: gateway,
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "error",
      error: "unsupported_server",
    });
    expect(report.attempts?.[0]).toEqual({
      source: BOB_API_KEY_SOURCE,
      status: "skipped",
      error: "unsupported_server",
      credentialPresent: true,
    });
  });

  it.each([
    ["blank", "  "],
    ["the default host", "https://api.us-east.bob.ibm.com"],
    ["the default host with a slash", "https://api.us-east.bob.ibm.com/"],
  ])("reads normally when the gateway is %s", async (_label, gateway) => {
    const report = await testAdapter({
      environment: () => ({
        BOB_API_KEY: SYNTHETIC_KEY,
        BOB_GATEWAY_URL: gateway,
      }),
      fetch: sequentialFetch([jsonResponse(PRO_PLUS)]),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
  });

  it("stays absent, not blocked, when a gateway is set but no key is", async () => {
    const report = await testAdapter({
      environment: () => ({
        BOB_GATEWAY_URL: "https://gateway.example.invalid",
      }),
      fetch: sequentialFetch([]),
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("bob_credential_unavailable");
  });

  it("inspectAuth names both variables without reading a value into the report", async () => {
    const report = await testAdapter({
      environment: () => ({ BOBSHELL_API_KEY: SYNTHETIC_KEY }),
    }).inspectAuth(OPTIONS);

    expect(report).toEqual({
      provider: "bob",
      sources: [
        {
          source: BOB_API_KEY_SOURCE,
          path: "BOB_API_KEY",
          status: "missing",
        },
        {
          source: BOBSHELL_API_KEY_SOURCE,
          path: "BOBSHELL_API_KEY",
          status: "available",
        },
      ],
    });
  });

  it("inspectAuth reports a blocked key as a skipped credential that exists", async () => {
    const report = await testAdapter({
      environment: () => ({
        BOB_API_KEY: SYNTHETIC_KEY,
        BOBSHELL_API_KEY: OTHER_KEY,
      }),
    }).inspectAuth(OPTIONS);

    expect(report.sources.map(({ status, error }) => [status, error])).toEqual([
      ["skipped", "bob_api_key_conflict"],
      ["skipped", "bob_api_key_conflict"],
    ]);
    expect(JSON.stringify(report)).not.toContain("synthetic-bob-key");
  });
});

describe("Bob auth classification", () => {
  it.each([
    ["HTML 403", 403, "<html>denied</html>"],
    ["HTML 401", 401, "<html>denied</html>"],
    ["empty 403", 403, ""],
    ["JSON array 403", 403, "[]"],
  ])(
    "treats a %s as a request failure, not a sign-out",
    async (_label, status, body) => {
      const deleteCachedProvider = vi.fn();
      const report = await testAdapter({
        fetch: sequentialFetch([new Response(body, { status })]),
        deleteCachedProvider,
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("error");
      expect(report.state.error).toBe(`provider_error:${status}`);
      expect(report.state.authStatus).toBeUndefined();
      expect(deleteCachedProvider).not.toHaveBeenCalled();
    },
  );

  it("treats a first-party JSON 403 as a rejection", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse({ error: "forbidden" }, 403)]),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      authStatus: "unusable",
    });
  });

  it("carries Retry-After through a rate limit without retiring the cache", async () => {
    const deleteCachedProvider = vi.fn();
    const report = await testAdapter({
      fetch: sequentialFetch([
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      ]),
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("rate_limited");
    expect(report.state.error).toBe("provider_rate_limited");
    expect(report.state.retryAfter).toBeTruthy();
    expect(deleteCachedProvider).not.toHaveBeenCalled();
  });

  it("reports a stalled request as a timeout, not a sign-out", async () => {
    const report = await testAdapter({
      deadlineMs: 5,
      fetch: vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ) as unknown as typeof globalThis.fetch,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_timeout",
    });
  });

  it("reports invalid JSON on a 200 as a request failure", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([new Response("not json", { status: 200 })]),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "invalid_json",
    });
  });
});

describe("Bob payload normalization", () => {
  const names = (windows: QuotaWindow[]) => windows.map(({ id }) => id);

  it("uses the included window when overage is on", () => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(
      fixture("profile-overage"),
      NOW,
    );

    expect(windows).toEqual([{ ...MONTHLY_BUDGET, id: "included_monthly" }]);
    expect(untrustedWindowIds).toEqual([]);
  });

  it("reports figures but no reset or cycle for an unobserved plan", () => {
    const { plan, windows, untrustedWindowIds } = normalizeBobPayload(
      fixture("profile-unobserved-plan"),
      NOW,
    );

    expect(plan).toBe("unobserved plan");
    expect(windows).toEqual([
      {
        id: "plan_budget",
        label: "budget",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        limitCredits: 180,
        usedCredits: 45,
        remainingCredits: 135,
        creditUnit: "bobcoins",
      },
    ]);
    expect(untrustedWindowIds).toEqual(["plan_budget"]);
  });

  it("does not trust an internal instance on an observed plan", () => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(
      profile({ is_internal: true }),
      NOW,
    );

    expect(names(windows)).toEqual(["plan_budget"]);
    expect(untrustedWindowIds).toEqual(["plan_budget"]);
  });

  it.each([
    ["a null limit", fixture("profile-null-limit")],
    ["a zero limit", profile({}, { budget_limit: 0 })],
  ])("publishes no percentage for %s", (_label, payload) => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(payload, NOW);

    expect(windows[0].percentRemaining).toBeUndefined();
    expect(windows[0].percentUsed).toBeUndefined();
    expect(windows[0].remainingCredits).toBeUndefined();
    expect(windows[0].usedCredits).toBe(45);
    expect(untrustedWindowIds).toEqual(["monthly_budget"]);
  });

  it("keeps the limit when usage is not a number, without a percentage", () => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(
      profile({}, { usage: "45" }),
      NOW,
    );

    expect(windows[0]).toMatchObject({ limitCredits: 180 });
    expect(windows[0].usedCredits).toBeUndefined();
    expect(windows[0].percentRemaining).toBeUndefined();
    expect(untrustedWindowIds).toEqual(["monthly_budget"]);
  });

  it("publishes no window but stays partial when neither figure is usable", () => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(
      profile({}, { usage: null, budget_limit: "180" }),
      NOW,
    );

    expect(windows).toEqual([]);
    expect(untrustedWindowIds).toEqual(["monthly_budget"]);
  });

  it.each([
    ["an inactive instance", { instance_status: "inactive" }],
    ["missing overage", { allow_overage: undefined }],
    ["a non-boolean overage", { allow_overage: "false" }],
  ])("keeps the figures but trusts no bound for %s", (_label, instance) => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(
      profile(instance),
      NOW,
    );

    expect(windows).toEqual([MONTHLY_BUDGET]);
    expect(untrustedWindowIds).toEqual(["monthly_budget"]);
  });

  it("drops the reset, and trust, when refresh_at has already passed", () => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(
      PRO_PLUS,
      Date.parse(RESET),
    );

    expect(windows[0].percentRemaining).toBe(75);
    expect(windows[0].resetsAt).toBeUndefined();
    expect(windows[0].startsAt).toBeUndefined();
    expect(untrustedWindowIds).toEqual(["monthly_budget"]);
  });

  it.each([[null], ["2026-06-12"], [0], [1_000]])(
    "resolves no reset from refresh_at %j and invents no cycle",
    (refreshAt) => {
      const { windows, untrustedWindowIds } = normalizeBobPayload(
        profile({ refresh_at: refreshAt }),
        NOW,
      );

      expect(windows[0].percentRemaining).toBe(75);
      expect(windows[0].resetsAt).toBeUndefined();
      expect(windows[0].startsAt).toBeUndefined();
      expect(untrustedWindowIds).toEqual([]);
    },
  );

  it("steps a month-end reset back by a calendar month, never a day count", () => {
    const { windows } = normalizeBobPayload(
      profile({ refresh_at: Date.parse("2026-03-31T00:00:00Z") / 1000 }),
      Date.parse("2026-03-20T00:00:00Z"),
    );

    expect(windows[0].startsAt).toBe("2026-02-28T00:00:00.000Z");
  });

  it("clamps usage past the budget and keeps the raw figure", () => {
    const { windows, untrustedWindowIds } = normalizeBobPayload(
      profile({}, { usage: 200 }),
      NOW,
    );

    expect(windows[0]).toMatchObject({
      percentUsed: 100,
      percentRemaining: 0,
      usedCredits: 200,
      remainingCredits: 0,
    });
    expect(untrustedWindowIds).toEqual([]);
  });

  it.each(["profile-multi-team", "profile-multi-instance"])(
    "publishes nothing from %s, because quota-axi must not pick a team",
    async (name) => {
      const report = await testAdapter({
        fetch: sequentialFetch([jsonResponse(fixture(name))]),
      }).fetchQuota(OPTIONS);

      expect(report.windows).toEqual([]);
      expect(report.state).toMatchObject({
        status: "unavailable",
        authStatus: "usable",
        error: "bob_team_selection_required",
      });
    },
  );

  it("reports a live key with no windows when there is no instance", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(fixture("profile-no-instances"))]),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
    });
    expect(report.windows).toEqual([]);
  });

  it("reports a live key and its plan with no windows when an instance has no team", () => {
    expect(normalizeBobPayload(profile({ teams: [] }), NOW)).toEqual({
      plan: "pro plus plan",
      windows: [],
      untrustedWindowIds: [],
    });
  });

  it.each([
    ["a malformed profile", fixture("profile-malformed")],
    ["no instances key", {}],
    ["a non-object body", []],
    ["a non-object instance", { instances: ["fixture"] }],
    ["a missing teams array", profile({ teams: undefined })],
    ["a non-object team", profile({ teams: ["fixture"] })],
  ])("rejects %s and keeps the cache", async (_label, payload) => {
    const deleteCachedProvider = vi.fn();
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(payload)]),
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "schema_invalid",
    });
    expect(deleteCachedProvider).not.toHaveBeenCalled();
  });
});

describe("Bob quota semantics", () => {
  async function semantics(payload: unknown): Promise<ProviderQuota> {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(payload)]),
    }).fetchQuota(OPTIONS);
    return withQuotaSemantics(report, new Date(NOW).toISOString());
  }

  it("bounds all_models with the monthly budget when overage is off", async () => {
    const { quotaSemantics } = await semantics(PRO_PLUS);

    expect(quotaSemantics?.status).toBe("known");
    expect(quotaSemantics?.effectiveAvailability).toMatchObject([
      {
        scope: "all_models",
        status: "known",
        effectivePercentRemaining: 75,
        boundedBy: ["monthly_budget"],
      },
    ]);
  });

  it("bounds only included_credits when overage is on", async () => {
    const { quotaSemantics } = await semantics(fixture("profile-overage"));

    expect(quotaSemantics?.effectiveAvailability).toMatchObject([
      { scope: "included_credits", boundedBy: ["included_monthly"] },
    ]);
  });

  it("reads exhausted_now when usage reaches the budget", async () => {
    const { quotaSemantics } = await semantics(profile({}, { usage: 180 }));

    expect(quotaSemantics?.effectiveAvailability[0]).toMatchObject({
      scope: "all_models",
      effectivePercentRemaining: 0,
      runway: { status: "exhausted_now" },
    });
  });

  it("bounds no scope for an unobserved plan", async () => {
    const { quotaSemantics } = await semantics(
      fixture("profile-unobserved-plan"),
    );

    expect(quotaSemantics).toMatchObject({
      status: "partial",
      effectiveAvailability: [],
      unresolvedWindowIds: ["plan_budget"],
    });
  });

  it("keeps a reading with an untrusted window partial, with no effective percentage", async () => {
    const { quotaSemantics } = await semantics(
      profile({ instance_status: "inactive" }),
    );

    expect(quotaSemantics?.status).toBe("partial");
    expect(quotaSemantics?.unresolvedWindowIds).toEqual(["monthly_budget"]);
    expect(quotaSemantics?.effectiveAvailability).toMatchObject([
      { scope: "all_models", status: "unknown" },
    ]);
    expect(
      quotaSemantics?.effectiveAvailability[0].effectivePercentRemaining,
    ).toBeUndefined();
  });

  it("publishes no effective availability when the reading has no window", async () => {
    const { quotaSemantics } = await semantics(fixture("profile-no-instances"));

    expect(quotaSemantics?.effectiveAvailability).toEqual([]);
  });
});

describe("Bob cache identity and secrecy", () => {
  it("never serves another key's snapshot on a transient failure", async () => {
    const { restore } = useCacheDir();
    try {
      seedCachedBob(OTHER_KEY);
      const report = await testAdapter({
        fetch: sequentialFetch([new Response("down", { status: 503 })]),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("error");
      expect(report.windows).toEqual([]);
    } finally {
      restore();
    }
  });

  it("does not let a rotated key's rejection retire the previous key's snapshot", async () => {
    const { restore } = useCacheDir();
    try {
      seedCachedBob(OTHER_KEY);
      const deleteCachedProvider = vi.fn();
      await testAdapter({
        fetch: sequentialFetch([jsonResponse(REJECTED_BODY, 401)]),
        deleteCachedProvider,
      }).fetchQuota(OPTIONS);

      expect(deleteCachedProvider).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("withholds a cached snapshot whose own reset has already passed", async () => {
    const { restore } = useCacheDir();
    try {
      seedCachedBob(SYNTHETIC_KEY);
      const report = await testAdapter({
        fetch: sequentialFetch([new Response("down", { status: 503 })]),
        now: () => Date.parse(RESET) + 1,
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("error");
      expect(report.windows).toEqual([]);
    } finally {
      restore();
    }
  });

  it("carries the untrusted marker through a stale reading", async () => {
    const { restore } = useCacheDir();
    try {
      seedCachedBob(SYNTHETIC_KEY, ["monthly_budget"]);
      const report = await testAdapter({
        fetch: sequentialFetch([new Response("down", { status: 503 })]),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("stale");
      expect(report.state.untrustedWindowIds).toEqual(["monthly_budget"]);
    } finally {
      restore();
    }
  });

  it("gives each key its own opaque identity and leaks neither key", () => {
    const one = bobCacheContextId(BOB_API_KEY_SOURCE, SYNTHETIC_KEY);
    const other = bobCacheContextId(BOB_API_KEY_SOURCE, OTHER_KEY);

    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(one).not.toBe(other);
    expect(one).not.toContain(SYNTHETIC_KEY);
  });

  it("keeps the key and every response name out of the report and the cache", async () => {
    const { cacheDir, restore } = useCacheDir();
    try {
      const report = await testAdapter({
        fetch: sequentialFetch([jsonResponse(PRO_PLUS)]),
      }).fetchQuota(OPTIONS);
      writeCachedProviders([report]);

      const cached = readFileSync(
        join(cacheDir, "quota-axi", "quotas.json"),
        "utf8",
      );
      for (const text of [JSON.stringify(report), cached]) {
        expect(text).not.toContain(SYNTHETIC_KEY);
        expect(text).not.toContain("fixture-");
        expect(text).not.toContain("Fixture");
        expect(text).not.toContain("fixture.invalid");
      }
    } finally {
      restore();
    }
  });

  it("drops identifiers while parsing, so none reaches an object", async () => {
    const seen: unknown[] = [];
    const parse = JSON.parse.bind(JSON);
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const value = parse(text, reviver) as unknown;
      seen.push(value);
      return value;
    });
    try {
      await testAdapter({
        fetch: sequentialFetch([jsonResponse(PRO_PLUS)]),
      }).fetchQuota(OPTIONS);
    } finally {
      spy.mockRestore();
    }

    expect(JSON.stringify(seen)).not.toContain("ixture");
  });

  it("shares one in-flight read", async () => {
    const request = sequentialFetch([jsonResponse(PRO_PLUS)]);
    const adapter = testAdapter({ fetch: request });

    await Promise.all([
      adapter.fetchQuota(OPTIONS),
      adapter.fetchQuota(OPTIONS),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
  });
});

type AdapterOverrides = Parameters<typeof createBobAdapter>[0];

function testAdapter(overrides: AdapterOverrides = {}): ProviderAdapter {
  return createBobAdapter({
    environment: () => ({ BOB_API_KEY: SYNTHETIC_KEY }),
    fetch: sequentialFetch([]),
    now: () => NOW,
    ...overrides,
  });
}

function sequentialFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn<typeof globalThis.fetch>(() => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected request");
    return Promise.resolve(next);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function useCacheDir(): { cacheDir: string; restore: () => void } {
  const previous = process.env.XDG_CACHE_HOME;
  const cacheDir = mkdtempSync(join(tmpdir(), "quota-axi-bob-"));
  process.env.XDG_CACHE_HOME = cacheDir;
  return {
    cacheDir,
    restore() {
      clearBobReadingContextId();
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}

function seedCachedBob(key: string, untrustedWindowIds?: string[]): void {
  publishBobReadingContextId(bobCacheContextId(BOB_API_KEY_SOURCE, key));
  writeCachedProviders([
    {
      provider: "bob",
      label: "Bob",
      source: "api",
      plan: "pro plus plan",
      windows: [MONTHLY_BUDGET],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(NOW - 60_000).toISOString(),
        ...(untrustedWindowIds ? { untrustedWindowIds } : {}),
        sourcesTried: [BOB_API_KEY_SOURCE],
      },
    },
  ]);
}
