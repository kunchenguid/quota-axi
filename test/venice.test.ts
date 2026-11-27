import { describe, expect, it, vi } from "vitest";
import {
  createVeniceAdapter,
  VENICE_BALANCE_URL,
  VENICE_RATE_LIMITS_URL,
} from "../src/providers/venice.js";

const credential = () => ({
  status: "available" as const,
  key: "synthetic-inference",
  source: "env:VENICE_API_KEY",
});
const ratePayload = {
  data: {
    balances: { USD: 12.5, DIEM: 25, BUNDLED_CREDITS: 7 },
    nextEpochBegins: "2030-01-02T00:00:00.000Z",
  },
};

describe("Venice balance provider", () => {
  it("reports the vendor balances and daily reset without inventing a percentage", async () => {
    const fetch = vi.fn(async () => Response.json(ratePayload));
    const result = await createVeniceAdapter({
      credential,
      adminKey: () => undefined,
      fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(VENICE_RATE_LIMITS_URL);
    expect(result.credits).toEqual({
      remaining: 12.5,
      unit: "usd",
      balances: [
        { remaining: 12.5, unit: "usd" },
        { remaining: 7, unit: "credits" },
      ],
    });
    expect(result.windows).toEqual([
      {
        id: "diem",
        label: "DIEM",
        kind: "credits",
        remainingCredits: 25,
        creditUnit: "DIEM",
        resetsAt: "2030-01-02T00:00:00.000Z",
      },
      {
        id: "bundled-credits",
        label: "Bundled credits",
        kind: "credits",
        remainingCredits: 7,
        creditUnit: "bundled credits",
      },
    ]);
  });
  it("uses the optional admin allocation to calculate the DIEM percentage", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json(
        url === VENICE_BALANCE_URL ? { diemEpochAllocation: 100 } : ratePayload,
      ),
    );
    const result = await createVeniceAdapter({
      credential,
      adminKey: () => "synthetic-admin",
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(result.windows[0]).toMatchObject({
      remainingCredits: 25,
      limitCredits: 100,
      usedCredits: 75,
      percentRemaining: 25,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps inference balances when the optional admin endpoint fails", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      url === VENICE_BALANCE_URL
        ? new Response(null, { status: 403 })
        : Response.json(ratePayload),
    );
    const result = await createVeniceAdapter({
      credential,
      adminKey: () => "synthetic-admin",
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(result.credits?.remaining).toBe(12.5);
    expect(result.windows[0]?.percentRemaining).toBeUndefined();
  });
});
