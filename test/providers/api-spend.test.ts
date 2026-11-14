import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import { main } from "../../src/cli.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { renderQuotaTui } from "../../src/tui.js";
import {
  currentSpendMonth,
  monthlyLimitWindow,
  parseSpendLimit,
} from "../../src/providers/api-spend.js";
import {
  ANTHROPIC_API_SPEC,
  parseAnthropicCostPage,
} from "../../src/providers/anthropic-api.js";
import { createApiSpendAdapter } from "../../src/providers/api-spend.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const NOW = Date.parse("2026-11-07T21:00:00.000Z");
const KEY = "synthetic-admin-key";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, "../fixtures/api-spend", name), "utf8"),
  );
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Answers each cost-report page in order. */
function vendor(pages: unknown[] = []) {
  const queue = [...pages];
  return vi.fn(async () => json(queue.shift()));
}

function adapter(
  spec: typeof ANTHROPIC_API_SPEC,
  request: typeof fetch,
  environment: Record<string, string | undefined>,
) {
  return createApiSpendAdapter(spec, {
    environment: () => environment,
    fetch: request as never,
    now: () => NOW,
  });
}

describe("spend period", () => {
  it("is the current UTC month through the end of today", () => {
    expect(currentSpendMonth(NOW)).toEqual({
      period: {
        start: new Date("2026-11-01T00:00:00.000Z"),
        end: new Date("2026-11-08T00:00:00.000Z"),
      },
      resetsAt: new Date("2026-12-01T00:00:00.000Z"),
    });
  });

  it("rolls over into the next UTC year in December", () => {
    expect(currentSpendMonth(Date.parse("2026-12-31T23:59:59.000Z"))).toEqual({
      period: {
        start: new Date("2026-12-01T00:00:00.000Z"),
        end: new Date("2027-01-01T00:00:00.000Z"),
      },
      resetsAt: new Date("2027-01-01T00:00:00.000Z"),
    });
  });
});

describe("configured monthly limit", () => {
  it("reads a positive plain USD amount and treats blank as unset", () => {
    expect(parseSpendLimit(undefined)).toEqual({ status: "unset" });
    expect(parseSpendLimit("  ")).toEqual({ status: "unset" });
    expect(parseSpendLimit("250")).toEqual({ status: "set", limitUsd: 250 });
    expect(parseSpendLimit(" 99.50 ")).toEqual({
      status: "set",
      limitUsd: 99.5,
    });
    for (const value of ["0", "0.00", "-5", "$100", "1e3", "Infinity", "ten"]) {
      expect(parseSpendLimit(value)).toEqual({ status: "invalid" });
    }
  });

  it("publishes the unspent share over the UTC month", () => {
    expect(monthlyLimitWindow(25, 100, currentSpendMonth(NOW))).toEqual({
      id: "monthly_limit",
      label: "my cap",
      kind: "monthly",
      percentUsed: 25,
      percentRemaining: 75,
      startsAt: "2026-11-01T00:00:00.000Z",
      resetsAt: "2026-12-01T00:00:00.000Z",
      spentUsd: 25,
      limitUsd: 100,
    });
  });

  it("reads 0 remaining only at or over the limit", () => {
    const month = currentSpendMonth(NOW);
    expect(monthlyLimitWindow(100, 100, month)).toMatchObject({
      percentUsed: 100,
      percentRemaining: 0,
    });
    expect(monthlyLimitWindow(140, 100, month)).toMatchObject({
      percentUsed: 100,
      percentRemaining: 0,
      spentUsd: 140,
    });
    expect(monthlyLimitWindow(99.999, 100, month)).toMatchObject({
      percentRemaining: 0.01,
    });
  });
});

