import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVeniceAdapter,
  resolveVeniceCredentials,
  VENICE_BALANCE_URL,
  VENICE_RATE_LIMITS_URL,
} from "../src/providers/venice.js";
import { withQuotaSemantics } from "../src/interpretation.js";
import { quotaJsonReport, renderQuotaToon } from "../src/render.js";
import { renderQuotaTui } from "../src/tui.js";

const GENERATED_AT = "2030-01-01T12:00:00.000Z";

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
      venice: { scope: "key", usd: 12.5, diem: 25, bundledUsd: 7 },
      balances: [
        { remaining: 12.5, unit: "usd" },
        { remaining: 25, unit: "diem" },
        { remaining: 700, unit: "credits" },
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
    ]);
  });
  it("shows every inference-key balance in TOON and the TUI without a percentage", async () => {
    const quota = await createVeniceAdapter({
      credential,
      adminKey: () => undefined,
      fetch: vi.fn(async () => Response.json(ratePayload)),
      now: () => Date.parse(GENERATED_AT),
    }).fetchQuota({ refreshCredentials: false });
    const response = {
      generatedAt: GENERATED_AT,
      schemaVersion: 5,
      providers: [withQuotaSemantics(quota, GENERATED_AT)],
    } as const;
    const balances =
      "4,450 known credits (earned unknown) · DIEM 25.00 left today · plan 700 credits this month · USD $12.50";
    for (const full of [false, true]) {
      const toon = renderQuotaToon(response, "quota-axi", full);
      expect(toon).toContain(balances);
      expect(toon).toContain("quota[0]:");
    }
    const tui = renderQuotaTui(response, { columns: 60, timeZone: "UTC" });
    expect(tui).toContain("4,450 known credits (earned unknown)");
    expect(tui).toContain("DIEM 25.00 left today");
    expect(tui).toContain("plan 700 credits this month");
    expect(tui).toContain("USD $12.50");
    expect(tui).not.toMatch(/\d%/);
  });
  it("keeps fractional balances inside the TUI card and shows every wallet", async () => {
    const payload = {
      data: {
        balances: {
          USD: 27.93776568,
          DIEM: 1.78822939,
          BUNDLED_CREDITS: 123.45678912,
        },
        nextEpochBegins: "2030-01-02T00:00:00Z",
      },
    };
    const quota = await createVeniceAdapter({
      credential,
      adminKey: () => undefined,
      fetch: vi.fn(async () => Response.json(payload)),
      now: () => Date.parse(GENERATED_AT),
    }).fetchQuota({ refreshCredentials: false });
    const response = {
      generatedAt: GENERATED_AT,
      schemaVersion: 5,
      providers: [withQuotaSemantics(quota, GENERATED_AT)],
    } as const;
    const lines = renderQuotaTui(response, {
      columns: 60,
      timeZone: "UTC",
    }).split("\n");
    for (const amount of [
      "USD $27.94",
      "DIEM 1.79 left today",
      "plan 12,346 credits",
    ])
      expect(lines.join("\n")).toContain(amount);
    for (const line of lines.filter((line) => line.startsWith("│"))) {
      expect(line.endsWith("│")).toBe(true);
      expect(line.length).toBe(49);
    }
  });
  it("reports the complete account total from admin balances, counting a null balance as zero", async () => {
    const raw = {
      usd: 27.93776568,
      diem: 1.78822939,
      bundledCredits: 1,
      earnedCredits: null,
    };
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json(
        url === VENICE_BALANCE_URL
          ? { diemEpochAllocation: 2, balances: raw }
          : {
              data: {
                balances: {
                  USD: raw.usd,
                  DIEM: raw.diem,
                  BUNDLED_CREDITS: raw.bundledCredits,
                },
              },
            },
      ),
    );
    const quota = await createVeniceAdapter({
      credential,
      adminKey: () => "synthetic-admin",
      fetch: fetch as typeof globalThis.fetch,
      now: () => Date.parse(GENERATED_AT),
    }).fetchQuota({ refreshCredentials: false });
    const response = {
      generatedAt: GENERATED_AT,
      schemaVersion: 5,
      providers: [withQuotaSemantics(quota, GENERATED_AT)],
    } as const;
    expect(
      quotaJsonReport(response, false).providers[0].credits?.venice,
    ).toEqual({
      scope: "account",
      usd: raw.usd,
      diem: raw.diem,
      bundledUsd: 1,
      earnedUsd: 0,
      totalCredits: 3073,
    });
    expect(
      quotaJsonReport(response, false).providers[0].credits?.balances,
    ).toEqual([
      { remaining: raw.usd, unit: "usd" },
      { remaining: raw.diem, unit: "diem" },
      { remaining: 100, unit: "credits" },
    ]);
    const displayOrder = [
      "DIEM 1.79 left today",
      "earned 0 credits",
      "plan 100 credits this month",
      "USD $27.94",
    ];
    for (const full of [false, true]) {
      const toon = renderQuotaToon(response, "quota-axi", full);
      expect(displayOrder.map((part) => toon.indexOf(part))).toEqual(
        [...displayOrder.map((part) => toon.indexOf(part))].sort(
          (a, b) => a - b,
        ),
      );
      for (const part of [
        "3,073 Venice Credits spendable now",
        "USD $27.94",
        "DIEM 1.79 left today",
        "plan 100 credits this month",
        "earned 0 credits",
      ])
        expect(toon).toContain(part);
    }
    const tui = renderQuotaTui(response, { columns: 60, timeZone: "UTC" });
    expect(displayOrder.map((part) => tui.indexOf(part))).toEqual(
      [...displayOrder.map((part) => tui.indexOf(part))].sort((a, b) => a - b),
    );
    for (const part of [
      "3,073 Venice Credits spendable now",
      "USD $27.94",
      "DIEM 1.79 left today",
      "plan 100 credits this month",
      "earned 0 credits",
    ])
      expect(tui).toContain(part);
  });
  it("does not invent a total when admin balances omit earned credits", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json(
        url === VENICE_BALANCE_URL
          ? { balances: { usd: 1, diem: 2, bundledCredits: 3 } }
          : ratePayload,
      ),
    );
    const quota = await createVeniceAdapter({
      credential,
      adminKey: () => "synthetic-admin",
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(quota.credits?.venice).toEqual({
      scope: "key",
      usd: 12.5,
      diem: 25,
      bundledUsd: 7,
    });
  });
  it("uses account balances for the total and every wallet", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json(
        url === VENICE_BALANCE_URL
          ? {
              balances: {
                usd: 30,
                diem: 2,
                bundledCredits: 1,
                earnedCredits: 4,
              },
            }
          : ratePayload,
      ),
    );
    const quota = await createVeniceAdapter({
      credential,
      adminKey: () => "synthetic-admin",
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(quota.credits?.venice).toMatchObject({
      scope: "account",
      usd: 30,
      diem: 2,
      bundledUsd: 1,
      earnedUsd: 4,
      totalCredits: 3700,
    });
    expect(quota.credits?.remaining).toBe(30);
    expect(quota.credits?.balances).toEqual([
      { remaining: 30, unit: "usd" },
      { remaining: 2, unit: "diem" },
      { remaining: 500, unit: "credits" },
    ]);
  });
  it("reports earned-only account credits in the shared balance", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json(
        url === VENICE_BALANCE_URL
          ? {
              balances: {
                usd: 0,
                diem: 0,
                bundledCredits: 0,
                earnedCredits: 2.5,
              },
            }
          : ratePayload,
      ),
    );
    const quota = await createVeniceAdapter({
      credential,
      adminKey: () => "synthetic-admin",
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(quota.credits?.remaining).toBe(250);
    expect(quota.credits?.unit).toBe("credits");
    expect(quota.credits?.balances).toContainEqual({
      remaining: 250,
      unit: "credits",
    });
    expect(quota.credits?.venice).toMatchObject({
      earnedUsd: 2.5,
      totalCredits: 250,
    });
  });
  it("calculates the DIEM percentage from account DIEM, not the key-capped balance", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json(
        url === VENICE_BALANCE_URL
          ? {
              diemEpochAllocation: 100,
              balances: {
                usd: 30,
                diem: 80,
                bundledCredits: 1,
                earnedCredits: 0,
              },
            }
          : ratePayload,
      ),
    );
    const result = await createVeniceAdapter({
      credential,
      adminKey: () => "synthetic-admin",
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(result.windows[0]).toMatchObject({
      remainingCredits: 80,
      limitCredits: 100,
      usedCredits: 20,
      percentUsed: 20,
      percentRemaining: 80,
    });
    expect(result.credits?.venice?.diem).toBe(80);
    expect(result.credits?.balances).toContainEqual({
      remaining: 80,
      unit: "diem",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("omits the DIEM percentage when only the allocation is known", async () => {
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
    expect(result.windows[0]).toMatchObject({ remainingCredits: 25 });
    expect(result.windows[0]?.percentUsed).toBeUndefined();
    expect(result.windows[0]?.percentRemaining).toBeUndefined();
    expect(result.windows[0]?.limitCredits).toBeUndefined();
  });
  it("stores bundled credits as whole Venice Credits", async () => {
    const result = await createVeniceAdapter({
      credential,
      adminKey: () => undefined,
      fetch: vi.fn(async () =>
        Response.json({
          data: { balances: { USD: 0, DIEM: 0, BUNDLED_CREDITS: 0.29 } },
        }),
      ),
    }).fetchQuota({ refreshCredentials: false });
    expect(result.credits?.balances).toContainEqual({
      remaining: 29,
      unit: "credits",
    });
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

describe("Venice credential sources", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quota-axi-venice-"));
    path = join(dir, "auth.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeStore = (store: unknown) =>
    writeFileSync(
      path,
      typeof store === "string" ? store : JSON.stringify(store),
      { mode: 0o600 },
    );
  const opencodeSource = (environment: Record<string, string> = {}) =>
    resolveVeniceCredentials(environment, path)[1];

  it("tries VENICE_API_KEY before OpenCode's auth.json", () => {
    writeStore({ venice: { type: "api", key: "synthetic-opencode" } });
    expect(
      resolveVeniceCredentials({ VENICE_API_KEY: "synthetic-env" }, path),
    ).toEqual([
      {
        status: "available",
        key: "synthetic-env",
        source: "env:VENICE_API_KEY",
      },
      {
        status: "available",
        key: "synthetic-opencode",
        source: "opencode:auth.json",
        path,
      },
    ]);
  });

  it("treats an absent file or absent venice entry as a missing source", () => {
    expect(opencodeSource()).toEqual({
      status: "missing",
      source: "opencode:auth.json",
      path,
    });
    writeStore({ "opencode-go": { type: "api", key: "synthetic-go" } });
    expect(opencodeSource()?.status).toBe("missing");
  });

  it.each([
    ["a malformed store", "{not json"],
    ["a non-object store", ["venice"]],
    ["a non-object entry", { venice: "synthetic-string" }],
    ["an entry without a key", { venice: { type: "api" } }],
    ["a command reference key", { venice: { key: "!op read op://v/k" } }],
  ])("reports %s as a present invalid source", (_label, store) => {
    writeStore(store);
    expect(opencodeSource()).toEqual({
      status: "invalid",
      source: "opencode:auth.json",
      path,
    });
  });

  it("hands over from an invalid env key to a live auth.json key, reporting fresh with the failed env attempt recorded", async () => {
    writeStore({ venice: { type: "api", key: "synthetic-opencode" } });
    const bearers: string[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json(ratePayload);
    });
    const result = await createVeniceAdapter({
      credential: () =>
        resolveVeniceCredentials({ VENICE_API_KEY: "${VENICE_API_KEY}" }, path),
      adminKey: () => undefined,
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(bearers).toEqual(["Bearer synthetic-opencode"]);
    expect(result.state.status).toBe("fresh");
    expect(result.attempts).toEqual([
      {
        source: "env:VENICE_API_KEY",
        status: "failed",
        error: "venice_credential_invalid",
        credentialPresent: true,
      },
      { source: "opencode:auth.json", status: "success" },
    ]);
  });

  it("hands over after a rejected env key, and reports sign-in when every key is rejected", async () => {
    writeStore({ venice: { type: "api", key: "synthetic-opencode" } });
    const bearers: string[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(null, { status: 401 });
    });
    const result = await createVeniceAdapter({
      credential: () =>
        resolveVeniceCredentials({ VENICE_API_KEY: "synthetic-env" }, path),
      adminKey: () => undefined,
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(bearers).toEqual([
      "Bearer synthetic-env",
      "Bearer synthetic-opencode",
    ]);
    expect(result.state.status).toBe("auth_required");
  });

  it("does not hand over to auth.json after a transient env-key failure", async () => {
    writeStore({ venice: { type: "api", key: "synthetic-opencode" } });
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const result = await createVeniceAdapter({
      credential: () =>
        resolveVeniceCredentials({ VENICE_API_KEY: "synthetic-env" }, path),
      adminKey: () => undefined,
      fetch: fetch as typeof globalThis.fetch,
    }).fetchQuota({ refreshCredentials: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.state.status).not.toBe("fresh");
    expect(result.state.status).not.toBe("auth_required");
  });
});
