import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCachedMuseProvider,
  writeCachedProviders,
} from "../../src/cache.js";
import { main } from "../../src/cli.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { PROVIDERS } from "../../src/providers/index.js";
import {
  createMuseAdapter,
  createMuseApiKeySource,
  createMuseAuthFileSource,
  MUSE_API_KEY_SOURCE,
  MUSE_API_VERSION,
  MUSE_AUTH_FILE_SOURCE,
  MUSE_KEY_PATH,
  MUSE_SOURCE_ORDER,
  museAuthFilePath,
  normalizeMusePayload,
} from "../../src/providers/muse.js";
import { museCacheContextId } from "../../src/providers/muse-cache-context.js";
import { MUSE_KEYCHAIN_SOURCE } from "../../src/providers/muse-keychain-credential.js";
import {
  createFileMuseKeyReadLedger,
  MUSE_KEY_READ_INTERVAL_MS,
  type MuseKeyRead,
  type MuseKeyReadLedger,
} from "../../src/providers/muse-read-gate.js";
import type { ProviderAdapter, ProviderQuota } from "../../src/types.js";

// Inside both fixture windows: the session resets at +2h, the week at +3d.
const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
// Synthetic. No real Muse credential, key, or account data appears in this tree.
const ACCESS_TOKEN = "synthetic-muse-access-token-311";
const ROTATED_TOKEN = "synthetic-muse-access-token-312";
const REFRESH_TOKEN = "SENTINEL-MUSE-REFRESH-TOKEN-never-read";
const API_KEY = "synthetic-meta-api-key-774";
const SENTINELS = [
  "SENTINEL-MUSE-ISSUED-KEY-must-never-appear",
  "SENTINEL-MUSE-KEY-ID",
  "sentinel-muse-user@example.invalid",
  "SENTINEL Muse Display Name",
  "SENTINEL-CARD-BRAND",
  REFRESH_TOKEN,
  ACCESS_TOKEN,
  API_KEY,
];

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), `test/fixtures/muse/${name}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;

const KEY_RESPONSE = fixture("key-response");
const INACTIVE = fixture("inactive");
/** Muse Code 1.4.0 Power Usage mint: active plan, `subs_usage` omitted. */
const EMPTY_ACTIVE = {
  api_key: "SENTINEL-MUSE-ISSUED-KEY-must-never-appear",
  email: "sentinel-muse-user@example.invalid",
  name: "SENTINEL Muse Display Name",
  payment_method: { brand: "SENTINEL-CARD-BRAND", last4: "0000" },
  is_subs_active: true,
  subs_tier_name: "pro",
};

const EXPECTED_WINDOWS = [
  {
    id: "five_hour",
    label: "session",
    kind: "session",
    windowSeconds: 18_000,
    percentUsed: 42.5,
    percentRemaining: 57.5,
    resetsAt: "2026-06-20T14:00:00.000Z",
  },
  {
    id: "weekly",
    label: "week",
    kind: "weekly",
    windowSeconds: 604_800,
    percentUsed: 17,
    percentRemaining: 83,
    resetsAt: "2026-06-23T12:00:00.000Z",
  },
];

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "quota-axi-muse-"));
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe("Muse request transport", () => {
  it("makes one POST to the key endpoint with the stored bearer and onboard false", async () => {
    const request = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    const url = new URL(String(input));
    expect({
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      method: init?.method,
      body: init?.body,
      redirect: init?.redirect,
      credentials: init?.credentials,
    }).toEqual({
      origin: "https://api.meta.ai",
      pathname: MUSE_KEY_PATH,
      search: "",
      method: "POST",
      body: JSON.stringify({ onboard: false }),
      redirect: "manual",
      credentials: "omit",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("x-api-version")).toBe(MUSE_API_VERSION);
  });

  it("declares the Muse CLI sign-in stores before the exported key", () => {
    expect([...MUSE_SOURCE_ORDER]).toEqual([
      MUSE_AUTH_FILE_SOURCE,
      MUSE_KEYCHAIN_SOURCE,
      MUSE_API_KEY_SOURCE,
    ]);
  });

  it("reads auth.json under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(museAuthFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "muse", "auth.json"),
    );
    expect(museAuthFilePath({})).toMatch(/\.config[/\\]muse[/\\]auth\.json$/);
  });
});

/** The provider onboarding matrix in AGENTS.md. */
describe("Muse credential matrix", () => {
  it("primary healthy: reports the five-hour and weekly windows", async () => {
    const report = await testAdapter().fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.state.authStatus).toBe("usable");
    expect(report.source).toBe("api");
    expect(report.plan).toBe("pro");
    expect(report.windows).toEqual(EXPECTED_WINDOWS);
    expect(report.attempts).toEqual([
      { source: MUSE_AUTH_FILE_SOURCE, status: "success" },
      { source: MUSE_API_KEY_SOURCE, status: "skipped" },
    ]);
  });

  it("an unused later credential is not a degraded source on a healthy reading", async () => {
    const request = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const report = await testAdapter({
      sources: [authFileSource(authStore()), apiKeySource(API_KEY)],
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(bearers(request)).toEqual([`Bearer ${ACCESS_TOKEN}`]);
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      { source: MUSE_AUTH_FILE_SOURCE, status: "success" },
      {
        source: MUSE_API_KEY_SOURCE,
        status: "skipped",
        credentialPresent: true,
        degraded: false,
      },
    ]);
    expect(
      withQuotaSemantics(report, new Date(NOW).toISOString()).state
        .degradedSources,
    ).toBeUndefined();
  });

  it("rejected stored token plus live exported key: the key answers and the store reads degraded", async () => {
    const request = sequentialFetch([
      new Response(null, { status: 401 }),
      jsonResponse(KEY_RESPONSE),
    ]);
    const report = await testAdapter({
      sources: [authFileSource(authStore()), apiKeySource(API_KEY)],
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(bearers(request)).toEqual([
      `Bearer ${ACCESS_TOKEN}`,
      `Bearer ${API_KEY}`,
    ]);
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      {
        source: MUSE_AUTH_FILE_SOURCE,
        status: "failed",
        error: "muse_access_token_rejected",
      },
      { source: MUSE_API_KEY_SOURCE, status: "success" },
    ]);
    expect(
      withQuotaSemantics(report, new Date(NOW).toISOString()).state
        .degradedSources,
    ).toEqual([
      { source: MUSE_AUTH_FILE_SOURCE, error: "muse_access_token_rejected" },
    ]);
  });

  it.each([
    [
      "a non-object meta entry",
      { providers: { meta: "token" } },
      "muse_meta_entry_invalid",
    ],
    [
      "an environment reference",
      authStore("$MUSE_TOKEN"),
      "muse_access_token_invalid",
    ],
    [
      "a missing access token",
      { providers: { meta: {} } },
      "muse_access_token_invalid",
    ],
    ["unparseable JSON", "{not json", "muse_auth_invalid"],
  ])(
    "structurally invalid present (%s): never sent, reported as a credential that exists",
    async (_label, store, error) => {
      const request = vi.fn();
      const report = await testAdapter({
        sources: [authFileSource(store), apiKeySource(undefined)],
        fetch: request as unknown as typeof fetch,
      }).fetchQuota(OPTIONS);

      expect(request).not.toHaveBeenCalled();
      expect(report.state.status).toBe("error");
      expect(report.state.authStatus).toBeUndefined();
      expect(report.state.error).toBe(error);
      expect(report.attempts?.[0]).toEqual({
        source: MUSE_AUTH_FILE_SOURCE,
        status: "failed",
        error,
        credentialPresent: true,
      });
    },
  );

  it("an unreadable auth file with no fallback is an operational failure, not a sign-out", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      sources: [
        createMuseAuthFileSource(
          () => "/synthetic/muse/auth.json",
          async () => {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          },
        ),
        apiKeySource(undefined),
      ],
      fetch: request as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("error");
    expect(report.state.authStatus).toBeUndefined();
    expect(report.state.error).toBe("muse_auth_read_error");
  });

  it.each([
    ["no file", undefined],
    ["no providers", {}],
    ["no meta entry", { providers: { other: { access_token: "x" } } }],
  ])(
    "absent source (%s): no request, no credentialPresent marker",
    async (_label, store) => {
      const request = vi.fn();
      const report = await testAdapter({
        sources: [authFileSource(store), apiKeySource(undefined)],
        fetch: request as unknown as typeof fetch,
      }).fetchQuota(OPTIONS);

      expect(request).not.toHaveBeenCalled();
      expect(report.state).toMatchObject({
        status: "auth_required",
        authStatus: "unusable",
        error: "muse_credential_unavailable",
      });
      expect(report.attempts).toEqual([
        { source: MUSE_AUTH_FILE_SOURCE, status: "skipped" },
        { source: MUSE_API_KEY_SOURCE, status: "skipped" },
      ]);
    },
  );

  it("all rejected: HTTP 401 without a refresh path is a sign-out that retires this credential's cache", async () => {
    const deleteCachedProvider = vi.fn();
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 401 })]),
      readCachedProvider: () => cachedQuota(),
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      authStatus: "unusable",
      error: "muse_access_token_rejected",
    });
    expect(deleteCachedProvider).toHaveBeenCalledTimes(1);
  });

  it("refreshable expiry: a rejected token beside a refresh token is soft expiry, never sign-out, and the refresh token is never sent", async () => {
    const request = sequentialFetch([new Response(null, { status: 401 })]);
    const deleteCachedProvider = vi.fn();
    const report = await testAdapter({
      sources: [
        authFileSource(authStore(ACCESS_TOKEN, REFRESH_TOKEN)),
        apiKeySource(undefined),
      ],
      fetch: request,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "unavailable",
      authStatus: "expired_refreshable",
      error: "muse_access_token_rejected",
    });
    expect(deleteCachedProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(request.mock.calls)).not.toContain(REFRESH_TOKEN);
  });

  it("refreshable expiry serves the rejected source's snapshot stale", async () => {
    const deleteCachedProvider = vi.fn();
    const report = await testAdapter({
      sources: [
        authFileSource(authStore(ACCESS_TOKEN, REFRESH_TOKEN)),
        apiKeySource(undefined),
      ],
      fetch: sequentialFetch([new Response(null, { status: 401 })]),
      readCachedProvider: (contextId) =>
        contextId === museCacheContextId(MUSE_AUTH_FILE_SOURCE, ACCESS_TOKEN)
          ? cachedQuota()
          : undefined,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("cache");
    expect(report.windows).toEqual(EXPECTED_WINDOWS);
    expect(report.state).toMatchObject({
      status: "stale",
      stale: true,
      authStatus: "expired_refreshable",
      error: "muse_access_token_rejected",
    });
    expect(deleteCachedProvider).not.toHaveBeenCalled();
  });

  it("does not serve a stale snapshot whose refreshedAt is after now", async () => {
    const cached = cachedQuota();
    cached.state.refreshedAt = new Date(NOW + 60_000).toISOString();
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 503 })]),
      readCachedProvider: () => cached,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("unavailable");
    expect(report.windows).toEqual([]);
    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_unavailable",
    });
  });

  it("transient failure stops handover: no auth verdict, and the credential's own snapshot is served stale", async () => {
    const request = sequentialFetch([new Response(null, { status: 503 })]);
    const report = await testAdapter({
      sources: [authFileSource(authStore()), apiKeySource(API_KEY)],
      fetch: request,
      readCachedProvider: (contextId) =>
        contextId === museCacheContextId(MUSE_AUTH_FILE_SOURCE, ACCESS_TOKEN)
          ? cachedQuota()
          : undefined,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.source).toBe("cache");
    expect(report.state).toMatchObject({
      status: "stale",
      stale: true,
      authStatus: "usable",
      error: "provider_unavailable",
    });
    expect(report.attempts).toEqual([
      {
        source: MUSE_AUTH_FILE_SOURCE,
        status: "failed",
        error: "provider_unavailable",
      },
      {
        source: MUSE_API_KEY_SOURCE,
        status: "skipped",
        credentialPresent: true,
        degraded: false,
      },
    ]);
  });
});

describe("Muse auth classification", () => {
  it("treats HTTP 403 as a refused request, not a sign-out", async () => {
    const deleteCachedProvider = vi.fn();
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 403 })]),
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("provider_request_forbidden");
    expect(report.state.authStatus).toBeUndefined();
    expect(deleteCachedProvider).not.toHaveBeenCalled();
  });

  it("carries Retry-After through a rate limit", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
      ]),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "rate_limited",
      authStatus: "usable",
      retryAfter: new Date(NOW + 120_000).toISOString(),
    });
  });

  it("refuses to follow a redirect", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([
        new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/" },
        }),
      ]),
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("redirect_rejected");
  });

  it("inspectAuth names both sources locally and never contacts the key endpoint", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      sources: [authFileSource(authStore()), apiKeySource("$INDIRECT")],
      fetch: request as unknown as typeof fetch,
    }).inspectAuth(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.sources).toEqual([
      {
        source: MUSE_AUTH_FILE_SOURCE,
        path: expect.stringContaining("auth.json") as string,
        status: "available",
      },
      {
        source: MUSE_API_KEY_SOURCE,
        path: "META_API_KEY",
        status: "invalid",
        error: "meta_api_key_invalid",
        credentialPresent: true,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(ACCESS_TOKEN);
  });
});

/**
 * Every key-endpoint request also issues an API key, so the interval gate is
 * the provider's central safety property: one request per credential per
 * interval, whatever the outcome, across processes sharing the cache.
 */
describe("Muse key-endpoint interval", () => {
  it("serves its own reading inside the interval without sending another request", async () => {
    useDiskCache();
    let now = NOW;
    const request = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const adapter = () => diskAdapter({ fetch: request, now: () => now });

    const first = await adapter().fetchQuota(OPTIONS);
    writeCachedProviders([first]);
    now += MUSE_KEY_READ_INTERVAL_MS - 1_000;
    const second = await adapter().fetchQuota(OPTIONS);
    writeCachedProviders([second]);
    const third = await adapter().fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    for (const replayed of [second, third]) {
      expect(replayed.source).toBe("cache");
      expect(replayed.state).toMatchObject({
        status: "fresh",
        stale: false,
        authStatus: "usable",
        refreshedAt: first.state.refreshedAt,
      });
      expect(replayed.windows).toEqual(first.windows);
    }
    // A replayed reading is never written back as a new observation.
    expect(readCachedMuseProvider(contextFor(ACCESS_TOKEN))?.source).toBe(
      "api",
    );
  });

  it("replays an empty successful reading inside the interval without sending another request", async () => {
    useDiskCache();
    let now = NOW;
    const request = sequentialFetch([jsonResponse(EMPTY_ACTIVE)]);
    const adapter = () => diskAdapter({ fetch: request, now: () => now });

    const first = await adapter().fetchQuota(OPTIONS);
    writeCachedProviders([first]);
    now += MUSE_KEY_READ_INTERVAL_MS - 1_000;
    const second = await adapter().fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      source: "api",
      plan: "pro",
      windows: [],
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
    expect(first.state.untrustedWindowIds).toBeUndefined();
    expect(second).toMatchObject({
      source: "cache",
      plan: "pro",
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        refreshedAt: first.state.refreshedAt,
      },
    });
    expect(second.state.error).toBeUndefined();
    expect(second.state.untrustedWindowIds).toBeUndefined();
    expect(readCachedMuseProvider(contextFor(ACCESS_TOKEN))).toBeUndefined();
    const ledger = JSON.parse(
      readFileSync(
        join(directory, "cache", "quota-axi", "muse-key-reads.json"),
        "utf8",
      ),
    ) as { reads: Record<string, { outcome: string; emptyQuota?: unknown }> };
    expect(ledger.reads[contextFor(ACCESS_TOKEN)]).toMatchObject({
      outcome: "quota",
      emptyQuota: {
        refreshedAt: new Date(NOW).toISOString(),
        plan: "pro",
      },
    });
    const contents = JSON.stringify(ledger);
    for (const sentinel of SENTINELS) expect(contents).not.toContain(sentinel);
    expect(contents).not.toContain("used_percent");
    expect(contents).not.toContain("api_key");
  });

  it("replays an inactive subscription's empty observation inside the interval", async () => {
    useDiskCache();
    let now = NOW;
    const request = sequentialFetch([jsonResponse(INACTIVE)]);
    const adapter = () => diskAdapter({ fetch: request, now: () => now });

    const first = await adapter().fetchQuota(OPTIONS);
    writeCachedProviders([first]);
    now += 1_000;
    const second = await adapter().fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      source: "api",
      windows: [],
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
    expect(first.plan).toBeUndefined();
    expect(second).toMatchObject({
      source: "cache",
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        refreshedAt: first.state.refreshedAt,
      },
    });
    expect(second.plan).toBeUndefined();
    expect(second.state.error).toBeUndefined();
  });

  it("replays a reading whose every reset had already passed", async () => {
    useDiskCache();
    let now = NOW;
    const request = sequentialFetch([
      jsonResponse({
        is_subs_active: true,
        subs_tier_name: "pro",
        subs_usage: {
          window: {
            used_percent: 90,
            window_duration_mins: 300,
            resets_at: NOW / 1000 - 1,
          },
          weekly: { used_percent: 10, resets_at: NOW / 1000 - 1 },
        },
      }),
    ]);
    const adapter = () => diskAdapter({ fetch: request, now: () => now });

    const first = await adapter().fetchQuota(OPTIONS);
    writeCachedProviders([first]);
    now += 1_000;
    const second = await adapter().fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      source: "api",
      plan: "pro",
      windows: [],
      state: { status: "fresh", authStatus: "usable" },
    });
    expect(second).toMatchObject({
      source: "cache",
      plan: "pro",
      windows: [],
      state: {
        status: "fresh",
        authStatus: "usable",
        refreshedAt: first.state.refreshedAt,
      },
    });
    expect(second.state.error).toBeUndefined();
  });

  it("does not invent an empty reading when a windowed quota snapshot is missing", async () => {
    useDiskCache();
    const request = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const first = await diskAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(first.windows).toEqual(EXPECTED_WINDOWS);
    expect(readCachedMuseProvider(contextFor(ACCESS_TOKEN))).toBeUndefined();
    const second = await diskAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(second.source).toBe("unavailable");
    expect(second.plan).toBeUndefined();
    expect(second.windows).toEqual([]);
    expect(second.state).toMatchObject({
      status: "unavailable",
      error: "muse_read_deferred",
    });
    expect(
      JSON.parse(
        readFileSync(
          join(directory, "cache", "quota-axi", "muse-key-reads.json"),
          "utf8",
        ),
      ).reads[contextFor(ACCESS_TOKEN)].emptyQuota,
    ).toBeUndefined();
  });

  it("sends the next request once the interval has passed", async () => {
    useDiskCache();
    let now = NOW;
    const request = sequentialFetch([
      jsonResponse(KEY_RESPONSE),
      jsonResponse(KEY_RESPONSE),
    ]);
    const first = await diskAdapter({
      fetch: request,
      now: () => now,
    }).fetchQuota(OPTIONS);
    writeCachedProviders([first]);
    now += MUSE_KEY_READ_INTERVAL_MS;
    const second = await diskAdapter({
      fetch: request,
      now: () => now,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(second.source).toBe("api");
  });

  it("replays a rejection inside the interval instead of re-sending the rejected token", async () => {
    useDiskCache();
    const request = sequentialFetch([new Response(null, { status: 401 })]);
    await diskAdapter({ fetch: request }).fetchQuota(OPTIONS);
    const replayed = await diskAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(replayed.state).toMatchObject({
      status: "auth_required",
      error: "muse_access_token_rejected",
    });
  });

  it("defers after a failed request, naming when the next may leave, and serves the older snapshot stale", async () => {
    useDiskCache();
    let now = NOW;
    const request = sequentialFetch([
      jsonResponse(KEY_RESPONSE),
      new Response(null, { status: 503 }),
    ]);
    writeCachedProviders([
      await diskAdapter({ fetch: request, now: () => now }).fetchQuota(OPTIONS),
    ]);
    now += MUSE_KEY_READ_INTERVAL_MS;
    const failed = await diskAdapter({
      fetch: request,
      now: () => now,
    }).fetchQuota(OPTIONS);
    const deferred = await diskAdapter({
      fetch: request,
      now: () => now + 1_000,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(failed.state.status).toBe("stale");
    expect(deferred.source).toBe("cache");
    expect(deferred.state).toMatchObject({
      status: "stale",
      error: "muse_read_deferred",
      retryAfter: new Date(now + MUSE_KEY_READ_INTERVAL_MS).toISOString(),
    });
  });

  it("reports a deferred read as unavailable, not an error or a sign-out, when no snapshot can stand in", async () => {
    useDiskCache();
    const request = sequentialFetch([new Response(null, { status: 503 })]);
    await diskAdapter({ fetch: request }).fetchQuota(OPTIONS);
    const deferred = await diskAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(deferred.source).toBe("unavailable");
    expect(deferred.state).toEqual({
      status: "unavailable",
      stale: false,
      error: "muse_read_deferred",
      retryAfter: new Date(NOW + MUSE_KEY_READ_INTERVAL_MS).toISOString(),
      sourcesTried: [MUSE_AUTH_FILE_SOURCE, MUSE_API_KEY_SOURCE],
    });
  });

  it("records the request as pending before it leaves", async () => {
    useDiskCache();
    const ledger = createFileMuseKeyReadLedger();
    let seen: MuseKeyRead | undefined;
    const request = vi.fn(async () => {
      seen = ledger.recent(contextFor(ACCESS_TOKEN), NOW);
      return jsonResponse(KEY_RESPONSE);
    });
    await diskAdapter({
      fetch: request as unknown as typeof fetch,
    }).fetchQuota(OPTIONS);

    expect(seen).toEqual({ attemptedAt: NOW, outcome: "pending" });
    expect(ledger.recent(contextFor(ACCESS_TOKEN), NOW)).toEqual({
      attemptedAt: NOW,
      outcome: "quota",
    });
  });

  it("does not hold a rotated credential to another credential's interval", async () => {
    useDiskCache();
    const request = sequentialFetch([
      jsonResponse(KEY_RESPONSE),
      jsonResponse(KEY_RESPONSE),
    ]);
    writeCachedProviders([
      await diskAdapter({ fetch: request }).fetchQuota(OPTIONS),
    ]);
    const rotated = await diskAdapter({
      fetch: request,
      sources: [
        authFileSource(authStore(ROTATED_TOKEN)),
        apiKeySource(undefined),
      ],
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(rotated.source).toBe("api");
  });

  it("shares one request between concurrent callers in a process", async () => {
    const request = sequentialFetch([jsonResponse(KEY_RESPONSE)]);
    const adapter = testAdapter({ fetch: request });
    const [left, right] = await Promise.all([
      adapter.fetchQuota(OPTIONS),
      adapter.fetchQuota(OPTIONS),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(left).toBe(right);
  });

  it("serializes same-credential claims so concurrent adapters send one request", async () => {
    useDiskCache();
    const request = vi.fn(async () => jsonResponse(KEY_RESPONSE));
    const left = diskAdapter({ fetch: request as unknown as typeof fetch });
    const right = diskAdapter({ fetch: request as unknown as typeof fetch });

    await Promise.all([left.fetchQuota(OPTIONS), right.fetchQuota(OPTIONS)]);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not send when the pending claim cannot be recorded", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      fetch: request as unknown as typeof fetch,
      ledger: {
        recent: () => undefined,
        record: () => {
          throw new Error("EACCES");
        },
        claim: () => ({ kind: "unwritable" }),
      },
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("muse_read_unrecorded");
    expect(report.state.authStatus).toBeUndefined();
  });

  it("claim is unwritable when the ledger file cannot be written", () => {
    useDiskCache();
    const file = join(directory, "cache", "quota-axi", "muse-key-reads.json");
    mkdirSync(file, { recursive: true });
    const ledger = createFileMuseKeyReadLedger(() => file);

    expect(ledger.claim(contextFor(ACCESS_TOKEN), NOW)).toEqual({
      kind: "unwritable",
    });
  });

  it("lets only one of two sequential claims proceed", () => {
    useDiskCache();
    const ledger = createFileMuseKeyReadLedger();
    const contextId = contextFor(ACCESS_TOKEN);

    expect(ledger.claim(contextId, NOW)).toEqual({ kind: "claimed" });
    expect(ledger.claim(contextId, NOW)).toEqual({
      kind: "recent",
      read: { attemptedAt: NOW, outcome: "pending" },
    });
  });

  it("keeps the ledger private and free of credential material", async () => {
    useDiskCache();
    await diskAdapter().fetchQuota(OPTIONS);
    const file = join(directory, "cache", "quota-axi", "muse-key-reads.json");

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const contents = readFileSync(file, "utf8");
    for (const sentinel of SENTINELS) expect(contents).not.toContain(sentinel);
    expect(Object.keys(JSON.parse(contents).reads)).toEqual([
      contextFor(ACCESS_TOKEN),
    ]);
  });

  it("gates a timestamp ahead of the clock for at most one interval", () => {
    useDiskCache();
    const ledger = createFileMuseKeyReadLedger();
    const contextId = contextFor(ACCESS_TOKEN);
    ledger.record(contextId, { attemptedAt: NOW + 60_000, outcome: "quota" });

    expect(ledger.recent(contextId, NOW)).toBeDefined();
    expect(
      ledger.recent(contextId, NOW - MUSE_KEY_READ_INTERVAL_MS),
    ).toBeUndefined();
  });
});

describe("Muse payload normalization", () => {
  it("names a window of another length without promoting it to five_hour", () => {
    const payload = withUsage({
      window: {
        used_percent: 10,
        window_duration_mins: 240,
        resets_at: 1781964000,
      },
    });
    const normalized = normalizeMusePayload(payload, NOW);

    expect(normalized.windows).toEqual([
      {
        id: "window",
        label: "4h window",
        kind: "unknown",
        windowSeconds: 14_400,
        percentUsed: 10,
        percentRemaining: 90,
        resetsAt: "2026-06-20T14:00:00.000Z",
      },
    ]);
  });

  it("names an entry without a usable percentage as untrusted instead of guessing", () => {
    const normalized = normalizeMusePayload(
      withUsage({
        window: { used_percent: "42" },
        weekly: { used_percent: 5 },
      }),
      NOW,
    );

    expect(normalized.windows.map(({ id }) => id)).toEqual(["weekly"]);
    expect(normalized.untrustedWindowIds).toEqual(["subs_usage:window"]);
  });

  it("publishes no live window once the reported reset has passed", () => {
    const normalized = normalizeMusePayload(
      withUsage({
        window: {
          used_percent: 90,
          window_duration_mins: 300,
          resets_at: NOW / 1000 - 1,
        },
      }),
      NOW,
    );

    expect(normalized.windows).toEqual([]);
    expect(normalized.untrustedWindowIds).toEqual(["five_hour"]);
  });

  it("resolves no reset from milliseconds, null, or a pre-2001 value", () => {
    for (const resets_at of [NOW, null, 0, 999_999_999]) {
      const [window] = normalizeMusePayload(
        withUsage({ weekly: { used_percent: 1, resets_at } }),
        NOW,
      ).windows;
      expect(window.resetsAt).toBeUndefined();
    }
  });

  it("clamps usage past the limit to 100% used", () => {
    const [window] = normalizeMusePayload(
      withUsage({ weekly: { used_percent: 130 } }),
      NOW,
    ).windows;

    expect(window).toMatchObject({ percentUsed: 100, percentRemaining: 0 });
  });

  it("reports no window for an inactive subscription", () => {
    expect(normalizeMusePayload(INACTIVE, NOW)).toEqual({
      windows: [],
      untrustedWindowIds: [],
    });
  });

  it("treats omitted or null subs_usage as absent windows, not untrusted", () => {
    for (const payload of [
      { is_subs_active: true, subs_tier_name: "pro" },
      { is_subs_active: true, subs_tier_name: "pro", subs_usage: null },
    ]) {
      expect(normalizeMusePayload(payload, NOW)).toEqual({
        plan: "pro",
        windows: [],
        untrustedWindowIds: [],
      });
    }
  });

  it("names a present non-object subs_usage as untrusted", () => {
    expect(
      normalizeMusePayload({ is_subs_active: true, subs_usage: [] }, NOW)
        .untrustedWindowIds,
    ).toEqual(["subs_usage"]);
  });

  it("an active mint body without subs_usage is fresh with plan and no untrusted field", async () => {
    const body = {
      api_key: "SENTINEL-MUSE-ISSUED-KEY-must-never-appear",
      base_url: "https://api.meta.ai",
      has_payment_method: true,
      require_payment: false,
      is_subs_active: true,
      can_subscribe: false,
      show_subs_upsell: true,
      user_full_name: "SENTINEL Muse Display Name",
      user_email: "sentinel-muse-user@example.invalid",
      user_avatar_url: null,
      payment_method: "SENTINELPM",
      action_url: null,
      subs_tier_id: "SENTINEL-TIER-ID01",
      subs_tier_name: "pro",
      is_subs_upgrade_available: false,
    };
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(body)]),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.state.authStatus).toBe("usable");
    expect(report.plan).toBe("pro");
    expect(report.windows).toEqual([]);
    expect(report.state.untrustedWindowIds).toBeUndefined();
    const serialized = JSON.stringify(report);
    for (const sentinel of SENTINELS)
      expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("SENTINELPM");
    expect(serialized).not.toContain("SENTINEL-TIER-ID01");
  });

  it("clears this credential's cached windows when the subscription is inactive", async () => {
    useDiskCache();
    let now = NOW;
    const request = sequentialFetch([
      jsonResponse(KEY_RESPONSE),
      jsonResponse(INACTIVE),
    ]);
    writeCachedProviders([
      await diskAdapter({ fetch: request, now: () => now }).fetchQuota(OPTIONS),
    ]);
    now += MUSE_KEY_READ_INTERVAL_MS;
    const inactive = await diskAdapter({
      fetch: request,
      now: () => now,
    }).fetchQuota(OPTIONS);
    writeCachedProviders([inactive]);

    expect(inactive.state.status).toBe("fresh");
    expect(inactive.windows).toEqual([]);
    expect(readCachedMuseProvider(contextFor(ACCESS_TOKEN))).toBeUndefined();
  });

  it("rejects a body that is not a key-endpoint response without an auth verdict", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse({ unrelated: true })]),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("schema_invalid");
    expect(report.state.authStatus).toBeUndefined();
  });
});

describe("Muse quota semantics", () => {
  it("bounds all_models by the lower of the five-hour and weekly windows", async () => {
    const report = withQuotaSemantics(
      await testAdapter().fetchQuota(OPTIONS),
      new Date(NOW).toISOString(),
    );

    expect(report.quotaSemantics?.status).toBe("known");
    expect(report.quotaSemantics?.effectiveAvailability).toEqual([
      expect.objectContaining({
        scope: "all_models",
        effectivePercentRemaining: 57.5,
        boundedBy: ["five_hour", "weekly"],
        limitingWindowIds: ["five_hour"],
      }),
    ]);
  });

  it("does not report a definitive all_models remaining from weekly alone after the five-hour reset has passed", async () => {
    const report = withQuotaSemantics(
      await testAdapter({
        fetch: sequentialFetch([
          jsonResponse(
            withUsage({
              window: {
                used_percent: 90,
                window_duration_mins: 300,
                resets_at: NOW / 1000 - 1,
              },
              weekly: { used_percent: 10, resets_at: NOW / 1000 + 86_400 },
            }),
          ),
        ]),
      }).fetchQuota(OPTIONS),
      new Date(NOW).toISOString(),
    );

    expect(report.windows.map(({ id }) => id)).toEqual(["weekly"]);
    expect(report.state.untrustedWindowIds).toEqual(["five_hour"]);
    expect(report.quotaSemantics?.status).toBe("partial");
    expect(report.quotaSemantics?.unresolvedWindowIds).toEqual(["five_hour"]);
    expect(
      report.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBeUndefined();
    expect(report.quotaSemantics?.effectiveAvailability[0]?.status).toBe(
      "unknown",
    );
  });

  it("does not treat a weekly-only snapshot as a definitive all_models remaining", () => {
    const report = withQuotaSemantics(
      {
        provider: "muse",
        source: "api",
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentUsed: 10,
            percentRemaining: 90,
          },
        ],
        state: { status: "fresh", stale: false },
      },
      new Date(NOW).toISOString(),
    );

    expect(report.quotaSemantics?.status).toBe("partial");
    expect(report.quotaSemantics?.unresolvedWindowIds).toEqual(["five_hour"]);
    expect(
      report.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBeUndefined();
  });

  it("leaves the bound non-definitive while an unrecognized or untrusted window could add one", () => {
    const report = withQuotaSemantics(
      {
        provider: "muse",
        source: "api",
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentUsed: 10,
            percentRemaining: 90,
          },
        ],
        state: {
          status: "fresh",
          stale: false,
          untrustedWindowIds: ["subs_usage:window"],
        },
      },
      new Date(NOW).toISOString(),
    );

    expect(report.quotaSemantics?.status).toBe("partial");
    expect(report.quotaSemantics?.unresolvedWindowIds).toEqual([
      "subs_usage:window",
      "five_hour",
    ]);
    expect(
      report.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBeUndefined();
  });
});

describe("Muse credential and account data never leave the process", () => {
  const originalMuse = PROVIDERS.muse;
  afterEach(() => {
    PROVIDERS.muse = originalMuse;
  });

  it.each([
    ["fresh", () => [jsonResponse(liveKeyResponse())]],
    [
      "server error echoing the body",
      () => [new Response(JSON.stringify(liveKeyResponse()), { status: 500 })],
    ],
    [
      "rejection echoing the body",
      () => [new Response(JSON.stringify(liveKeyResponse()), { status: 401 })],
    ],
  ])(
    "%s: no output mode, cache, or ledger carries a sentinel",
    async (_label, responses) => {
      useDiskCache();
      const outputs: string[] = [];
      for (const argv of [
        ["--provider", "muse"],
        ["--provider", "muse", "--full"],
        ["--provider", "muse", "--json"],
        ["--provider", "muse", "--json", "--full"],
        ["--provider", "muse", "--tui", "--full"],
        ["auth", "--provider", "muse", "--full"],
      ]) {
        // A fresh adapter per run with a ledger that never gates, so every
        // output mode is rendered from a live response rather than a replay.
        PROVIDERS.muse = createMuseAdapter({
          sources: [
            authFileSource(authStore(ACCESS_TOKEN, REFRESH_TOKEN)),
            apiKeySource(API_KEY),
          ],
          fetch: sequentialFetch([
            ...responses(),
            ...responses(),
          ]) as unknown as typeof fetch,
          ledger: openLedger(),
        });
        outputs.push(await capture(argv));
      }
      const cacheDirectory = join(directory, "cache", "quota-axi");
      const persisted = existsSync(cacheDirectory)
        ? readdirSync(cacheDirectory)
            .filter((name) => statSync(join(cacheDirectory, name)).isFile())
            .map((name) => readFileSync(join(cacheDirectory, name), "utf8"))
        : [];

      const everything = [...outputs, ...persisted].join("\n");
      expect(everything).toContain("muse");
      if (_label === "fresh") expect(outputs[0]).toContain("five_hour");
      for (const sentinel of SENTINELS)
        expect(everything).not.toContain(sentinel);
    },
  );

  it("does not reuse a Muse reading through --max-age", async () => {
    useDiskCache();
    const request = sequentialFetch([
      jsonResponse(liveKeyResponse()),
      jsonResponse(liveKeyResponse()),
    ]);
    PROVIDERS.muse = createMuseAdapter({
      sources: [authFileSource(authStore()), apiKeySource(undefined)],
      fetch: request as unknown as typeof fetch,
      ledger: openLedger(),
    });

    const read = async () =>
      JSON.parse(
        await capture(["--provider", "muse", "--json", "--max-age", "1h"]),
      ) as { providers: ProviderQuota[] };
    const first = await read();
    const second = await read();

    expect(first.providers[0]?.state.status).toBe("fresh");
    expect(first.providers[0]?.state.reused).toBeUndefined();
    expect(second.providers[0]?.state.reused).toBeUndefined();
    expect(second.providers[0]?.state.status).toBe("fresh");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never writes the Muse CLI's credential store", async () => {
    const store = join(directory, "config", "muse", "auth.json");
    mkdirSync(join(directory, "config", "muse"), { recursive: true });
    const contents = JSON.stringify(authStore(ACCESS_TOKEN, REFRESH_TOKEN));
    writeFileSync(store, contents, { mode: 0o600 });
    const before = statSync(store);

    await testAdapter({
      sources: [createMuseAuthFileSource(() => store), apiKeySource(undefined)],
    }).fetchQuota(OPTIONS);

    expect(readFileSync(store, "utf8")).toBe(contents);
    expect(statSync(store).mtimeMs).toBe(before.mtimeMs);
  });
});

function testAdapter(
  overrides: Partial<Parameters<typeof createMuseAdapter>[0]> = {},
): ProviderAdapter {
  return createMuseAdapter({
    sources: [authFileSource(authStore()), apiKeySource(undefined)],
    fetch: sequentialFetch([
      jsonResponse(KEY_RESPONSE),
    ]) as unknown as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    ledger: openLedger(),
    now: () => NOW,
    ...overrides,
  });
}

/** The real on-disk cache and ledger, under this test's own cache home. */
function diskAdapter(
  overrides: Partial<Parameters<typeof createMuseAdapter>[0]> = {},
): ProviderAdapter {
  const now = overrides.now ?? (() => NOW);
  return createMuseAdapter({
    sources: [authFileSource(authStore()), apiKeySource(undefined)],
    fetch: sequentialFetch([
      jsonResponse(KEY_RESPONSE),
    ]) as unknown as typeof fetch,
    ledger: createFileMuseKeyReadLedger(undefined, now),
    now,
    ...overrides,
  });
}

function useDiskCache(): void {
  vi.stubEnv("XDG_CACHE_HOME", join(directory, "cache"));
}

/** A ledger that never gates, for tests about a single request's handling. */
function openLedger(): MuseKeyReadLedger {
  return {
    recent: () => undefined,
    record: () => undefined,
    claim: () => ({ kind: "claimed" }),
  };
}

function authStore(
  accessToken = ACCESS_TOKEN,
  refreshToken?: string,
): Record<string, unknown> {
  return {
    providers: {
      meta: {
        access_token: accessToken,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        email: "sentinel-muse-user@example.invalid",
      },
    },
  };
}

function authFileSource(store: unknown) {
  return createMuseAuthFileSource(
    () => "/synthetic/muse/auth.json",
    async () => {
      if (store === undefined)
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return Buffer.from(
        typeof store === "string" ? store : JSON.stringify(store),
      );
    },
  );
}

function apiKeySource(value: string | undefined) {
  return createMuseApiKeySource(
    value === undefined ? {} : { META_API_KEY: value },
  );
}

function contextFor(token: string): string {
  return museCacheContextId(MUSE_AUTH_FILE_SOURCE, token);
}

/** The fixture with its resets moved ahead of the real clock the CLI renders against. */
function liveKeyResponse(): Record<string, unknown> {
  const seconds = Math.floor(Date.now() / 1000);
  const usage = KEY_RESPONSE.subs_usage as Record<
    string,
    Record<string, unknown>
  >;
  return {
    ...KEY_RESPONSE,
    subs_usage: {
      ...usage,
      window: { ...usage.window, resets_at: seconds + 7_200 },
      weekly: { ...usage.weekly, resets_at: seconds + 259_200 },
    },
  };
}

function withUsage(usage: Record<string, unknown>): Record<string, unknown> {
  return { is_subs_active: true, subs_usage: usage };
}

function bearers(request: ReturnType<typeof sequentialFetch>): string[] {
  return request.mock.calls.map(
    ([, init]) => new Headers(init?.headers).get("authorization") ?? "",
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
    provider: "muse",
    label: "Muse",
    source: "api",
    plan: "pro",
    windows: EXPECTED_WINDOWS.map((window) => ({
      ...window,
    })) as ProviderQuota["windows"],
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: new Date(NOW - 60_000).toISOString(),
      sourcesTried: [MUSE_AUTH_FILE_SOURCE],
    },
  };
}

async function capture(argv: string[]): Promise<string> {
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
