import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterAdapter,
  extractOpenRouterCredential,
  normalizeOpenRouterPayload,
  resolveOpenRouterCredential,
} from "../../src/providers/openrouter.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-openrouter-key";

describe("OpenRouter provider", () => {
  it("reports the key spend cap and remaining balance", async () => {
    const request = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            label: "personal",
            limit: 100,
            limit_remaining: 73.25,
            limit_reset: "Daily",
            usage: 26.75,
            usage_daily: 5,
            usage_weekly: 15,
            usage_monthly: 26.75,
            is_free_tier: false,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "openrouter",
      source: "api",
      state: { status: "fresh", stale: false },
      credits: { remaining: 73.25, unit: "usd" },
      account: { accountId: "personal" },
      attempts: [{ source: "env:OPENROUTER_API_KEY", status: "success" }],
    });
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "key-limit",
        kind: "credits",
        spentUsd: 26.75,
        limitUsd: 100,
        percentRemaining: 73.25,
        resetText: "Daily",
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(request).toHaveBeenCalledOnce();
    const init = request.mock.calls[0][1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("treats a null cap as unlimited and omits the window", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              limit: null,
              limit_remaining: null,
              usage: 10,
              usage_daily: 10,
              usage_weekly: 10,
              usage_monthly: 10,
              is_free_tier: true,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      windows: [],
      credits: { unlimited: true, unit: "usd" },
    });
  });

  it("rejects an invalid payload", () => {
    expect(() => normalizeOpenRouterPayload({ error: "test" })).toThrow(
      "missing_data",
    );
  });

  it("reports missing credentials as auth_required", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => resolveOpenRouterCredential({}),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      provider: "openrouter",
      source: "api",
      state: {
        status: "auth_required",
        error: "openrouter_credential_unavailable",
      },
    });
  });

  it("extracts a Pi auth.json openrouter entry", () => {
    expect(
      extractOpenRouterCredential(
        { openrouter: { apiKey: KEY } },
        "/auth.json",
      ),
    ).toEqual({
      status: "available",
      key: KEY,
      source: "pi:openrouter",
      path: "/auth.json",
    });
  });

  it("rejects template values as missing", () => {
    expect(
      extractOpenRouterCredential(
        { openrouter: { apiKey: "${OPENROUTER_API_KEY}" } },
        "/auth.json",
      ),
    ).toEqual({
      status: "invalid",
      source: "pi:openrouter",
      path: "/auth.json",
    });
  });

  it("reports 429 as rate_limited", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
        }),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      state: { status: "rate_limited", error: "provider_rate_limited" },
    });
  });
});
