import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKiroAdapter,
  normalizeKiroUsage,
  type KiroCredentialState,
} from "../../src/providers/kiro.js";

const OPTIONS = { allowKeychainPrompt: false };
const ORIGINAL_CACHE_HOME = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = "/tmp/quota-axi-kiro-test-cache";
});

afterEach(() => {
  if (ORIGINAL_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = ORIGINAL_CACHE_HOME;
});
const ACCESS_TOKEN = "synthetic-kiro-token";
const SOURCE = {
  source: "kiro-sqlite",
  path: "~/.local/share/kiro-cli/data.sqlite3",
  status: "available" as const,
};
const CREDENTIALS: KiroCredentialState = {
  status: "available",
  credentials: { accessToken: ACCESS_TOKEN, region: "us-east-1" },
  source: SOURCE,
};
const USAGE_PAYLOAD = {
  nextDateReset: 1_788_220_800,
  subscriptionInfo: {
    subscriptionTitle: "KIRO PRO+",
    type: "Q_DEVELOPER_STANDALONE_PRO_PLUS",
  },
  usageBreakdownList: [
    {
      currentUsageWithPrecision: 500,
      usageLimitWithPrecision: 2000,
      displayName: "Credit",
      displayNamePlural: "Credits",
      resourceType: "CREDIT",
    },
  ],
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Kiro quota normalization", () => {
  it("normalizes credit usage, plan, balance, and reset", () => {
    expect(normalizeKiroUsage(USAGE_PAYLOAD)).toMatchObject({
      plan: "KIRO PRO+",
      credits: { remaining: 1500, unit: "credits" },
      windows: [
        {
          id: "credit",
          label: "Credits",
          kind: "credits",
          percentUsed: 25,
          percentRemaining: 75,
          resetsAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("accepts the compact limits shape when usage breakdowns are absent", () => {
    expect(
      normalizeKiroUsage({
        limits: [{ feature: "AGENTIC_REQUEST", percentUsed: 30 }],
      }),
    ).toMatchObject({
      windows: [
        {
          id: "agentic_request",
          label: "Agentic Request",
          percentUsed: 30,
          percentRemaining: 70,
        },
      ],
    });
  });

  it("rejects empty responses instead of inventing quota", () => {
    expect(normalizeKiroUsage({})).toBeUndefined();
    expect(normalizeKiroUsage(null)).toBeUndefined();
  });
});

describe("Kiro quota transport", () => {
  it("calls the first-party usage endpoint with a read-only bearer request", async () => {
    const request = vi.fn(async () => jsonResponse(USAGE_PAYLOAD));
    const adapter = createKiroAdapter({
      fetch: request,
      readCredentialState: () => CREDENTIALS,
    });
    const report = await adapter.fetchQuota(OPTIONS);
    expect(request).toHaveBeenCalledOnce();
    const [input, init] = request.mock.calls[0];
    expect(String(input)).toBe(
      "https://codewhisperer.us-east-1.amazonaws.com/",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      body: JSON.stringify({ isEmailRequired: true }),
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("x-amz-target")).toBe(
      "AmazonCodeWhispererService.GetUsageLimits",
    );
    expect(headers.get("content-type")).toBe("application/x-amz-json-1.0");
    expect(headers.get("cookie")).toBeNull();
    expect(report).toMatchObject({
      provider: "kiro",
      label: "Kiro",
      source: "api",
      state: { status: "fresh", sourcesTried: ["kiro-sqlite"] },
      attempts: [{ source: "kiro-sqlite", status: "success" }],
      plan: "KIRO PRO+",
    });
    expect(JSON.stringify(report)).not.toContain(ACCESS_TOKEN);
  });

  it("reports missing credentials without making a request", async () => {
    const request = vi.fn();
    const missing: KiroCredentialState = {
      status: "missing",
      source: {
        source: "kiro-sqlite",
        path: "~/.local/share/kiro-cli/data.sqlite3",
        status: "missing",
      },
    };
    const report = await createKiroAdapter({
      fetch: request,
      readCredentialState: () => missing,
    }).fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.attempts).toEqual([
      {
        source: "kiro-sqlite",
        status: "skipped",
        error: "credentials_missing",
      },
    ]);
  });

  it("classifies throttling and preserves retry-after", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    );
    const report = await createKiroAdapter({
      fetch: request,
      readCredentialState: () => CREDENTIALS,
    }).fetchQuota(OPTIONS);
    expect(report.state.status).toBe("rate_limited");
    expect(report.state.retryAfter).toBeDefined();
    expect(report.state.error).toBe("Kiro quota endpoint rate limited");
  });
});
