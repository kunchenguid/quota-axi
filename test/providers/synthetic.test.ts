import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createSyntheticAdapter,
  extractSyntheticCredential,
  normalizeSyntheticPayload,
  resolveSyntheticCredentials,
  SYNTHETIC_QUOTAS_URL,
} from "../../src/providers/synthetic.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-fixture-api-key";
const NOW = Date.parse("2026-10-21T08:00:00.000Z");

/**
 * The captured live payload (2026-10-21, no key, no account identity). Every
 * case here derives from this shape; no test contacts the vendor.
 */
const PAYLOAD = JSON.parse(
  readFileSync("test/fixtures/synthetic/quotas.json", "utf8"),
) as Record<string, unknown>;

function payloadWith(mutate: (copy: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(PAYLOAD);
  mutate(copy);
  return copy;
}

function adapterAnswering(
  payload: unknown,
  overrides: Parameters<typeof createSyntheticAdapter>[0] = {},
) {
  return createSyntheticAdapter({
    credential: () => ({
      status: "available",
      key: KEY,
      source: "env:SYNTHETIC_API_KEY",
    }),
    fetch: async () =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      }),
    now: () => NOW,
    ...overrides,
  });
}

async function interpreted(payload: unknown) {
  const report = await adapterAnswering(payload).fetchQuota(OPTIONS);
  return withQuotaSemantics(report, new Date(NOW).toISOString());
}

