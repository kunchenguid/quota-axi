import { describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { renderQuotaToon } from "../../src/render.js";
import {
  createOllamaCloudAdapter,
  OLLAMA_CLOUD_USAGE_URL,
} from "../../src/providers/ollama-cloud.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-ollama-cloud-key";
const NOW = "2026-09-24T12:00:00.000Z";

type RecordedRequest = { url: string; init?: RequestInit };

function adapterFor(
  args: {
    payload?: unknown;
    status?: number;
    environment?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  const requests: RecordedRequest[] = [];
  const deleted: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(
      args.status === 401 || args.status === 403
        ? null
        : JSON.stringify(args.payload ?? {}),
      {
        status: args.status ?? 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const adapter = createOllamaCloudAdapter({
    environment: args.environment ?? { OLLAMA_API_KEY: KEY },
    fetch,
    now: () => Date.parse(NOW),
    deleteCachedProvider: (provider) => deleted.push(provider),
  });
  return { adapter, requests, deleted };
}

describe("Ollama Cloud provider", () => {
  it("reads legacy quotas and separate pay-as-you-go spend", async () => {
    const { adapter, requests } = adapterFor({
      payload: {
        limits: {
          session: { usage: 0.025 },
          weekly: { usage: 0.335 },
        },
        activity: { cost: "1.68" },
      },
    });

    const report = await adapter.fetchQuota(OPTIONS);
    const request = requests[0];
    const headers = new Headers(request?.init?.headers);

    expect(report).toMatchObject({
      provider: "ollama-cloud",
      source: "api",
      state: { status: "fresh", authStatus: "usable" },
      attempts: [{ source: "env:OLLAMA_API_KEY", status: "success" }],
    });
    expect(report.windows).toEqual([
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        windowSeconds: 18_000,
        percentUsed: 3,
        percentRemaining: 97,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
        percentUsed: 34,
        percentRemaining: 66,
      },
      {
        id: "activity",
        label: "activity",
        kind: "unknown",
        spentUsd: 1.68,
      },
    ]);
    expect(request?.url).toBe(OLLAMA_CLOUD_USAGE_URL);
    expect(request?.init?.method).toBe("GET");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(
      report.windows.every((window) => window.resetsAt === undefined),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(KEY);

    const interpreted = withQuotaSemantics(report, NOW);
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: 66,
        },
      ],
    });
  });

  it("marks an absent session window as partial instead of inventing it", async () => {
    const { adapter } = adapterFor({
      payload: { limits: { weekly: { usage: 0.2 } } },
    });

    const report = await adapter.fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, NOW);

    expect(report.windows).toHaveLength(1);
    expect(report.windows[0]).toMatchObject({
      id: "weekly",
      percentUsed: 20,
      percentRemaining: 80,
    });
    expect(report.windows[0]?.resetsAt).toBeUndefined();
    expect(report.state.untrustedWindowIds).toEqual(["five_hour"]);
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["five_hour"],
      effectiveAvailability: [{ scope: "all_models", status: "unknown" }],
    });
  });

  it("reports monthly and activity dollars without making percentages", async () => {
    const { adapter } = adapterFor({
      payload: {
        limits: { monthly: { usage: "0.42" } },
        activity: { cost: "1.68" },
      },
    });

    const report = await adapter.fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, NOW);

    expect(report.windows).toEqual([
      {
        id: "monthly_spend",
        label: "monthly",
        kind: "monthly",
        spentUsd: 0.42,
      },
      {
        id: "activity",
        label: "activity",
        kind: "unknown",
        spentUsd: 1.68,
      },
    ]);
    expect(report.state.untrustedWindowIds).toBeUndefined();
    expect(interpreted.quotaSemantics?.unresolvedWindowIds ?? []).toEqual([]);
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
    });
    const toon = renderQuotaToon(
      {
        generatedAt: NOW,
        schemaVersion: 5,
        providers: [interpreted],
      },
      "quota-axi",
      false,
    );
    expect(toon).toContain("monthly");
    expect(toon).toContain("0.42 USD");
    expect(toon).not.toContain("no_quota");
  });

  it("keeps malformed and unfamiliar limits untrusted", async () => {
    const { adapter } = adapterFor({
      payload: {
        limits: {
          session: { usage: "0.5" },
          weekly: { usage: 0.25 },
          daily: { usage: 0.1 },
        },
      },
    });

    const report = await adapter.fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, NOW);

    expect(report.windows).toEqual([
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        windowSeconds: 18_000,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        windowSeconds: 604_800,
        percentUsed: 25,
        percentRemaining: 75,
      },
      { id: "limit:1", label: "limit 1", kind: "unknown" },
    ]);
    expect(report.state.untrustedWindowIds).toEqual(["five_hour", "limit:1"]);
    expect(interpreted.quotaSemantics?.status).toBe("partial");
  });

  it.each([["1.68"], [5], [[]], [{}]])(
    "keeps a malformed activity entry %j untrusted",
    async (activity) => {
      const { adapter } = adapterFor({
        payload: { limits: { monthly: { usage: "0.42" } }, activity },
      });

      const report = await adapter.fetchQuota(OPTIONS);

      expect(report.windows.map((window) => window.id)).toEqual([
        "monthly_spend",
      ]);
      expect(report.state.untrustedWindowIds).toEqual(["activity"]);
    },
  );

  it("does not request without a usable key and reports invalid keys as present", async () => {
    const absent = adapterFor({ environment: {} });
    const absentReport = await absent.adapter.fetchQuota(OPTIONS);
    expect(absent.requests).toHaveLength(0);
    expect(absentReport.state.status).toBe("auth_required");
    expect(absentReport.attempts).toEqual([
      {
        source: "env:OLLAMA_API_KEY",
        status: "skipped",
        error: "ollama-cloud_credential_unavailable",
      },
    ]);

    const invalid = adapterFor({
      environment: { OLLAMA_API_KEY: "$OLLAMA_API_KEY" },
    });
    const invalidReport = await invalid.adapter.fetchQuota(OPTIONS);
    expect(invalid.requests).toHaveLength(0);
    expect(invalidReport.attempts).toEqual([
      {
        source: "env:OLLAMA_API_KEY",
        status: "failed",
        error: "ollama-cloud_credential_invalid",
        credentialPresent: true,
      },
    ]);
    await expect(invalid.adapter.inspectAuth?.(OPTIONS)).resolves.toMatchObject(
      {
        provider: "ollama-cloud",
        sources: [{ source: "env:OLLAMA_API_KEY", status: "invalid" }],
      },
    );
  });

  it("treats an HTTP 401 as a rejected key", async () => {
    const { adapter, deleted } = adapterFor({ status: 401 });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toBe("provider_auth_rejected");
    expect(report.attempts).toEqual([
      {
        source: "env:OLLAMA_API_KEY",
        status: "failed",
        error: "provider_auth_rejected",
      },
    ]);
    expect(deleted).toEqual(["ollama-cloud"]);
  });
});
