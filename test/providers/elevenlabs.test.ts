import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeCachedProviders } from "../../src/cache.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createElevenLabsAdapter,
  createElevenLabsEnvSource,
  ELEVENLABS_API_KEY_SOURCE,
  ELEVENLABS_API_ORIGIN,
  ELEVENLABS_SOURCE_ORDER,
  ELEVENLABS_SUBSCRIPTION_PATH,
  normalizeElevenLabsPayload,
} from "../../src/providers/elevenlabs.js";
import { elevenLabsCacheContextId } from "../../src/providers/elevenlabs-cache-context.js";
import type { ProviderAdapter, ProviderQuota } from "../../src/types.js";

// Inside the fixture cycle: its reset is 2026-07-12, and a passed reset
// publishes no live window.
const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
// Synthetic. No real ElevenLabs key or account data appears in this tree.
const SYNTHETIC_KEY = "synthetic-elevenlabs-key-481";
const OTHER_KEY = "synthetic-elevenlabs-key-992";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), `test/fixtures/elevenlabs/${name}.json`),
      "utf8",
    ),
  ) as unknown;

const SUBSCRIPTION = fixture("subscription");
const ENTITLEMENT_ONLY = fixture("entitlement-only");
const ANNUAL_REFRESH = fixture("annual-refresh");
const UNKNOWN_REFRESH = fixture("unknown-refresh");

describe("ElevenLabs request transport", () => {
  it("makes one fixed-origin read-only GET authenticated with xi-api-key", async () => {
    const request = sequentialFetch([jsonResponse(SUBSCRIPTION)]);
    await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    const url = new URL(String(input));
    expect({
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      method: init?.method,
      redirect: init?.redirect,
      credentials: init?.credentials,
    }).toEqual({
      protocol: "https:",
      hostname: "api.elevenlabs.io",
      pathname: ELEVENLABS_SUBSCRIPTION_PATH,
      search: "",
      method: "GET",
      redirect: "manual",
      credentials: "omit",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("xi-api-key")).toBe(SYNTHETIC_KEY);
    // The key is never offered as a bearer to anything that did not ask for it.
    expect(headers.get("authorization")).toBeNull();
    expect(new URL(ELEVENLABS_API_ORIGIN).hostname).toBe("api.elevenlabs.io");
  });

  it("declares exactly one credential source", () => {
    expect([...ELEVENLABS_SOURCE_ORDER]).toEqual([ELEVENLABS_API_KEY_SOURCE]);
  });
});

/**
 * The provider onboarding matrix in skills/provider-onboarding/SKILL.md. Two
 * of its seven cases cannot arise for this provider and are asserted as such
 * rather than skipped: an ElevenLabs API key carries no expiry field, and
 * there is no second source to hand over to.
 */
describe("ElevenLabs credential matrix", () => {
  it("primary healthy: reports the included character allowance", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(SUBSCRIPTION)]),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.state.authStatus).toBe("usable");
    expect(report.plan).toBe("creator");
    expect(report.windows).toEqual([
      {
        id: "characters",
        label: "characters",
        kind: "monthly",
        percentUsed: 40,
        percentRemaining: 60,
        startsAt: "2026-06-12T00:00:00.000Z",
        resetsAt: "2026-07-12T00:00:00.000Z",
      },
    ]);
    expect(report.attempts).toEqual([
      { source: ELEVENLABS_API_KEY_SOURCE, status: "success" },
    ]);
  });

  it("stored-expired plus live sibling: cannot arise, and no key is ever skipped unprobed", async () => {
    // An ElevenLabs API key has no expiry field to order candidates by and no
    // sibling store to fall through to, so there is nothing that could skip a
    // readable key before the endpoint has rejected it. Every usable key is
    // probed exactly once.
    const request = sequentialFetch([new Response(null, { status: 401 })]);
    const report = await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("xi-api-key"),
    ).toBe(SYNTHETIC_KEY);
    expect(report.attempts).toHaveLength(1);
  });

  it("structurally invalid present: never sent, and reported as a credential that exists", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      envSource: envSource("$ELEVENLABS_API_KEY_INDIRECTION"),
      fetch: request as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toBe("elevenlabs_credential_invalid");
    expect(report.attempts).toEqual([
      {
        source: ELEVENLABS_API_KEY_SOURCE,
        status: "failed",
        error: "elevenlabs_credential_invalid",
        credentialPresent: true,
      },
    ]);
  });

  it("absent source: no request, no credentialPresent marker", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      envSource: envSource(undefined),
      fetch: request as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toBe("elevenlabs_credential_unavailable");
    expect(report.attempts?.[0].credentialPresent).toBeUndefined();
    expect(report.attempts?.[0].status).toBe("skipped");
  });

  it("all rejected: HTTP 401 is a sign-out that retires this key's cache", async () => {
    const deleted: string[] = [];
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 401 })]),
      deleteCachedProvider: (provider) => deleted.push(provider),
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toBe("provider_auth_rejected");
    expect(report.state.authStatus).toBe("unusable");
    expect(report.source).toBe("unavailable");
    expect(deleted).toEqual(["elevenlabs"]);
  });

  it("refreshable expiry: cannot arise, and the adapter declares no refresh delegate", async () => {
    const adapter = testAdapter({
      fetch: sequentialFetch([jsonResponse(SUBSCRIPTION)]),
    });
    // No `discoverAccounts`, no delegated refresh: `refreshCredentials: true`
    // must change nothing, because there is no rotation to delegate.
    expect(adapter.discoverAccounts).toBeUndefined();
    const refreshed = await testAdapter({
      fetch: sequentialFetch([jsonResponse(SUBSCRIPTION)]),
    }).fetchQuota({ ...OPTIONS, refreshCredentials: true });
    const plain = await adapter.fetchQuota(OPTIONS);
    expect(refreshed.windows).toEqual(plain.windows);
    expect(refreshed.state.status).toBe("fresh");
  });

  it("transient failure stops handover: no auth verdict, cache preserved, stale served", async () => {
    const deleted: string[] = [];
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 503 })]),
      deleteCachedProvider: (provider) => deleted.push(provider),
      readCachedProvider: (contextId) =>
        contextId ===
        elevenLabsCacheContextId(ELEVENLABS_API_KEY_SOURCE, SYNTHETIC_KEY)
          ? cachedQuota()
          : undefined,
    }).fetchQuota(OPTIONS);

    expect(deleted).toEqual([]);
    expect(report.state.status).toBe("stale");
    expect(report.state.stale).toBe(true);
    expect(report.state.authStatus).toBe("usable");
    expect(report.state.error).toBe("provider_unavailable");
    expect(report.source).toBe("cache");
  });
});

