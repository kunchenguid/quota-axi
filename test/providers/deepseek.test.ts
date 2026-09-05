import { describe, expect, it, vi } from "vitest";
import {
  createDeepSeekAdapter,
  extractDeepSeekCredential,
  normalizeDeepSeekPayload,
  resolveDeepSeekCredential,
} from "../../src/providers/deepseek.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-deepseek-key";

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
      attempts: [{ source: "env:DEEPSEEK_API_KEY", status: "success" }],
    });
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "credits:usd",
        kind: "credits",
        limitUsd: 12.5,
        percentRemaining: 100,
      }),
      expect.objectContaining({
        id: "credits:cny",
        kind: "credits",
        limitUsd: 100,
        percentRemaining: 100,
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(request).toHaveBeenCalledOnce();
    const init = request.mock.calls[0][1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("rejects an invalid balance amount", () => {
    expect(() =>
      normalizeDeepSeekPayload({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "-1",
            granted_balance: "0",
            topped_up_balance: "0",
          },
        ],
      }),
    ).toThrow("invalid_amount");
  });

  it("reports missing credentials as auth_required", async () => {
    const report = await createDeepSeekAdapter({
      credential: () => resolveDeepSeekCredential({}),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      provider: "deepseek",
      source: "api",
      state: {
        status: "auth_required",
        error: "deepseek_credential_unavailable",
      },
    });
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

  it("rejects template values as invalid", () => {
    expect(
      extractDeepSeekCredential(
        { deepseek: { key: "${DEEPSEEK_API_KEY}" } },
        "/auth.json",
      ),
    ).toEqual({ status: "missing", source: "pi:deepseek", path: "/auth.json" });
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
      state: { status: "auth_required", error: "provider_auth_rejected" },
    });
  });
});
