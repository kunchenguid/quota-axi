import { describe, expect, it, vi } from "vitest";
import {
  createDeepSeekAdapter,
  extractDeepSeekCredential,
  normalizeDeepSeekPayload,
  resolveDeepSeekCredentials,
} from "../../src/providers/deepseek.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-deepseek-key";

async function rawBalanceReport(payload: unknown) {
  return createDeepSeekAdapter({
    credential: () => ({
      status: "available" as const,
      key: KEY,
      source: "env:DEEPSEEK_API_KEY" as const,
    }),
    fetch: async () =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      }),
  }).fetchQuota(OPTIONS);
}

async function balanceReport(
  balance_infos: { currency: string; total_balance: unknown }[],
  is_available = true,
) {
  return rawBalanceReport({ is_available, balance_infos });
}

describe("DeepSeek provider", () => {
  it("reads USD and CNY balances from the first-party API", async () => {
    const request = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "USD",
              total_balance: "12.50",
              granted_balance: "10.00",
              topped_up_balance: "2.50",
            },
            {
              currency: "CNY",
              total_balance: "100.00",
              granted_balance: "80.00",
              topped_up_balance: "20.00",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const report = await createDeepSeekAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:DEEPSEEK_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "deepseek",
      source: "api",
      state: { status: "fresh", stale: false },
      credits: { remaining: 12.5, unit: "usd" },
      creditBalances: [
        { remaining: 12.5, unit: "usd" },
        { remaining: 100, unit: "cny" },
      ],
      attempts: [{ source: "env:DEEPSEEK_API_KEY", status: "success" }],
    });
    expect(report.windows).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(request).toHaveBeenCalledOnce();
    const init = request.mock.calls[0][1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("preserves every wallet when USD is empty and CNY is funded", async () => {
    const request = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "USD", total_balance: "0.00" },
            { currency: "CNY", total_balance: "10.00" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const report = await createDeepSeekAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:DEEPSEEK_API_KEY",
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "fresh", stale: false },
      credits: { remaining: 10, unit: "cny" },
      creditBalances: [
        { remaining: 0, unit: "usd" },
        { remaining: 10, unit: "cny" },
      ],
    });
  });

  it("preserves both empty wallets without declaring a singular balance", async () => {
    const report = await balanceReport([
      { currency: "USD", total_balance: "0.00" },
      { currency: "CNY", total_balance: "0.00" },
    ]);

    expect(report).toMatchObject({
      credits: { remaining: 0, unit: "usd" },
      creditBalances: [
        { remaining: 0, unit: "usd" },
        { remaining: 0, unit: "cny" },
      ],
    });
  });

  it("keeps a USD-only wallet in the legacy credits field", async () => {
    const report = await balanceReport([
      { currency: "USD", total_balance: "7.50" },
    ]);

    expect(report).toMatchObject({
      credits: { remaining: 7.5, unit: "usd" },
    });
    expect(report.creditBalances).toBeUndefined();
  });

  it("preserves the CNY unit for a CNY-only wallet", async () => {
    const report = await balanceReport([
      { currency: "CNY", total_balance: "10.00" },
    ]);

    expect(report).toMatchObject({
      credits: { remaining: 10, unit: "cny" },
    });
    expect(report.creditBalances).toBeUndefined();
  });

  it("tries Pi auth after an environment key is rejected", async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === "Bearer stale-env-key")
        return new Response(null, { status: 403 });
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: "7.50" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const report = await createDeepSeekAdapter({
      credential: () => [
        {
          status: "available",
          key: "stale-env-key",
          source: "env:DEEPSEEK_API_KEY",
        },
        { status: "available", key: KEY, source: "pi:deepseek" },
      ],
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: {
        status: "fresh",
        sourcesTried: ["env:DEEPSEEK_API_KEY", "pi:deepseek"],
      },
      attempts: [
        {
          source: "env:DEEPSEEK_API_KEY",
          status: "failed",
          error: "provider_auth_rejected",
        },
        { source: "pi:deepseek", status: "success" },
      ],
      credits: { remaining: 7.5, unit: "usd" },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid balance amount", () => {
    expect(() =>
      normalizeDeepSeekPayload({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "abc",
            granted_balance: "0",
            topped_up_balance: "0",
          },
        ],
      }),
    ).toThrow("invalid_amount");
  });

  it("rejects numeric wallet amounts", async () => {
    await expect(
      balanceReport([
        { currency: "USD", total_balance: 0 },
        { currency: "CNY", total_balance: 10 },
      ]),
    ).resolves.toMatchObject({
      state: { status: "error", error: "invalid_amount:Total balance" },
    });
  });

  it("rejects unknown currencies and malformed wallet rows", async () => {
    await expect(
      balanceReport([{ currency: "XYZ", total_balance: "10.00" }]),
    ).resolves.toMatchObject({
      state: { status: "error", error: "unsupported_currency" },
    });
    await expect(
      rawBalanceReport({ is_available: true, balance_infos: [null] }),
    ).resolves.toMatchObject({
      state: { status: "error", error: "invalid_balance_row" },
    });
  });

  it("keeps an unavailable account with no wallets absent", async () => {
    const report = await balanceReport([], false);
    expect(report).toMatchObject({
      state: { status: "fresh" },
      windows: [],
    });
    expect(report.credits).toBeUndefined();
    expect(report.creditBalances).toBeUndefined();
  });

  it("rejects wallet values that lose decimal precision", async () => {
    for (const total_balance of [
      "9007199254740993",
      "1000000000000000100",
    ]) {
      await expect(
        balanceReport([{ currency: "USD", total_balance }]),
      ).resolves.toMatchObject({
        state: { status: "error", error: "invalid_amount:Total balance" },
      });
    }
  });

  it("preserves exactly representable decimal wallet values", async () => {
    const report = await balanceReport([
      { currency: "USD", total_balance: "0.125" },
      { currency: "CNY", total_balance: "10.005" },
    ]);
    expect(report.creditBalances).toEqual([
      { remaining: 0.125, unit: "usd" },
      { remaining: 10.005, unit: "cny" },
    ]);
  });

  it("reports a negative balance as negative remaining credits", async () => {
    const request = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          is_available: false,
          balance_infos: [
            {
              currency: "USD",
              total_balance: "-4.25",
              granted_balance: "0",
              topped_up_balance: "0",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const report = await createDeepSeekAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:DEEPSEEK_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "fresh" },
      credits: { remaining: -4.25, unit: "usd" },
    });
  });

  it("reports unusable local credentials as auth_required", async () => {
    const request = vi.fn();
    const missing = await createDeepSeekAdapter({
      credential: () => ({ status: "missing", source: "pi:deepseek" }),
      fetch: request,
    }).fetchQuota(OPTIONS);
    const invalid = await createDeepSeekAdapter({
      credential: () => ({ status: "invalid", source: "pi:deepseek" }),
      fetch: request,
    }).fetchQuota(OPTIONS);
    expect(missing).toMatchObject({
      provider: "deepseek",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "deepseek_credential_unavailable",
      },
    });
    expect(invalid).toMatchObject({
      provider: "deepseek",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "deepseek_credential_invalid",
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("enumerates the environment source even when unset", () => {
    expect(resolveDeepSeekCredentials({}, "/missing/auth.json")).toEqual([
      { status: "missing", source: "env:DEEPSEEK_API_KEY" },
      {
        status: "missing",
        source: "pi:deepseek",
        path: "/missing/auth.json",
      },
    ]);
  });

  it("extracts a Pi auth.json deepseek entry", () => {
    expect(
      extractDeepSeekCredential({ deepseek: { key: KEY } }, "/auth.json"),
    ).toEqual({
      status: "available",
      key: KEY,
      source: "pi:deepseek",
      path: "/auth.json",
    });
  });

  it("rejects template and scalar Pi auth entries as invalid", () => {
    expect(
      extractDeepSeekCredential(
        { deepseek: { key: "${DEEPSEEK_API_KEY}" } },
        "/auth.json",
      ),
    ).toEqual({ status: "invalid", source: "pi:deepseek", path: "/auth.json" });
    expect(extractDeepSeekCredential({ deepseek: KEY }, "/auth.json")).toEqual({
      status: "invalid",
      source: "pi:deepseek",
      path: "/auth.json",
    });
  });

  it("reports 401 as auth_required", async () => {
    const report = await createDeepSeekAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:DEEPSEEK_API_KEY",
      }),
      fetch: async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        }),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "auth_required", error: "provider_auth_rejected" },
    });
  });

  it("reports 429 as rate_limited with the Retry-After hint", async () => {
    const report = await createDeepSeekAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:DEEPSEEK_API_KEY",
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

  it("rejects a response body larger than the bounded limit", async () => {
    const report = await createDeepSeekAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:DEEPSEEK_API_KEY",
      }),
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": "999999999" },
        }),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "error", error: "response_too_large" },
    });
  });
});