describe("ElevenLabs auth classification", () => {
  it.each([false, true])(
    "preserves a restricted key's auth and cache (cached: %s)",
    async (hasCache) => {
      const deleted = vi.fn();
      const providerMessage = `Permission denied for ${SYNTHETIC_KEY}`;
      const report = await testAdapter({
        fetch: sequentialFetch([
          new Response(
            JSON.stringify({
              detail: {
                status: "missing_permissions",
                message: providerMessage,
              },
            }),
            { status: 401 },
          ),
        ]),
        deleteCachedProvider: deleted,
        readCachedProvider: () => (hasCache ? cachedQuota() : undefined),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe(hasCache ? "stale" : "error");
      expect(report.state.authStatus).toBe("usable");
      expect(report.state.error).toBe("elevenlabs_user_read_denied");
      expect(report.windows).toEqual(hasCache ? cachedQuota().windows : []);
      expect(deleted).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain(providerMessage);
      expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
    },
  );

  it.each([
    '{"detail":{"status":"invalid_api_key","message":"missing_permissions"}}',
    '{"detail":"missing_permissions"}',
    "missing_permissions",
  ])(
    "does not infer permission denial from an unrecognized 401 body: %s",
    async (body) => {
      const report = await testAdapter({
        fetch: sequentialFetch([new Response(body, { status: 401 })]),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("auth_required");
      expect(report.state.error).toBe("provider_auth_rejected");
    },
  );

  it("bounds a 401 body before classifying it and preserves uncertain cache", async () => {
    const deleted = vi.fn();
    const cancel = vi.fn();
    const report = await testAdapter({
      fetch: sequentialFetch([
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(262_145));
            },
            cancel,
          }),
          { status: 401 },
        ),
      ]),
      deleteCachedProvider: deleted,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("stale");
    expect(report.state.error).toBe("response_too_large");
    expect(deleted).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out a stalled 401 body without declaring sign-out", async () => {
    const deleted = vi.fn();
    const cancel = vi.fn();
    const report = await testAdapter({
      fetch: sequentialFetch([
        new Response(new ReadableStream({ cancel }), { status: 401 }),
      ]),
      deadlineMs: 10,
      deleteCachedProvider: deleted,
      readCachedProvider: () => cachedQuota(),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("stale");
    expect(report.state.error).toBe("request_timeout");
    expect(deleted).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("treats HTTP 403 as a live key this operation refuses, not a sign-out", async () => {
    const deleted: string[] = [];
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 403 })]),
      deleteCachedProvider: (provider) => deleted.push(provider),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("elevenlabs_user_read_denied");
    expect(report.state.authStatus).toBe("usable");
    expect(deleted).toEqual([]);
  });

  it("carries Retry-After through a rate limit without retiring the cache", async () => {
    const deleted: string[] = [];
    const report = await testAdapter({
      fetch: sequentialFetch([
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
      ]),
      deleteCachedProvider: (provider) => deleted.push(provider),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("rate_limited");
    expect(report.state.retryAfter).toBe(new Date(NOW + 120_000).toISOString());
    expect(deleted).toEqual([]);
  });

  it("inspectAuth names the environment source without reading its value", async () => {
    const report = await testAdapter({}).inspectAuth(OPTIONS);
    expect(report).toEqual({
      provider: "elevenlabs",
      sources: [
        {
          source: ELEVENLABS_API_KEY_SOURCE,
          path: "ELEVENLABS_API_KEY",
          status: "available",
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
  });

  it.each([
    ["absent", undefined, "missing"],
    ["blank", "   ", "missing"],
    ["an environment reference", "$OTHER", "invalid"],
    ["a control byte", "abcdef", "invalid"],
  ])("reports %s ELEVENLABS_API_KEY as %s", async (_label, value, expected) => {
    const report = await testAdapter({
      envSource: envSource(value),
    }).inspectAuth(OPTIONS);
    expect(report.sources[0].status).toBe(expected);
  });
});

describe("ElevenLabs payload normalization", () => {
  it.each([1_783_814_400, 1_783_814_400_000])(
    "interprets the reset field as Unix seconds: %s",
    async (seconds) => {
      const report = await testAdapter({
        fetch: sequentialFetch([
          jsonResponse({
            ...(SUBSCRIPTION as Record<string, unknown>),
            next_character_count_reset_unix: seconds,
          }),
        ]),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("fresh");
      expect(report.windows[0].resetsAt).toBe(
        new Date(seconds * 1000).toISOString(),
      );
    },
  );

  it("guards a zero character limit instead of deriving a percentage", () => {
    const normalized = normalizeElevenLabsPayload(ENTITLEMENT_ONLY, NOW);
    expect(normalized.windows).toEqual([]);
    expect(normalized.plan).toBe("free");
  });

  it("clears the cached lane when an entitlement-only reading has no windows", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(ENTITLEMENT_ONLY)]),
    }).fetchQuota(OPTIONS);

    // A fresh report with no windows is what makes `writeCachedProviders` drop
    // this lane's snapshot; inventing 0% or 100% here would do the opposite.
    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([]);
  });

  it("steps the cycle start back by the vendor's declared refresh period", () => {
    const [window] = normalizeElevenLabsPayload(ANNUAL_REFRESH, NOW).windows;
    expect(window.startsAt).toBe("2025-07-12T00:00:00.000Z");
    expect(window.resetsAt).toBe("2026-07-12T00:00:00.000Z");
    // Only `monthly_period` maps onto the published `monthly` window kind.
    expect(window.kind).toBe("unknown");
  });

  it("leaves the cycle unresolved for an unrecognized refresh period", () => {
    const [window] = normalizeElevenLabsPayload(UNKNOWN_REFRESH, NOW).windows;
    expect(window.startsAt).toBeUndefined();
    expect(window.resetsAt).toBe("2026-07-12T00:00:00.000Z");
    expect(window.kind).toBe("unknown");
  });

  it("resolves no reset from a null, zero, or pre-2001 reset field", () => {
    for (const value of [null, 0, -1, 12345, "1783814400"]) {
      const [window] = normalizeElevenLabsPayload(
        {
          ...(SUBSCRIPTION as Record<string, unknown>),
          next_character_count_reset_unix: value,
        },
        NOW,
      ).windows;
      expect(window.resetsAt).toBeUndefined();
      expect(window.startsAt).toBeUndefined();
    }
  });

  it("publishes no live window once the reported reset has passed", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([
        jsonResponse({
          ...(SUBSCRIPTION as Record<string, unknown>),
          next_character_count_reset_unix: (NOW - 60_000) / 1000,
        }),
      ]),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([]);
  });

  it("keeps a live window whose reported reset is still ahead", () => {
    const payload = {
      ...(SUBSCRIPTION as Record<string, unknown>),
      next_character_count_reset_unix: (NOW + 60_000) / 1000,
    };
    expect(normalizeElevenLabsPayload(payload, NOW).windows).toHaveLength(1);
    expect(normalizeElevenLabsPayload(payload, NOW + 60_000).windows).toEqual(
      [],
    );
  });

  it("clamps a count that has run past the limit to 100% used", () => {
    const [window] = normalizeElevenLabsPayload(
      {
        ...(SUBSCRIPTION as Record<string, unknown>),
        character_count: 150000,
      },
      NOW,
    ).windows;
    expect(window.percentUsed).toBe(100);
    expect(window.percentRemaining).toBe(0);
  });

  it("rejects a response that is not a subscription object", () => {
    for (const payload of [null, [], "nope", 7, {}]) {
      expect(() => normalizeElevenLabsPayload(payload, NOW)).toThrow();
    }
  });
});

describe("ElevenLabs quota semantics", () => {
  it.each([
    [99_600, 99.6, 0.4],
    [99_999, 99.999, 0.001],
    [100_000, 100, 0],
    [100_001, 100, 0],
  ])(
    "preserves headroom until the character limit is reached: %s used",
    async (used, percentUsed, remaining) => {
      const report = withQuotaSemantics(
        await testAdapter({
          fetch: sequentialFetch([
            jsonResponse({
              ...(SUBSCRIPTION as Record<string, unknown>),
              character_count: used,
              character_limit: 100_000,
              next_character_count_reset_unix: (NOW + 604_800_000) / 1000,
            }),
          ]),
        }).fetchQuota(OPTIONS),
        new Date(NOW).toISOString(),
      );

      expect(report.state.status).toBe("fresh");
      expect(report.windows[0].percentUsed).toBeCloseTo(percentUsed, 8);
      expect(report.windows[0].percentRemaining).toBeCloseTo(remaining, 8);
      const availability = report.quotaSemantics?.effectiveAvailability[0];
      expect(availability?.effectivePercentRemaining).toBeCloseTo(remaining, 8);
      expect(availability?.runway?.status).toBe(
        remaining > 0 ? "projected_exhaustion" : "exhausted_now",
      );
      if (remaining > 0) {
        expect(availability?.runway?.usableRunwaySeconds).toBeGreaterThan(0);
      } else {
        expect(availability?.runway?.usableRunwaySeconds).toBe(0);
      }
    },
  );

  it("bounds included_characters only, never all_models or a model scope", async () => {
    const report = withQuotaSemantics(
      await testAdapter({
        fetch: sequentialFetch([jsonResponse(SUBSCRIPTION)]),
      }).fetchQuota(OPTIONS),
      new Date(NOW).toISOString(),
    );

    expect(report.quotaSemantics?.status).toBe("known");
    expect(
      report.quotaSemantics?.effectiveAvailability.map(({ scope }) => scope),
    ).toEqual(["included_characters"]);
    expect(report.quotaSemantics?.description).toContain(
      "included allowance is spent, not that requests are refused",
    );
  });

  it("publishes no effective availability when the reading has no window", async () => {
    const report = withQuotaSemantics(
      await testAdapter({
        fetch: sequentialFetch([jsonResponse(ENTITLEMENT_ONLY)]),
      }).fetchQuota(OPTIONS),
      new Date(NOW).toISOString(),
    );

    expect(report.quotaSemantics?.status).toBe("unknown");
    expect(report.quotaSemantics?.effectiveAvailability).toEqual([]);
  });
});

describe("ElevenLabs cache identity", () => {
  it.each([
    ["absent key", undefined, true],
    ["invalid local key", "$OTHER", true],
    ["rejected different key", OTHER_KEY, true],
    ["rejected same key", SYNTHETIC_KEY, false],
  ])(
    "retires only the identified key's disk snapshot: %s",
    async (_label, key, preserved) => {
      const directory = mkdtempSync(join(process.cwd(), ".elevenlabs-cache-"));
      vi.stubEnv("XDG_CACHE_HOME", directory);
      try {
        const makeAdapter = (
          credential: string | undefined,
          response: Response,
        ) =>
          createElevenLabsAdapter({
            envSource: envSource(credential),
            fetch: sequentialFetch([response]),
            now: () => NOW,
          });
        const fresh = await makeAdapter(
          SYNTHETIC_KEY,
          jsonResponse({
            ...(SUBSCRIPTION as Record<string, unknown>),
            next_character_count_reset_unix: (NOW + 604_800_000) / 1000,
          }),
        ).fetchQuota(OPTIONS);
        expect(fresh.state.status).toBe("fresh");
        writeCachedProviders([fresh]);

        const rejected = await makeAdapter(
          key,
          new Response(null, { status: 401 }),
        ).fetchQuota(OPTIONS);
        expect(rejected.state.status).toBe("auth_required");
        writeCachedProviders([rejected]);

        const restored = await makeAdapter(
          SYNTHETIC_KEY,
          new Response(null, { status: 503 }),
        ).fetchQuota(OPTIONS);
        expect(restored.source).toBe(preserved ? "cache" : "unavailable");
        expect(restored.windows).toEqual(preserved ? fresh.windows : []);
      } finally {
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("gives each key its own opaque identity and leaks neither key", () => {
    const mine = elevenLabsCacheContextId(
      ELEVENLABS_API_KEY_SOURCE,
      SYNTHETIC_KEY,
    );
    const theirs = elevenLabsCacheContextId(
      ELEVENLABS_API_KEY_SOURCE,
      OTHER_KEY,
    );

    expect(mine).toMatch(/^[a-f0-9]{64}$/);
    expect(mine).not.toBe(theirs);
    expect(mine).not.toContain(SYNTHETIC_KEY);
    expect(theirs).not.toContain(OTHER_KEY);
  });

  it("never serves another key's snapshot on a transient failure", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 500 })]),
      readCachedProvider: (contextId) =>
        contextId ===
        elevenLabsCacheContextId(ELEVENLABS_API_KEY_SOURCE, OTHER_KEY)
          ? cachedQuota()
          : undefined,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("unavailable");
    expect(report.state.stale).toBe(false);
  });

  it("withholds a cached snapshot whose own reset has already passed", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 500 })]),
      readCachedProvider: () => ({
        ...cachedQuota(),
        windows: [
          {
            id: "characters",
            label: "characters",
            kind: "monthly" as const,
            percentUsed: 10,
            percentRemaining: 90,
            resetsAt: new Date(NOW - 1_000).toISOString(),
          },
        ],
      }),
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("unavailable");
    expect(report.state.stale).toBe(false);
  });
});

function testAdapter(
  overrides: Partial<Parameters<typeof createElevenLabsAdapter>[0]> = {},
): ProviderAdapter {
  return createElevenLabsAdapter({
    envSource: envSource(SYNTHETIC_KEY),
    fetch: sequentialFetch([
      jsonResponse(SUBSCRIPTION),
    ]) as unknown as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function envSource(value: string | undefined) {
  return createElevenLabsEnvSource(
    value === undefined ? {} : { ELEVENLABS_API_KEY: value },
  );
}

function sequentialFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn(async (_input: unknown, _init?: RequestInit) => {
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
    provider: "elevenlabs",
    label: "ElevenLabs",
    source: "api",
    plan: "creator",
    windows: [
      {
        id: "characters",
        label: "characters",
        kind: "monthly",
        percentUsed: 10,
        percentRemaining: 90,
        startsAt: new Date(NOW - 7 * 86_400_000).toISOString(),
        resetsAt: new Date(NOW + 7 * 86_400_000).toISOString(),
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: new Date(NOW - 60_000).toISOString(),
      sourcesTried: [ELEVENLABS_API_KEY_SOURCE],
    },
  };
}