describe("Anthropic API spend", () => {
  it("sums the cost report across pages in USD without a credential leak", async () => {
    const request = vendor([
      fixture("anthropic-cost-report-page1.json"),
      fixture("anthropic-cost-report-page2.json"),
    ]);
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
    }).fetchQuota(OPTIONS);

    // (123.78912 + 50.2 + 1000) cents
    expect(report).toMatchObject({
      provider: "anthropic-api",
      source: "api",
      windows: [],
      state: { status: "fresh", stale: false, authStatus: "usable" },
      spend: {
        currency: "USD",
        spentUsd: 11.739891,
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-11-08T00:00:00.000Z",
        buckets: 3,
        reportedLag: "typically within 5 minutes",
      },
      attempts: [{ source: "env:ANTHROPIC_ADMIN_KEY", status: "success" }],
    });
    expect(report.spend).not.toHaveProperty("organization");
    expect(JSON.stringify(report)).not.toContain(KEY);

    expect(request).toHaveBeenCalledTimes(2);
    const calls = request.mock.calls as unknown as [string, RequestInit][];
    const first = new URL(calls[0][0]);
    expect(first.origin + first.pathname).toBe(
      "https://api.anthropic.com/v1/organizations/cost_report",
    );
    expect(first.searchParams.get("starting_at")).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(first.searchParams.get("ending_at")).toBe(
      "2026-11-08T00:00:00.000Z",
    );
    expect(first.searchParams.get("bucket_width")).toBe("1d");
    expect(first.searchParams.get("page")).toBeNull();
    expect(new URL(calls[1][0]).searchParams.get("page")).toBe(
      "page_MjAyNi0xMC0xNlQwMDowMDowMFo=",
    );
    const headers = new Headers(calls[0][1].headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("anthropic-version")).toBeTruthy();
    expect(headers.get("authorization")).toBeNull();
  });

  it("reports a missing admin key as auth_required without a request", async () => {
    const request = vi.fn();
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_API_KEY: "inference-key-is-never-read",
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      provider: "anthropic-api",
      state: {
        status: "auth_required",
        error: "anthropic-api_credential_unavailable",
      },
    });
    expect(report.spend).toBeUndefined();
  });

  it("reports a rejected admin key as auth_required with no spend", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "auth_required", error: "provider_auth_rejected" },
      attempts: [{ status: "failed", error: "provider_auth_rejected" }],
    });
    expect(report.spend).toBeUndefined();
  });

  it("adds a configured monthly limit as an all_models bound", async () => {
    const request = vendor([
      fixture("anthropic-cost-report-page1.json"),
      fixture("anthropic-cost-report-page2.json"),
    ]);
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
      QUOTA_AXI_ANTHROPIC_API_LIMIT_USD: "100",
    }).fetchQuota(OPTIONS);

    expect(report.windows).toEqual([
      {
        id: "monthly_limit",
        label: "my cap",
        kind: "monthly",
        percentUsed: 11.74,
        percentRemaining: 88.26,
        startsAt: "2026-11-01T00:00:00.000Z",
        resetsAt: "2026-12-01T00:00:00.000Z",
        spentUsd: 11.739891,
        limitUsd: 100,
      },
    ]);
    const scope = withQuotaSemantics(report, new Date(NOW).toISOString())
      .quotaSemantics?.effectiveAvailability[0];
    expect(scope).toMatchObject({
      scope: "all_models",
      status: "known",
      effectivePercentRemaining: 88.26,
      boundedBy: ["monthly_limit"],
      runway: { status: "through_reset" },
      selection: { status: "known" },
    });
    expect(scope?.selection?.spendPriority).toEqual(expect.any(Number));
  });

  it("projects exhaustion when spend outpaces the month", async () => {
    const request = vendor([
      fixture("anthropic-cost-report-page1.json"),
      fixture("anthropic-cost-report-page2.json"),
    ]);
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
      QUOTA_AXI_ANTHROPIC_API_LIMIT_USD: "40",
    }).fetchQuota(OPTIONS);
    const scope = withQuotaSemantics(report, new Date(NOW).toISOString())
      .quotaSemantics?.effectiveAvailability[0];
    // 29.35% spent with 22.9% of November elapsed.
    expect(scope).toMatchObject({
      effectivePercentRemaining: 70.65,
      runway: {
        status: "projected_exhaustion",
        limitingWindowId: "monthly_limit",
      },
    });
    expect(Date.parse(scope?.runway?.projectedExhaustedAt ?? "")).toBeLessThan(
      Date.parse("2026-12-01T00:00:00.000Z"),
    );
  });

  it("reports exhausted_now at or over the configured limit", async () => {
    for (const limit of ["11.739891", "10"]) {
      const request = vendor([
        fixture("anthropic-cost-report-page1.json"),
        fixture("anthropic-cost-report-page2.json"),
      ]);
      const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
        ANTHROPIC_ADMIN_KEY: KEY,
        QUOTA_AXI_ANTHROPIC_API_LIMIT_USD: limit,
      }).fetchQuota(OPTIONS);
      const scope = withQuotaSemantics(report, new Date(NOW).toISOString())
        .quotaSemantics?.effectiveAvailability[0];
      expect(scope).toMatchObject({
        effectivePercentRemaining: 0,
        runway: {
          status: "exhausted_now",
          usableRunwaySeconds: 0,
          limitingWindowId: "monthly_limit",
        },
      });
    }
  });

  it("keeps spend without a limit unmeasured", async () => {
    const request = vendor([
      fixture("anthropic-cost-report-page1.json"),
      fixture("anthropic-cost-report-page2.json"),
    ]);
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
    }).fetchQuota(OPTIONS);
    expect(report.windows).toEqual([]);
    const semantics = withQuotaSemantics(
      report,
      new Date(NOW).toISOString(),
    ).quotaSemantics;
    expect(semantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: [],
    });
    expect(semantics?.description).toContain(
      "QUOTA_AXI_ANTHROPIC_API_LIMIT_USD",
    );
  });

  it("does not suggest configuring a limit on a failed read that has one", async () => {
    const request = vi.fn(async () => new Response(null, { status: 401 }));
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
      QUOTA_AXI_ANTHROPIC_API_LIMIT_USD: "100",
    }).fetchQuota(OPTIONS);
    expect(report.state.error).toBe("provider_auth_rejected");
    const semantics = withQuotaSemantics(
      report,
      new Date(NOW).toISOString(),
    ).quotaSemantics;
    expect(semantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
    });
    expect(semantics?.description).not.toContain("reports spend");
    expect(semantics?.description).not.toContain(
      "QUOTA_AXI_ANTHROPIC_API_LIMIT_USD",
    );
  });

  it("refuses an unusable limit before any request", async () => {
    const request = vi.fn();
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
      QUOTA_AXI_ANTHROPIC_API_LIMIT_USD: "$100",
    }).fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.spend).toBeUndefined();
    expect(report.windows).toEqual([]);
    expect(report.state).toMatchObject({
      status: "error",
      error: "spend_limit_invalid",
    });
  });

  it("never caches a capped spend reading", async () => {
    const request = vendor([
      fixture("anthropic-cost-report-page1.json"),
      fixture("anthropic-cost-report-page2.json"),
    ]);
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
      QUOTA_AXI_ANTHROPIC_API_LIMIT_USD: "40",
    }).fetchQuota(OPTIONS);
    expect(report.windows).toHaveLength(1);
    writeCachedProviders([report]);
    expect(readCachedProvider("anthropic-api")).toBeUndefined();
  });

  it("never turns a malformed or empty report into a spend figure", () => {
    expect(() => parseAnthropicCostPage({})).toThrow("invalid_payload");
    expect(() =>
      parseAnthropicCostPage({
        data: [{ results: [{ amount: "1", currency: "EUR" }] }],
      }),
    ).toThrow("invalid_currency");
    expect(() =>
      parseAnthropicCostPage({
        data: [{ results: [{ amount: 1, currency: "USD" }] }],
      }),
    ).toThrow("invalid_amount");
    expect(() =>
      parseAnthropicCostPage({ data: [], has_more: true, next_page: null }),
    ).toThrow("invalid_payload");
  });

  it("fails instead of reporting $0 when the vendor returns no buckets", async () => {
    const request = vendor([{ data: [], has_more: false, next_page: null }]);
    const report = await adapter(ANTHROPIC_API_SPEC, request as never, {
      ANTHROPIC_ADMIN_KEY: KEY,
    }).fetchQuota(OPTIONS);
    expect(report.spend).toBeUndefined();
    expect(report.state).toMatchObject({
      status: "error",
      error: "spend_no_buckets",
    });
  });

  it("reports an empty-but-bucketed period as exactly zero", () => {
    const page = parseAnthropicCostPage({
      data: [{ results: [] }],
      has_more: false,
      next_page: null,
    });
    expect(page).toEqual({ buckets: 1, spentUsd: 0 });
  });
});

