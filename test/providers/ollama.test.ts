import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { PROVIDER_RESPONSE_LIMIT_BYTES } from "../../src/lib/http.js";
import {
  createOllamaAdapter,
  normalizeOllamaPayload,
  OLLAMA_BALANCE_URL,
  resolveOllamaCredential,
} from "../../src/providers/ollama.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const NOW = Date.parse("2026-10-09T12:00:00Z");
const KEY = "synthetic-ollama-key";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/ollama/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const modern = () => fixture("modern");
const legacy = () => fixture("legacy");
const credential = () => resolveOllamaCredential({ OLLAMA_API_KEY: KEY });
const response = (payload: unknown) => new Response(JSON.stringify(payload));
const adapter = (fetch: typeof globalThis.fetch, deadlineMs = 1000) =>
  createOllamaAdapter({ credential, fetch, now: () => NOW, deadlineMs });
const interpreted = async (
  payload: unknown,
  generatedAt = new Date(NOW).toISOString(),
) =>
  withQuotaSemantics(
    await adapter(vi.fn(async () => response(payload))).fetchQuota(OPTIONS),
    generatedAt,
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Ollama balance (synthetic, no CLI, refresh, or sibling credential surface)", () => {
  it("makes exactly one fixed-origin GET with an offered bearer, no cookies, body, query, redirects, or network auth inspection", async () => {
    const fetch = vi.fn(async () => response(modern()));
    const provider = adapter(fetch);
    expect(await provider.inspectAuth(OPTIONS)).toEqual({
      provider: "ollama",
      sources: [
        { source: "env:OLLAMA_API_KEY", path: undefined, status: "available" },
      ],
    });
    expect(fetch).not.toHaveBeenCalled();
    const report = await provider.fetchQuota({
      ...OPTIONS,
      refreshCredentials: true,
      allowKeychainPrompt: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([
      OLLAMA_BALANCE_URL,
      {
        method: "GET",
        headers: { Authorization: "Bearer " + KEY, Accept: "application/json" },
        credentials: "omit",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(report.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(report.account).toBeUndefined();
    expect(report.plan).toBeUndefined();
  });

  it("reports modern monthly included credits and purchased USD separately", async () => {
    const report = await interpreted(modern());
    expect(report.windows).toMatchObject([
      {
        id: "included_month",
        kind: "monthly",
        limitUsd: 100,
        spentUsd: 27.5,
        percentRemaining: 72.5,
        percentUsed: 27.5,
        startsAt: "2026-10-01T00:00:00.000Z",
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
    expect(report.credits).toEqual({ remaining: 12.5, unit: "usd" });
    expect(report.quotaSemantics).toMatchObject({
      status: "known",
      effectiveAvailability: [
        {
          scope: "included_credits",
          effectivePercentRemaining: 72.5,
          boundedBy: ["included_month"],
        },
      ],
    });
    expect(
      report.quotaSemantics?.effectiveAvailability.some(
        ({ scope }) => scope === "all_models",
      ),
    ).toBe(false);
  });

  it("trusts monthly period boundaries even on an annual subscription fixture", async () => {
    const report = await interpreted(fixture("annual-subscription-month"));
    expect(report.windows[0]).toMatchObject({
      startsAt: "2026-09-23T12:34:56.000Z",
      resetsAt: "2026-10-23T12:34:56.000Z",
      percentRemaining: 75,
    });
    expect(report.windows[0].windowSeconds).toBeUndefined();
  });

  it("preserves purchased USD when modern period expires during normalization", async () => {
    const payload = modern();
    payload.included.period.until = "2026-10-09T11:59:59Z";
    const report = await interpreted(payload);
    expect(report.windows).toEqual([]);
    expect(report.credits).toEqual({ remaining: 12.5, unit: "usd" });
    expect(report.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
      untrustedWindowIds: ["included_month"],
    });
    expect(report.quotaSemantics).toMatchObject({
      status: "partial",
      effectiveAvailability: [],
      unresolvedWindowIds: ["included_month"],
    });
  });

  it.each([
    ["modern", modern(), "2026-11-01T00:00:00.001Z", ["included_month"], 12.5],
    ["legacy", legacy(), "2026-10-12T00:00:00.001Z", ["session", "weekly"], 0],
  ] as const)(
    "keeps %s expired windows unresolved after delayed finalization",
    async (_family, payload, generatedAt, unresolvedWindowIds, purchased) => {
      const report = await interpreted(payload, generatedAt);
      expect(report.windows).toEqual([]);
      expect(report.state.untrustedWindowIds).toEqual(unresolvedWindowIds);
      expect(report.credits).toEqual({ remaining: purchased, unit: "usd" });
      expect(report.quotaSemantics).toMatchObject({
        status: "partial",
        effectiveAvailability: [],
        unresolvedWindowIds,
      });
    },
  );

  it.each([0, 25])(
    "included exhaustion is not full-service exhaustion with purchased USD %s",
    async (purchased) => {
      const payload = modern();
      payload.included.balance_usd = 0;
      payload.purchased.balance_usd = purchased;
      const report = await interpreted(payload);
      expect(report.quotaSemantics?.effectiveAvailability).toMatchObject([
        {
          scope: "included_credits",
          effectivePercentRemaining: 0,
          runway: { status: "exhausted_now" },
        },
      ]);
      expect(report.credits).toEqual({ remaining: purchased, unit: "usd" });
      expect(report.windows).toHaveLength(1);
      expect(report.credits?.unlimited).toBeUndefined();
    },
  );

  it("zero allowance keeps raw values but no percentage or selection", async () => {
    const payload = modern();
    payload.included.balance_usd = 0;
    payload.included.allowance_usd = 0;
    const report = await interpreted(payload);
    expect(report.windows[0]).toMatchObject({ spentUsd: 0, limitUsd: 0 });
    expect(report.windows[0].percentRemaining).toBeUndefined();
    expect(report.quotaSemantics).toMatchObject({
      status: "partial",
      effectiveAvailability: [
        {
          scope: "included_credits",
          status: "unknown",
          selection: { status: "unknown" },
        },
      ],
    });
    expect(
      report.quotaSemantics?.effectiveAvailability[0]?.runway
        ?.unmeasurableWindowIds,
    ).toEqual(["included_month"]);
    expect(
      report.quotaSemantics?.effectiveAvailability[0]?.selection
        ?.unmeasurableWindowIds,
    ).toEqual(["included_month"]);
  });

  it("keeps legacy remaining polarity and independent resets without inventing duration or conjunction", async () => {
    const report = await interpreted(legacy());
    expect(report.windows).toMatchObject([
      {
        id: "session",
        kind: "session",
        percentRemaining: 75,
        percentUsed: 25,
        resetsAt: "2026-10-09T20:00:00.000Z",
        pace: { status: "unknown" },
      },
      {
        id: "weekly",
        kind: "weekly",
        percentRemaining: 60,
        percentUsed: 40,
        resetsAt: "2026-10-12T00:00:00.000Z",
        pace: { status: "unknown" },
      },
    ]);
    for (const window of report.windows) {
      expect(window.startsAt).toBeUndefined();
      expect(window.windowSeconds).toBeUndefined();
    }
    expect(report.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: ["session", "weekly"],
    });
  });

  it.each(["missing", "passed"])(
    "an %s legacy partner stays unresolved",
    async (mode) => {
      const payload = legacy();
      if (mode === "missing") delete payload.included.session;
      else payload.included.session.resets_at = new Date(NOW).toISOString();
      const report = await interpreted(payload);
      expect(report.windows.map(({ id }) => id)).toEqual(["weekly"]);
      expect(report.state.untrustedWindowIds).toEqual(["session"]);
      expect(report.quotaSemantics).toMatchObject({
        status: "partial",
        effectiveAvailability: [],
        unresolvedWindowIds: ["weekly", "session"],
      });
    },
  );

  const invalidPayloads = [
    null,
    [],
    {},
    { included: null, purchased: {} },
    ...["balance_usd", "allowance_usd"].flatMap((key) =>
      [undefined, null, "5", -1, Infinity, NaN].map((value) => {
        const p = modern();
        p.included[key] = value;
        return p;
      }),
    ),
    ...[undefined, null, "5", -1, Infinity].map((value) => {
      const p = modern();
      p.purchased.balance_usd = value;
      return p;
    }),
    ...[101, -1, "75", null].map((value) => {
      const p = legacy();
      p.included.session.remaining_percent = value;
      return p;
    }),
    ...["unknown", "session", "team_budget"].map((key) => {
      const p = modern();
      p.included[key] = {};
      return p;
    }),
    ...["2026-12-01T00:00:00Z", "not-a-date"].map((value) => {
      const p = modern();
      p.included.period.from = value;
      return p;
    }),
    { included: {}, purchased: { balance_usd: 0 } },
    { included: { session: {} }, purchased: { balance_usd: 0 } },
    { ...modern(), included: { ...modern().included, balance_usd: 101 } },
  ];
  it.each(invalidPayloads.map((payload, index) => [index, payload] as const))(
    "fails closed on invalid or unknown schema #%s",
    (_index, payload) => {
      expect(() => normalizeOllamaPayload(payload, NOW)).toThrow(
        "ollama_invalid_schema",
      );
    },
  );

  it.each([undefined, "", "   "])(
    "missing/blank offered env (%s) never sends HTTP",
    async (key) => {
      const fetch = vi.fn();
      const provider = createOllamaAdapter({
        credential: () => resolveOllamaCredential({ OLLAMA_API_KEY: key }),
        fetch,
      });
      expect(await provider.fetchQuota(OPTIONS)).toMatchObject({
        state: { status: "auth_required" },
        attempts: [{ status: "skipped" }],
      });
      expect(await provider.inspectAuth(OPTIONS)).toMatchObject({
        sources: [{ status: "missing" }],
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    "!run-command",
    "$REFERENCE",
    "${template}",
    "bad\nkey",
    "bad\u007fkey",
  ])("present-invalid literal %s never resolves or sends", async (key) => {
    const fetch = vi.fn();
    const provider = createOllamaAdapter({
      credential: () => resolveOllamaCredential({ OLLAMA_API_KEY: key }),
      fetch,
    });
    const report = await provider.fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      state: { error: "ollama_credential_invalid" },
      attempts: [{ status: "failed", credentialPresent: true }],
    });
    expect(await provider.inspectAuth(OPTIONS)).toMatchObject({
      sources: [{ status: "invalid" }],
    });
    expect(JSON.stringify(report)).not.toContain(key);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_required", "provider_auth_rejected"],
    [403, "error", "ollama_account_suspended"],
    [429, "rate_limited", "provider_rate_limited"],
    [503, "error", "ollama_balance_unavailable"],
    [500, "error", "provider_http_error"],
    [302, "error", "provider_redirect_refused"],
  ])(
    "distinguishes HTTP %s and discards secret-bearing error bodies",
    async (status, state, error) => {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start: (controller) =>
          controller.enqueue(new TextEncoder().encode(KEY)),
        cancel,
      });
      const fetch = vi.fn(
        async () =>
          new Response(body, {
            status: status as number,
            headers: {
              "retry-after": "60",
              location: "https://other.invalid/",
            },
          }),
      );
      const report = await adapter(fetch).fetchQuota(OPTIONS);
      expect(report.state).toMatchObject({ status: state, error });
      expect(report.state.authStatus).toBe(
        status === 401 ? "unusable" : undefined,
      );
      expect(report.state.remedyCommand).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain(KEY);
      if (status === 429)
        expect(report.state.retryAfter).toBe("2026-10-09T12:01:00.000Z");
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each(["garbage", "-1", "0.5", "Wed, 21 Oct 2026 00:00:00 GMT"])(
    "ignores non-integer Retry-After %s",
    async (retry) => {
      const report = await adapter(
        vi.fn(
          async () =>
            new Response(KEY, {
              status: 429,
              headers: { "retry-after": retry },
            }),
        ),
      ).fetchQuota(OPTIONS);
      expect(report.state.retryAfter).toBeUndefined();
    },
  );
  it("discards unexpected exception text", async () => {
    const report = await adapter(
      vi.fn(async () => {
        throw new Error(KEY);
      }),
    ).fetchQuota(OPTIONS);
    expect(report.state.error).toBe("network_unavailable");
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("bounds hanging headers even when fetch ignores abort, and cancels a late body", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const reading = adapter(request, 50).fetchQuota(OPTIONS);
    await vi.advanceTimersByTimeAsync(51);
    expect((await reading).state.error).toBe("provider_timeout");
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("bounds a hanging streamed body and releases/cancels it", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const reading = adapter(
      vi.fn(async () => new Response(body)),
      50,
    ).fetchQuota(OPTIONS);
    await vi.advanceTimersByTimeAsync(51);
    expect((await reading).state.error).toBe("provider_timeout");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it.each([undefined, "1", String(PROVIDER_RESPONSE_LIMIT_BYTES + 1)])(
    "bounds declared/actual body size (%s)",
    async (length) => {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start: (controller) =>
          controller.enqueue(new Uint8Array(PROVIDER_RESPONSE_LIMIT_BYTES + 1)),
        cancel,
      });
      const report = await adapter(
        vi.fn(
          async () =>
            new Response(body, {
              headers: length ? { "content-length": length } : {},
            }),
        ),
      ).fetchQuota(OPTIONS);
      expect(report.state.error).toBe("response_too_large");
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    },
  );
  it.each([
    new Uint8Array([0xff]),
    new TextEncoder().encode(`{"secret":"${KEY}"`),
    new TextEncoder().encode(`{"secret":"${KEY}"}`),
  ])(
    "rejects malformed UTF-8/JSON/schema without echoing a secret",
    async (bytes) => {
      const report = await adapter(
        vi.fn(async () => new Response(bytes)),
      ).fetchQuota(OPTIONS);
      expect(["invalid_json", "ollama_invalid_schema"]).toContain(
        report.state.error,
      );
      expect(JSON.stringify(report)).not.toContain(KEY);
    },
  );
  it("coalesces simultaneous same-key reads only, not later reads or another key", async () => {
    let key = KEY;
    let finish!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const provider = createOllamaAdapter({
      credential: () => resolveOllamaCredential({ OLLAMA_API_KEY: key }),
      fetch,
      now: () => NOW,
    });
    const first = provider.fetchQuota(OPTIONS);
    const second = provider.fetchQuota(OPTIONS);
    expect(fetch).toHaveBeenCalledOnce();
    finish(response(modern()));
    expect(await first).toEqual(await second);
    const third = provider.fetchQuota(OPTIONS);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish(response(modern()));
    await third;
    const fourth = provider.fetchQuota(OPTIONS);
    const completeFourth = finish;
    key = "synthetic-other-key";
    const fifth = provider.fetchQuota(OPTIONS);
    expect(fetch).toHaveBeenCalledTimes(4);
    completeFourth(response(modern()));
    finish(response(modern()));
    await Promise.all([fourth, fifth]);
  });
});