describe("Synthetic provider", () => {
  it("reports the account-wide weekly credit percentage from the first-party API", async () => {
    const request = vi.fn(async () => {
      return new Response(JSON.stringify(PAYLOAD), {
        headers: { "content-type": "application/json" },
      });
    });

    const report = await createSyntheticAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:SYNTHETIC_API_KEY",
      }),
      fetch: request,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "synthetic",
      label: "Synthetic",
      source: "api",
      state: { status: "fresh", stale: false },
      attempts: [{ source: "env:SYNTHETIC_API_KEY", status: "success" }],
    });
    expect(report.state.untrustedWindowIds).toBeUndefined();

    const weekly = report.windows.find(({ id }) => id === "weekly");
    expect(weekly).toMatchObject({
      id: "weekly",
      label: "week",
      kind: "weekly",
      // The vendor's own fractional percentage, preserved rather than rounded.
      percentRemaining: 98.02535828571428,
      limitUsd: 10.5,
      resetText: "next regen 2026-10-21T08:56:36.000Z",
    });
    expect(weekly?.percentUsed).toBeCloseTo(1.97464171428572, 10);
    // `nextRegenAt` is the next top-up, never a window turnover.
    expect(weekly?.resetsAt).toBeUndefined();
    expect(weekly?.windowSeconds).toBeUndefined();

    // The vendor's own remaining credit string, never a derived percentage.
    expect(report.credits).toEqual({ remaining: 10.29, unit: "usd" });

    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe(SYNTHETIC_QUOTAS_URL);
    const init = request.mock.calls[0][1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("keeps the request-count meters as their own named scopes, never as model bounds", async () => {
    const report = await interpreted(PAYLOAD);

    expect(report.windows.map(({ id }) => id).sort()).toEqual([
      "search_hourly",
      "subscription",
      "weekly",
    ]);
    expect(
      report.windows.find(({ id }) => id === "subscription"),
    ).toMatchObject({
      label: "requests",
      kind: "unknown",
      percentUsed: 0,
      percentRemaining: 100,
      resetsAt: "2026-10-21T13:01:31.726Z",
    });
    expect(
      report.windows.find(({ id }) => id === "search_hourly"),
    ).toMatchObject({
      label: "search",
      percentUsed: (1 / 250) * 100,
      windowSeconds: 3_600,
      resetsAt: "2026-10-21T09:00:23.727Z",
    });

    const account = report.quotaSemantics?.effectiveAvailability.find(
      ({ scope }) => scope === "all_models",
    );
    expect(account).toMatchObject({
      scope: "all_models",
      status: "known",
      effectivePercentRemaining: 98.02535828571428,
      boundedBy: ["weekly"],
    });
    // No reset means no cycle, so the aggregate stays honestly unknown.
    expect(account?.runway?.status).toBe("unknown");
    expect(
      report.quotaSemantics?.effectiveAvailability.map(({ scope }) => scope),
    ).toEqual(["all_models", "requests", "search"]);
  });

  it("reads a zero freeToolCalls limit as no allowance of that kind", async () => {
    const report = await interpreted(
      payloadWith((copy) => {
        delete copy.freeToolCalls;
      }),
    );
    expect(report.windows.map(({ id }) => id)).not.toContain("free_tool_calls");

    const withZero = await interpreted(PAYLOAD);
    expect(withZero.windows.map(({ id }) => id)).not.toContain(
      "free_tool_calls",
    );
    expect(withZero.state.untrustedWindowIds).toBeUndefined();
    expect(withZero.state.status).toBe("fresh");
    expect(
      withZero.quotaSemantics?.effectiveAvailability.find(
        ({ scope }) => scope === "all_models",
      )?.effectivePercentRemaining,
    ).toBe(98.02535828571428);
  });

  it("publishes a positive freeToolCalls limit as its own tools scope", async () => {
    const report = await interpreted(
      payloadWith((copy) => {
        copy.freeToolCalls = {
          limit: 40,
          requests: 10,
          renewsAt: "2026-10-22T08:01:31.729Z",
        };
      }),
    );
    expect(
      report.windows.find(({ id }) => id === "free_tool_calls"),
    ).toMatchObject({ label: "tool calls", percentRemaining: 75 });
    expect(
      report.quotaSemantics?.effectiveAvailability.find(
        ({ scope }) => scope === "tools",
      ),
    ).toMatchObject({ scope: "tools", effectivePercentRemaining: 75 });
  });

  it("names a payload missing weeklyTokenLimit instead of inventing headroom", async () => {
    const report = await interpreted(
      payloadWith((copy) => {
        delete copy.weeklyTokenLimit;
      }),
    );

    expect(report.state.status).toBe("fresh");
    expect(report.windows.map(({ id }) => id)).not.toContain("weekly");
    expect(report.state.untrustedWindowIds).toEqual(["weekly"]);
    expect(report.quotaSemantics?.status).toBe("partial");
    expect(
      report.quotaSemantics?.effectiveAvailability.map(({ scope }) => scope),
    ).toEqual(["requests", "search"]);
    expect(report.credits).toBeUndefined();
  });

  it("names an unreadable weekly percentage rather than deriving one from credits", () => {
    const normalized = normalizeSyntheticPayload(
      payloadWith((copy) => {
        copy.weeklyTokenLimit = {
          nextRegenAt: "2026-10-21T08:56:36.000Z",
          maxCredits: "$10.50",
          remainingCredits: "$10.29",
          nextRegenCredits: "$0.21",
        };
      }),
    );
    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "subscription",
      "search_hourly",
    ]);
    expect(normalized.untrustedWindowIds).toEqual(["weekly"]);
    // No percentage is inferred from `remainingCredits / maxCredits`.
    expect(normalized.credits).toEqual({ remaining: 10.29, unit: "usd" });
  });

  it("tries Pi auth after an environment key is rejected", async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === "Bearer stale-env-key")
        return new Response(null, { status: 403 });
      return new Response(JSON.stringify(PAYLOAD), {
        headers: { "content-type": "application/json" },
      });
    });

    const report = await createSyntheticAdapter({
      credential: () => [
        {
          status: "available",
          key: "stale-env-key",
          source: "env:SYNTHETIC_API_KEY",
        },
        { status: "available", key: KEY, source: "pi:synthetic" },
      ],
      fetch: request,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: {
        status: "fresh",
        sourcesTried: ["env:SYNTHETIC_API_KEY", "pi:synthetic"],
      },
      attempts: [
        {
          source: "env:SYNTHETIC_API_KEY",
          status: "failed",
          error: "provider_auth_rejected",
        },
        { source: "pi:synthetic", status: "success" },
      ],
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports absent and unusable local credentials as auth_required", async () => {
    const request = vi.fn();
    const missing = await createSyntheticAdapter({
      credential: () => ({ status: "missing", source: "pi:synthetic" }),
      fetch: request,
    }).fetchQuota(OPTIONS);
    const invalid = await createSyntheticAdapter({
      credential: () => ({ status: "invalid", source: "pi:synthetic" }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(missing).toMatchObject({
      provider: "synthetic",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "synthetic_credential_unavailable",
      },
    });
    expect(invalid).toMatchObject({
      provider: "synthetic",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "synthetic_credential_invalid",
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("enumerates the environment source even when unset", () => {
    expect(resolveSyntheticCredentials({}, "/missing/auth.json")).toEqual([
      { status: "missing", source: "env:SYNTHETIC_API_KEY" },
      {
        status: "missing",
        source: "pi:synthetic",
        path: "/missing/auth.json",
      },
    ]);
  });

  it("extracts a Pi auth.json synthetic api_key entry", () => {
    expect(
      extractSyntheticCredential(
        { synthetic: { type: "api_key", key: KEY } },
        "/auth.json",
      ),
    ).toEqual({
      status: "available",
      key: KEY,
      source: "pi:synthetic",
      path: "/auth.json",
    });
    expect(
      extractSyntheticCredential(
        { synthetic: { key: "${SYNTHETIC_API_KEY}" } },
        "/auth.json",
      ),
    ).toEqual({
      status: "invalid",
      source: "pi:synthetic",
      path: "/auth.json",
    });
  });

  it("reports a provider rejection as auth_required", async () => {
    const report = await createSyntheticAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:SYNTHETIC_API_KEY",
      }),
      fetch: async () => new Response(null, { status: 401 }),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "auth_required", error: "provider_auth_rejected" },
    });
  });

  it("reports 429 as rate_limited with the Retry-After hint", async () => {
    const report = await createSyntheticAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:SYNTHETIC_API_KEY",
      }),
      fetch: async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "rate_limited", error: "provider_rate_limited" },
    });
    expect(report.state.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects a malformed payload instead of publishing invented windows", async () => {
    const notAnObject = await adapterAnswering([]).fetchQuota(OPTIONS);
    expect(notAnObject).toMatchObject({
      source: "unavailable",
      state: { status: "error", error: "invalid_payload" },
    });

    const noQuotaFields = await adapterAnswering({
      plan: "standard",
    }).fetchQuota(OPTIONS);
    expect(noQuotaFields).toMatchObject({
      source: "unavailable",
      state: { status: "error", error: "missing_quota_fields" },
    });

    const invalidJson = await createSyntheticAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:SYNTHETIC_API_KEY",
      }),
      fetch: async () =>
        new Response("{not json", {
          headers: { "content-type": "application/json" },
        }),
    }).fetchQuota(OPTIONS);
    expect(invalidJson).toMatchObject({
      source: "unavailable",
      state: { status: "error", error: "invalid_json" },
    });
  });

  it("names unrecognized object-valued fields instead of folding them into the bound", async () => {
    const normalized = normalizeSyntheticPayload(
      payloadWith((copy) => {
        copy.rollingFiveHourLimit = {
          nextTickAt: "2026-10-21T08:15:00.000Z",
          tickPercent: 0.05,
          remaining: 600,
          max: 600,
          limited: false,
        };
      }),
    );
    expect(normalized.untrustedWindowIds).toEqual(["rollingFiveHourLimit"]);
    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "weekly",
      "subscription",
      "search_hourly",
    ]);
  });

  it("never reads the environment or Pi store by default in fixtures", () => {
    // Every case above injects its credential, so no test can reach a real
    // store or the vendor. This guards the wiring, not a live read.
    const adapter = createSyntheticAdapter({
      credential: () => ({ status: "missing", source: "pi:synthetic" }),
      fetch: async () => {
        throw new Error("no request expected");
      },
    });
    expect(adapter.id).toBe("synthetic");
    expect(adapter.label).toBe("Synthetic");
  });
});