describe("API spend end to end", () => {
  const environment = { ...process.env };
  afterEach(() => {
    process.env = { ...environment };
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.exitCode = undefined;
  });

  async function run(argv: string[]): Promise<string> {
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

  function stubVendors(): ReturnType<typeof vi.fn> {
    const request = vi.fn(async () =>
      json({
        data: [
          {
            starting_at: "2026-10-14T00:00:00Z",
            ending_at: "2026-10-15T00:00:00Z",
            results: [{ amount: "12345", currency: "USD" }],
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );
    vi.stubGlobal("fetch", request);
    return request;
  }

  it("prints a spend[] block in TOON and keeps the no_quota row", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    process.env.ANTHROPIC_ADMIN_KEY = KEY;
    stubVendors();

    const output = await run(["--provider", "anthropic-api"]);

    expect(output).toContain(
      "spend[1]{provider,periodStart,periodEnd,spentUsd,limitUsd,buckets,reportedLag}:",
    );
    expect(output).toContain(
      'anthropic-api,"2026-11-01T00:00:00.000Z","2026-11-08T00:00:00.000Z",123.45,none,1,typically within 5 minutes',
    );
    expect(output).toContain("quota[0]:");
    expect(output).toContain(
      "anthropic-api,all,no_quota,no measurable scope (auth usable),none",
    );
    expect(output).not.toContain(KEY);
  });

  it("carries the same figures on spend in --json", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    process.env.ANTHROPIC_ADMIN_KEY = KEY;
    stubVendors();

    const report = JSON.parse(
      await run(["--provider", "anthropic-api", "--json"]),
    );
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]).toMatchObject({
      provider: "anthropic-api",
      windows: [],
      spend: {
        currency: "USD",
        spentUsd: 123.45,
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-11-08T00:00:00.000Z",
      },
      state: { status: "fresh", authStatus: "usable" },
    });
    expect(report.providers[0].spend).not.toHaveProperty("organization");
  });

  it("states a missing key in attention[] and prints no spend block", async () => {
    delete process.env.ANTHROPIC_ADMIN_KEY;
    const request = stubVendors();
    const output = await run(["--provider", "anthropic-api"]);
    expect(request).not.toHaveBeenCalled();
    expect(output).not.toContain("spend[");
    expect(output).toContain(
      "anthropic-api,all,auth_required,anthropic-api_credential_unavailable",
    );
  });

  it("prints a quota[] row and exhaustion against a configured limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    process.env.ANTHROPIC_ADMIN_KEY = KEY;
    process.env.QUOTA_AXI_ANTHROPIC_API_LIMIT_USD = "100";
    stubVendors();

    const output = await run(["--provider", "anthropic-api"]);
    expect(output).toContain(
      'anthropic-api,"2026-11-01T00:00:00.000Z","2026-11-08T00:00:00.000Z",123.45,100,1,',
    );
    expect(output).toMatch(
      /quota\[1\]\{provider,scope,effectivePercentRemaining,spendPriority,runway,confidence,limitedBy,resetsAt\}:\n\s+anthropic-api,all_models,0,[^,]+,exhausted_now,unknown,monthly_limit,"2026-12-01T00:00:00.000Z"/,
    );
    expect(output).toContain("exhaustion[1]");
    expect(output).not.toContain(KEY);
  });

  it("states an unusable limit in attention[] without a request", async () => {
    process.env.ANTHROPIC_ADMIN_KEY = KEY;
    process.env.QUOTA_AXI_ANTHROPIC_API_LIMIT_USD = "unlimited";
    const request = stubVendors();
    const output = await run(["--provider", "anthropic-api"]);
    expect(request).not.toHaveBeenCalled();
    expect(output).not.toContain("spend[");
    expect(output).toContain("spend_limit_invalid");
  });
});

