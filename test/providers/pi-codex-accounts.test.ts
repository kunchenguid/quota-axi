import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAccountQuotas,
  inspectAccountAuth,
} from "../../src/providers/accounts.js";
import { quotaJsonReport, renderQuotaToon } from "../../src/render.js";
import { renderQuotaTui } from "../../src/tui.js";
import type { ProviderOptions } from "../../src/types.js";

const originalCodexHome = process.env.CODEX_HOME;
const originalCodexBinary = process.env.QUOTA_AXI_CODEX_BINARY;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

const OPTIONS: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-accounts-"));
  process.env.CODEX_HOME = tempDir;
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  vi.doMock("../../src/lib/process.js", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("../../src/lib/process.js")>();
    return {
      ...actual,
      findCommandPath: vi.fn(async () => undefined),
      terminateChild: vi.fn(),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalCodexBinary === undefined)
    delete process.env.QUOTA_AXI_CODEX_BINARY;
  else process.env.QUOTA_AXI_CODEX_BINARY = originalCodexBinary;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Codex Pi sibling account lanes", () => {
  it("reports personal and work subscriptions independently from one Pi store", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": usage(20, "personal@example.invalid", "acct-personal"),
      "acct-work": usage(80, "work@example.invalid", "acct-work"),
    });

    const { createCodexAdapter: createAdapter } =
      await import("../../src/providers/codex.js");
    const adapter = createAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);

    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(reports[0]).toMatchObject({
      provider: "codex",
      source: "pi:openai-codex",
      account: {
        email: "personal@example.invalid",
        accountId: "acct-personal",
      },
      windows: [{ percentUsed: 20 }],
      accountLocator: {
        kind: "pi-auth",
        entry: "openai-codex",
      },
    });
    expect(reports[1]).toMatchObject({
      provider: "codex",
      source: "pi:openai-codex-work",
      account: { email: "work@example.invalid", accountId: "acct-work" },
      windows: [{ percentUsed: 80 }],
      accountLocator: {
        kind: "pi-auth",
        entry: "openai-codex-work",
      },
    });
    expect(JSON.stringify(reports)).not.toMatch(
      /personal-access-token|work-access-token/,
    );
  });

  it("does not hide a live work account when the personal probe fails", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": new Response("unauthorized", { status: 401 }),
      "acct-work": usage(55, "work@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);

    expect(reports[0]?.state.status).toBe("auth_required");
    expect(reports[0]?.windows).toEqual([]);
    expect(reports[1]).toMatchObject({
      accountKey: "openai-codex-work",
      source: "pi:openai-codex-work",
      windows: [{ percentUsed: 55 }],
      state: { status: "fresh" },
    });
  });

  it("does not present the same ChatGPT account as extra capacity", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-same",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-same",
      }),
    });
    stubUsageByAccount({
      "acct-same": usage(10, "same@example.invalid", "acct-same"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.accountKey).toBeUndefined();
    expect(reports[0]?.source).toBe("pi:openai-codex");
  });

  it("surfaces a work-only sibling instead of classifying it as missing", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-work": usage(40, "work@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.accountKey).toBeUndefined();
    expect(reports[0]).toMatchObject({
      source: "pi:openai-codex-work",
      account: { accountId: "acct-work" },
      windows: [{ percentUsed: 40 }],
    });
  });

  it("keeps the single-account path when only openai-codex is present", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
    });
    stubUsageByAccount({
      "acct-personal": usage(12, "personal@example.invalid", "acct-personal"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    expect(await adapter.discoverAccounts?.()).toBeUndefined();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.accountKey).toBeUndefined();
    expect(reports[0]?.source).toBe("pi:openai-codex");
  });

  it("does not copy sibling numbers onto the legacy single-winner fetch", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": usage(20, "personal@example.invalid", "acct-personal"),
      "acct-work": usage(80, "work@example.invalid", "acct-work"),
    });

    const { fetchQuota: fetchCodexQuota } =
      await import("../../src/providers/codex.js");
    const legacy = await fetchCodexQuota(OPTIONS);
    expect(legacy.accountKey).toBeUndefined();
    expect(legacy.source).toBe("pi:openai-codex");
    expect(legacy.windows[0]?.percentUsed).toBe(20);
  });

  it("publishes distinguishable machine and TUI lanes through the quota command", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": usage(20, "personal@example.invalid", "acct-personal"),
      "acct-work": usage(80, "work@example.invalid", "acct-work"),
    });

    const { fetchQuota } = await import("../../src/commands.js");
    const response = await fetchQuota(["codex"], OPTIONS);
    expect(response.schemaVersion).toBe(6);
    expect(response.providers.map((provider) => provider.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(response.providers[0]?.windows[0]?.percentUsed).toBe(20);
    expect(response.providers[1]?.windows[0]?.percentUsed).toBe(80);

    const json = quotaJsonReport(response, true);
    expect(json.providers[0]?.accountLocator?.entry).toBe("openai-codex");
    expect(json.providers[1]?.accountLocator?.entry).toBe("openai-codex-work");
    expect(JSON.stringify(json)).not.toMatch(
      /personal-access-token|work-access-token/,
    );

    const toon = renderQuotaToon(response, "/quota-axi", false);
    expect(toon).toContain("openai-codex-work");
    expect(toon).toMatch(/quota\[.*accountKey/);

    const tui = renderQuotaTui(response, { columns: 100 });
    expect(tui).toContain("account openai-codex");
    expect(tui).toContain("account openai-codex-work");

    const compact = quotaJsonReport(response, false);
    expect(compact.providers.map((provider) => provider.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(compact.providers[0]?.account).toBeUndefined();
    expect(compact.providers[0]?.accountLocator).toBeUndefined();
    expect(JSON.stringify(compact)).not.toMatch(
      /personal-access-token|work-access-token/,
    );
  });

  it("keeps an identity-unconfirmed sibling as its own lane", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": {
        type: "oauth",
        access: "work-access-token",
        expires: Date.now() + 3_600_000,
      },
    });
    stubUsageByAccount({
      "acct-personal": usage(20, "personal@example.invalid", "acct-personal"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);

    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      accountKey: "openai-codex",
      windows: [{ percentUsed: 20 }],
    });
    expect(reports[1]).toMatchObject({
      accountKey: "openai-codex-work",
      source: "pi:openai-codex-work",
      windows: [],
    });
    expect(reports[1]?.state.status).not.toBe("fresh");
  });

  it("does not treat one account's exhaustion as the other's remaining capacity", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": usage(100, "personal@example.invalid", "acct-personal"),
      "acct-work": usage(10, "work@example.invalid", "acct-work"),
    });

    const { fetchQuota } = await import("../../src/commands.js");
    const response = await fetchQuota(["codex"], OPTIONS);
    expect(response.providers[0]?.windows[0]?.percentUsed).toBe(100);
    expect(response.providers[1]?.windows[0]?.percentUsed).toBe(10);
    const remaining = response.providers.map(
      (provider) =>
        provider.quotaSemantics?.effectiveAvailability[0]
          ?.effectivePercentRemaining,
    );
    expect(remaining[0]).toBe(0);
    expect(remaining[1]).toBe(90);
    expect(remaining[0]! + remaining[1]!).not.toBe(
      response.providers[0]?.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    );
  });

  it("discloses missing vendor identity instead of inventing it", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": usage(20, undefined, undefined),
      "acct-work": usage(80, "work@example.invalid", "acct-work"),
    });

    const { fetchQuota } = await import("../../src/commands.js");
    const response = await fetchQuota(["codex"], OPTIONS);
    const json = quotaJsonReport(response, true);
    expect(json.providers[0]?.account?.email).toBeUndefined();
    expect(json.providers[0]?.account?.accountId).toBeUndefined();
    expect(json.providers[0]?.account?.identityStatus).toBeUndefined();
    expect(json.providers[1]?.account).toMatchObject({
      email: "work@example.invalid",
      accountId: "acct-work",
    });
  });

  it("inspects sibling Pi sources independently without combining them", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await inspectAccountAuth(adapter, OPTIONS);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(reports[0]?.sources).toEqual([
      expect.objectContaining({
        source: "pi:openai-codex",
        status: "available",
      }),
    ]);
    expect(reports[1]?.sources).toEqual([
      expect.objectContaining({
        source: "pi:openai-codex-work",
        status: "available",
      }),
    ]);
    expect(JSON.stringify(reports)).not.toMatch(
      /personal-access-token|work-access-token/,
    );
  });

  it("does not open Pi sibling lanes under --profile-only", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": usage(20, "personal@example.invalid", "acct-personal"),
      "acct-work": usage(80, "work@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, {
      ...OPTIONS,
      credentialMode: "profile-only",
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.accountKey).toBeUndefined();
    expect(reports[0]?.source).not.toMatch(/^pi:/);
  });

  it("does not serve one account's cached windows as another's stale fallback", async () => {
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([
      {
        provider: "codex",
        accountKey: "openai-codex",
        label: "Codex",
        source: "pi:openai-codex",
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentUsed: 20,
            windowSeconds: 604_800,
          },
        ],
        state: {
          status: "fresh",
          stale: false,
          sourcesTried: ["pi:openai-codex"],
        },
      },
    ]);
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByAccount({
      "acct-personal": new Response("unauthorized", { status: 401 }),
      "acct-work": usage(80, "work@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports[0]?.windows[0]?.percentUsed).toBe(20);
    expect(reports[0]?.state.stale).toBe(true);
    expect(reports[1]).toMatchObject({
      accountKey: "openai-codex-work",
      windows: [{ percentUsed: 80 }],
      state: { status: "fresh", stale: false },
    });
  });
});

function writePiAuth(store: Record<string, unknown>): void {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
    JSON.stringify(store),
    { mode: 0o600 },
  );
}

function piOauthEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth",
    access: "pi-fixture-access-token",
    refresh: "pi-fixture-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "acct-pi-fixture",
    ...overrides,
  };
}

function usage(
  usedPercent: number,
  email: string | undefined,
  accountId: string | undefined,
): Response {
  return new Response(
    JSON.stringify({
      plan_type: "plus",
      ...(email ? { email } : {}),
      ...(accountId ? { account_id: accountId } : {}),
      rate_limit: {
        primary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 604_800,
          reset_after_seconds: 1_000,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubUsageByAccount(responses: Record<string, Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
      const response = accountId ? responses[accountId] : undefined;
      if (!response) return new Response("not found", { status: 404 });
      return response.clone();
    }),
  );
}
