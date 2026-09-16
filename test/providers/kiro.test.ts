import { describe, expect, it, vi } from "vitest";
import {
  createKiroAdapter,
  extractKiroIdeCredential,
  extractKiroSqliteCredential,
  extractPiKiroCredential,
  normalizeKiroUsage,
} from "../../src/providers/kiro.js";
import { renderQuotaTui } from "../../src/tui.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import type { ProviderQuota } from "../../src/types.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const TOKEN = "synthetic-kiro-token";
const NOW = Date.parse("2026-08-13T12:00:00.000Z");

function availableSource(profileArn: string | null = "arn:aws:profile/test") {
  return {
    resolve: async () => ({
      status: "available" as const,
      credential: {
        accessToken: TOKEN,
        region: "us-east-1",
        ...(profileArn ? { profileArn } : {}),
        path: "/auth.json",
      },
    }),
    inspect: async () => ({
      status: "available" as const,
      credential: {
        accessToken: TOKEN,
        region: "us-east-1",
        ...(profileArn ? { profileArn } : {}),
        path: "/auth.json",
      },
    }),
  };
}

describe("Kiro provider", () => {
  it("reads Pi OAuth/API-key entries without touching refresh", () => {
    expect(
      extractPiKiroCredential(
        {
          status: "success",
          value: {
            kiro: {
              type: "oauth",
              access: TOKEN,
              refresh: "must-not-be-read",
              region: "us-west-2",
            },
          },
        },
        "/pi/auth.json",
      ),
    ).toMatchObject({
      status: "available",
      credential: { accessToken: TOKEN, region: "us-west-2" },
    });
    expect(
      extractPiKiroCredential(
        {
          status: "success",
          value: {
            kiro: { type: "api_key", key: TOKEN, region: "us-east-1" },
          },
        },
        "/pi/auth.json",
      ),
    ).toMatchObject({
      status: "available",
      credential: { accessToken: TOKEN },
    });
    expect(
      extractPiKiroCredential(
        { status: "success", value: { kiro: { type: "api_key", key: TOKEN } } },
        "/pi/auth.json",
      ),
    ).toMatchObject({ status: "invalid", error: "region_missing" });
  });

  it("reads the IDE access token without requiring a refresh token", () => {
    expect(
      extractKiroIdeCredential(
        {
          status: "success",
          value: { accessToken: TOKEN, region: "us-east-1" },
        },
        "/kiro-auth-token.json",
      ),
    ).toMatchObject({
      status: "available",
      credential: { accessToken: TOKEN },
    });
  });

  it("reads only the selected Kiro CLI token fields from SQLite output", () => {
    expect(
      extractKiroSqliteCredential(
        JSON.stringify([
          {
            access_token: TOKEN,
            region: "eu-north-1",
            profile_arn: "arn:aws:profile/test",
            expires_at: 1_900_000_000,
            refresh_token: "must-not-be-read",
          },
        ]),
        "/kiro/data.sqlite3",
      ),
    ).toMatchObject({
      status: "available",
      credential: {
        accessToken: TOKEN,
        region: "eu-north-1",
        profileArn: "arn:aws:profile/test",
      },
    });
  });

  it("normalizes usage breakdowns and preserves provider-native billing evidence", () => {
    const normalized = normalizeKiroUsage({
      usageBreakdownList: [
        {
          resourceType: "CREDIT",
          displayName: "Session credits",
          currentUsageWithPrecision: 2.5,
          usageLimitWithPrecision: 10,
          unit: "credits",
          nextDateReset: "2026-08-14T00:00:00Z",
          currentOverages: 1,
          overageCharges: 0.25,
          currency: "USD",
        },
      ],
    });
    expect(normalized.windows[0]).toMatchObject({
      id: "CREDIT",
      label: "Session credits",
      kind: "credits",
      usage: 2.5,
      limit: 10,
      percentUsed: 25,
      percentRemaining: 75,
      overage: 1,
      overageCharges: 0.25,
      currency: "USD",
    });
  });

  it("continues to an IDE credential when the CLI store is unreadable", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            usageBreakdown: {
              resourceType: "CREDIT",
              currentUsage: 1,
              usageLimit: 2,
            },
          }),
          { status: 200 },
        ),
    );
    const report = await createKiroAdapter({
      credentialSources: [
        {
          name: "kiro-cli",
          source: {
            resolve: async () => ({
              status: "error" as const,
              path: "/kiro/data.sqlite3",
              error: "credential_store_unreadable",
            }),
            inspect: async () => ({
              status: "error" as const,
              path: "/kiro/data.sqlite3",
              error: "credential_store_unreadable",
            }),
          },
        },
        { name: "kiro-ide", source: availableSource() },
      ],
      fetch: request,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.state.sourcesTried).toEqual(["kiro-cli", "kiro-ide"]);
  });

  it("tries the next credential when one source has no quota windows", async () => {
    let calls = 0;
    const emptySource = {
      resolve: async () => {
        calls += 1;
        return {
          status: "available" as const,
          credential: {
            accessToken: "empty-source-token",
            region: "us-east-1",
            profileArn: "arn:aws:profile/empty",
            path: "/empty/auth.json",
          },
        };
      },
      inspect: async () => ({
        status: "available" as const,
        credential: {
          accessToken: "empty-source-token",
          region: "us-east-1",
          profileArn: "arn:aws:profile/empty",
          path: "/empty/auth.json",
        },
      }),
    };
    const report = await createKiroAdapter({
      credentialSources: [
        { name: "empty", source: emptySource },
        { name: "working", source: availableSource() },
      ],
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              usageBreakdown: {
                resourceType: "CREDIT",
                currentUsage: 1,
                usageLimit: 2,
              },
            }),
            { status: 200 },
          ),
        ),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(calls).toBe(1);
    expect(report.state.status).toBe("fresh");
    expect(report.state.sourcesTried).toEqual(["empty", "working"]);
  });

  it("keeps quota_missing when later credentials are invalid", async () => {
    const report = await createKiroAdapter({
      credentialSources: [
        { name: "empty", source: availableSource() },
        {
          name: "invalid",
          source: {
            resolve: async () => ({
              status: "invalid" as const,
              path: "/invalid/auth.json",
              error: "invalid_credential",
            }),
            inspect: async () => ({
              status: "invalid" as const,
              path: "/invalid/auth.json",
              error: "invalid_credential",
            }),
          },
        },
      ],
      fetch: vi.fn(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      ),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "quota_missing",
    });
  });

  it("rejects an empty successful response instead of clearing quota evidence", async () => {
    const report = await createKiroAdapter({
      credentialSources: [{ name: "test", source: availableSource() }],
      fetch: vi.fn(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      ),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "quota_missing",
    });
  });

  it("reports a later provider failure after quota_missing", async () => {
    const request = vi
      .fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    const report = await createKiroAdapter({
      credentialSources: [
        { name: "empty", source: availableSource() },
        { name: "rate-limited", source: availableSource() },
      ],
      fetch: request,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "rate_limited",
      error: "provider_rate_limited",
    });
  });

  it("omits malformed windows while retaining their IDs", () => {
    const normalized = normalizeKiroUsage({
      usageBreakdownList: [
        null,
        { resourceType: "CREDIT", currentUsage: 1, usageLimit: 2 },
      ],
    });

    expect(normalized.untrustedWindowIds).toEqual(["usage:0"]);
    expect(normalized.windows).toHaveLength(1);
    expect(normalized.windows[0].kind).toBe("credits");
  });

  it("requests profiles then usage with the Kiro read-only headers", async () => {
    const request = vi
      .fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ profiles: [{ arn: "arn:aws:profile/test" }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            usageBreakdown: {
              resourceType: "CREDIT",
              displayName: "Session",
              currentUsage: 3,
              usageLimit: 12,
              nextDateReset: "2026-08-14T00:00:00Z",
            },
          }),
          { status: 200 },
        ),
      );
    const report = await createKiroAdapter({
      credentialSources: [{ name: "test", source: availableSource(null) }],
      fetch: request,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    const profileUrl = new URL(String(request.mock.calls[0][0]));
    expect(profileUrl.pathname).toBe("/List-Available-Profiles");
    const usageUrl = new URL(String(request.mock.calls[1][0]));
    expect(usageUrl.pathname).toBe("/Get-Usage-Limits");
    expect(usageUrl.searchParams.get("origin")).toBe("KIRO_CLI");
    expect(usageUrl.searchParams.get("resourceType")).toBe("CREDIT");
    expect(usageUrl.searchParams.get("profileArn")).toBe(
      "arn:aws:profile/test",
    );
    const headers = new Headers(request.mock.calls[1][1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("user-agent")).toBe("quota-axi");
    expect(report.state.status).toBe("fresh");
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it("renders Kiro usage in the TUI without inventing a combined bound", () => {
    const provider: ProviderQuota = {
      provider: "kiro",
      label: "Kiro",
      source: "api",
      windows: [
        {
          id: "CREDIT",
          label: "Session credits",
          kind: "credits",
          usage: 2.5,
          limit: 10,
          unit: "credits",
          percentUsed: 25,
          percentRemaining: 75,
          resetsAt: "2026-08-14T00:00:00Z",
        },
      ],
      state: { status: "fresh", stale: false },
    };
    const response = {
      generatedAt: new Date(NOW).toISOString(),
      schemaVersion: 6 as const,
      providers: [withQuotaSemantics(provider, new Date(NOW).toISOString())],
    };
    const output = renderQuotaTui(response, { columns: 80 });
    expect(output).toContain("per-window usage");
    expect(output).toContain("no combined bound");
    expect(output).toContain("used 2.5 / 10 credits");
    expect(output).toContain("25% used · 75% remaining");
  });
});