describe("API spend in the human report", () => {
  it("draws the reported figure and period without a bar", () => {
    const provider = withQuotaSemantics(
      {
        provider: "anthropic-api",
        label: "Anthropic API",
        source: "api",
        windows: [],
        spend: {
          currency: "USD",
          spentUsd: 123.456,
          periodStart: "2026-10-14T00:00:00.000Z",
          periodEnd: "2026-11-08T00:00:00.000Z",
          buckets: 25,
        },
        state: { status: "fresh", stale: false },
      },
      "2026-11-07T21:00:00.000Z",
    );
    const output = renderQuotaTui(
      {
        generatedAt: "2026-11-07T21:00:00.000Z",
        schemaVersion: 5,
        providers: [provider],
      },
      { timeZone: "UTC" },
    );
    expect(output).toContain("$123.46 spent");
    expect(output).toContain("2026-10-14 to 2026-11-07 UTC");
  });

  it("draws the configured limit as a bar and still states the spend", () => {
    const month = currentSpendMonth(NOW);
    const provider = withQuotaSemantics(
      {
        provider: "anthropic-api",
        label: "Anthropic API",
        source: "api",
        windows: [monthlyLimitWindow(25, 100, month)],
        spend: {
          currency: "USD",
          spentUsd: 25,
          periodStart: "2026-11-01T00:00:00.000Z",
          periodEnd: "2026-11-08T00:00:00.000Z",
          buckets: 7,
        },
        state: { status: "fresh", stale: false },
      },
      new Date(NOW).toISOString(),
    );
    const output = renderQuotaTui(
      {
        generatedAt: new Date(NOW).toISOString(),
        schemaVersion: 5,
        providers: [provider],
      },
      { timeZone: "UTC" },
    );
    expect(output).toContain("75%");
    expect(output).toContain("$25.00 of $100.00 spent");
    // The limit is named in full in both the headline and the window row:
    // the fixed-width card never cuts it short with an ellipsis.
    expect(output).toMatch(/75% my cap\s/);
    expect(output).toMatch(/│\s+my cap\s+\S/);
    expect(output).not.toContain("…");
  });
});
