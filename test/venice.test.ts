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

  it("hands over from an invalid env key to a live auth.json key and marks it degraded", async () => {
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
