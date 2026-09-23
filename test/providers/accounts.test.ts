import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annotateQuotaAdvice } from "../../src/advice.js";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { fetchAccountQuotas } from "../../src/providers/accounts.js";
import { staleFromCache } from "../../src/providers/common.js";
import { quotaJsonReport, renderQuotaToon } from "../../src/render.js";
import { renderQuotaTui } from "../../src/tui.js";
import type {
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderSource,
  QuotaWindow,
} from "../../src/types.js";

const OPTIONS: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};

const GENERATED_AT = "2026-07-15T12:00:00.000Z";
const hourMs = 60 * 60 * 1000;
const staleNow = Date.now();
const STALE_EARLIER = new Date(staleNow - 3 * hourMs).toISOString();
const STALE_MIDDLE = new Date(staleNow - 2 * hourMs).toISOString();
const STALE_LATER = new Date(staleNow - hourMs).toISOString();

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let cacheHome: string;

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "quota-axi-accounts-"));
  process.env.XDG_CACHE_HOME = cacheHome;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  rmSync(cacheHome, { recursive: true, force: true });
});

describe("verified subscription coalescing", () => {
  it("reports native and Pi access to the same subscription once beside a distinct one", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live("acct-a", 20, "oauth")],
        ["pi-standard", live("acct-a", 20, "cli")],
        ["pi-work", live("acct-b", 80, "api")],
      ]),
      OPTIONS,
    );

    expect(summarize(reports)).toEqual([
      ["native", "acct-a", "fresh", 20],
      ["pi-work", "acct-b", "fresh", 80],
    ]);
    expect(reports[0]?.windows).toHaveLength(1);
    expect(percentages(reports)).toEqual([20, 80]);
  });

  it("coalesces when a successful response supplies the identity that was missing locally", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live("acct-a", 20, "oauth")],
        ["pi-work", live("acct-a", 20, "cli")],
      ]),
      OPTIONS,
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      accountKey: "native",
      account: { accountId: "acct-a" },
      state: { status: "fresh" },
      windows: [{ percentUsed: 20 }],
    });
  });

  it("keeps a usable sibling when the same subscription's other source is rejected", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", rejected("acct-a", "oauth")],
        ["pi-work", live("acct-a", 20, "cli")],
      ]),
      OPTIONS,
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      accountKey: "pi-work",
      source: "cli",
      account: { accountId: "acct-a" },
      state: { status: "fresh" },
      windows: [{ percentUsed: 20, percentRemaining: 80 }],
    });
    expect(reports[0]?.state.status).not.toBe("auth_required");
    expect(reports[0]?.accountKeys).toEqual(["pi-work", "native"]);
    expect(reports[0]?.attempts?.map((attempt) => attempt.source)).toEqual([
      "oauth",
      "cli",
    ]);
  });

  it("does not guess that a rejected reading without identity shares a live sibling", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", rejected(undefined, "oauth")],
        ["pi-work", live("acct-a", 20, "cli")],
      ]),
      OPTIONS,
    );

    expect(summarize(reports)).toEqual([
      ["native", undefined, "auth_required", undefined],
      ["pi-work", "acct-a", "fresh", 20],
    ]);
  });

  it("does not treat matching email as subscription identity", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live(undefined, 20, "oauth", "same@example.invalid")],
        ["pi-work", live(undefined, 60, "cli", "same@example.invalid")],
      ]),
      OPTIONS,
    );

    expect(reports).toHaveLength(2);
    expect(percentages(reports)).toEqual([20, 60]);
  });

  it("keeps distinct account ids separate even when the email matches", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live("acct-home", 20, "oauth", "same@example.invalid")],
        ["pi-work", live("acct-work", 60, "cli", "same@example.invalid")],
      ]),
      OPTIONS,
    );

    expect(summarize(reports)).toEqual([
      ["native", "acct-home", "fresh", 20],
      ["pi-work", "acct-work", "fresh", 60],
    ]);
  });

  it("leaves unverified identity unmerged", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live("acct-a", 20, "oauth", undefined, "unverified")],
        ["pi-work", live("acct-a", 20, "cli")],
      ]),
      OPTIONS,
    );

    expect(reports).toHaveLength(2);
  });

  it("does not merge two readings that both lack comparable identity", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live(undefined, 20, "oauth")],
        ["pi-work", live(undefined, 20, "cli")],
      ]),
      OPTIONS,
    );

    expect(reports).toHaveLength(2);
  });

  it("never sums duplicated percentages into invented capacity", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live("acct-a", 40, "oauth")],
        ["pi-standard", live("acct-a", 40, "cli")],
      ]),
      OPTIONS,
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]?.windows).toHaveLength(1);
    expect(reports[0]?.windows[0]?.percentUsed).toBe(40);
    expect(reports[0]?.windows[0]?.percentRemaining).toBe(60);
  });

  it("prefers a fresh reading over a stale copy of the same subscription", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", stale("acct-a", 10, "oauth")],
        ["pi-work", live("acct-a", 20, "cli")],
      ]),
      OPTIONS,
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      accountKey: "pi-work",
      source: "cli",
      state: { status: "fresh" },
      windows: [{ percentUsed: 20 }],
    });
  });

  it("serves a coalesced subscription once when every route falls back to cache", async () => {
    writeCachedProviders([
      {
        ...live("acct-a", 20, "oauth", undefined, undefined, "codex"),
        accountKey: "codex-home",
      },
      {
        ...live("acct-a", 20, "cli", undefined, undefined, "codex"),
        accountKey: "openai-codex-work",
      },
      {
        ...live("acct-b", 80, "api", undefined, undefined, "codex"),
        accountKey: "openai-codex-other",
      },
    ]);
    const keys = ["codex-home", "openai-codex-work", "openai-codex-other"];

    const coalesced = await fetchAccountQuotas(
      laneAdapter(keys, (key) =>
        live(
          key === "openai-codex-other" ? "acct-b" : "acct-a",
          key === "openai-codex-other" ? 80 : 25,
          "oauth",
          undefined,
          undefined,
          "codex",
        ),
      ),
      OPTIONS,
    );
    writeCachedProviders(coalesced);
    expect(summarize(coalesced)).toEqual([
      ["codex-home", "acct-a", "fresh", 25],
      ["openai-codex-other", "acct-b", "fresh", 80],
    ]);

    const outage = await fetchAccountQuotas(
      laneAdapter(keys, (key) => {
        const cached = readCachedProvider("codex", key);
        return cached
          ? staleFromCache(cached, "fetch failed", ["oauth", "cache"], [])
          : failed(key);
      }),
      OPTIONS,
    );

    expect(
      outage
        .filter((report) => report.windows.length > 0)
        .map((report) => [
          report.accountKey,
          report.state.status,
          report.windows[0]?.percentUsed,
        ]),
    ).toEqual([
      ["codex-home", "stale", 25],
      ["openai-codex-other", "stale", 80],
    ]);
  });

  it("stores the superseded lane's snapshot only in the cache write that saves the winner", async () => {
    writeCachedProviders([
      {
        ...live("acct-a", 20, "oauth", undefined, undefined, "codex"),
        accountKey: "codex-home",
      },
      {
        ...live("acct-a", 20, "cli", undefined, undefined, "codex"),
        accountKey: "openai-codex-work",
      },
    ]);
    const coalesced = await fetchAccountQuotas(
      laneAdapter(["codex-home", "openai-codex-work"], () =>
        live("acct-a", 25, "oauth", undefined, undefined, "codex"),
      ),
      OPTIONS,
    );
    expect(summarize(coalesced)).toEqual([
      ["codex-home", "acct-a", "fresh", 25],
    ]);
    expect(readCachedProvider("codex", "openai-codex-work")).toBeDefined();

    const published = annotateQuotaAdvice({
      generatedAt: GENERATED_AT,
      providers: coalesced.map((report) =>
        withQuotaSemantics(report, GENERATED_AT),
      ),
    }).providers;

    const cacheDir = join(cacheHome, "quota-axi");
    const blockedTemp = join(cacheDir, `quotas.json.${process.pid}.tmp`);
    mkdirSync(blockedTemp);
    expect(() => writeCachedProviders(published)).toThrow();
    expect(
      readCachedProvider("codex", "openai-codex-work")?.windows[0]?.percentUsed,
    ).toBe(20);
    expect(
      readCachedProvider("codex", "codex-home")?.windows[0]?.percentUsed,
    ).toBe(20);

    rmSync(blockedTemp, { recursive: true });
    writeCachedProviders(published);
    expect(
      readCachedProvider("codex", "openai-codex-work")?.windows[0]?.percentUsed,
    ).toBe(25);
    expect(
      readCachedProvider("codex", "codex-home")?.windows[0]?.percentUsed,
    ).toBe(25);
  });

  it("keeps one card when the superseded route fails on the next run", async () => {
    const keys = ["openai-codex", "openai-codex-2"];
    const coalesced = await fetchAccountQuotas(
      laneAdapter(keys, () =>
        live("acct-a", 25, "oauth", undefined, undefined, "codex"),
      ),
      OPTIONS,
    );
    expect(summarize(coalesced)).toEqual([
      ["openai-codex", "acct-a", "fresh", 25],
    ]);
    writeCachedProviders(coalesced);

    const loserFails = await fetchAccountQuotas(
      laneAdapter(keys, (key) => {
        if (key === "openai-codex")
          return live("acct-a", 30, "oauth", undefined, undefined, "codex");
        const cached = readCachedProvider("codex", key);
        return cached
          ? staleFromCache(cached, "fetch failed", ["oauth", "cache"], [])
          : failed(key);
      }),
      OPTIONS,
    );

    expect(summarize(loserFails)).toEqual([
      ["openai-codex", "acct-a", "fresh", 30],
    ]);
  });

  it("recognises a stale lane as the same subscription as a fresh sibling after a prior coalesce", async () => {
    const keys = ["openai-codex", "openai-codex-2", "openai-codex-other"];
    const accountFor = (key: string) =>
      key === "openai-codex-other" ? "acct-b" : "acct-a";

    const coalesced = await fetchAccountQuotas(
      laneAdapter(keys, (key) =>
        refreshedAt(
          live(
            accountFor(key),
            key === "openai-codex-other" ? 80 : 25,
            "oauth",
            undefined,
            undefined,
            "codex",
          ),
          STALE_EARLIER,
        ),
      ),
      OPTIONS,
    );
    writeCachedProviders(coalesced);
    expect(summarize(coalesced)).toEqual([
      ["openai-codex", "acct-a", "fresh", 25],
      ["openai-codex-other", "acct-b", "fresh", 80],
    ]);
    const cacheFile = readFileSync(
      join(cacheHome, "quota-axi", "quotas.json"),
      "utf8",
    );
    expect(cacheFile).not.toContain("acct-a");
    expect(cacheFile).not.toContain("acct-b");

    const partialOutage = await fetchAccountQuotas(
      laneAdapter(keys, (key) => {
        if (key === "openai-codex-2")
          return refreshedAt(
            live("acct-a", 30, "oauth", undefined, undefined, "codex"),
            STALE_MIDDLE,
          );
        const cached = readCachedProvider("codex", key);
        return cached
          ? staleFromCache(cached, "fetch failed", ["oauth", "cache"], [])
          : failed(key);
      }),
      OPTIONS,
    );

    expect(
      partialOutage.map((report) => [
        report.accountKey,
        report.state.status,
        report.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      ["openai-codex-2", "fresh", 30],
      ["openai-codex-other", "stale", 80],
    ]);
    expect(JSON.stringify(partialOutage)).not.toContain("subscription");
    writeCachedProviders(partialOutage);

    const continuedOutage = await fetchAccountQuotas(
      laneAdapter(keys, (key) => {
        if (key === "openai-codex-2")
          return refreshedAt(
            live("acct-a", 35, "oauth", undefined, undefined, "codex"),
            STALE_LATER,
          );
        const cached = readCachedProvider("codex", key);
        return cached
          ? staleFromCache(cached, "fetch failed", ["oauth", "cache"], [])
          : failed(key);
      }),
      OPTIONS,
    );

    expect(
      continuedOutage.map((report) => [
        report.accountKey,
        report.state.status,
        report.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      ["openai-codex-2", "fresh", 35],
      ["openai-codex-other", "stale", 80],
    ]);
    writeCachedProviders(continuedOutage);

    const fullOutage = await fetchAccountQuotas(
      laneAdapter(keys, (key) => {
        const cached = readCachedProvider("codex", key);
        return cached
          ? staleFromCache(cached, "fetch failed", ["oauth", "cache"], [])
          : failed(key);
      }),
      OPTIONS,
    );

    expect(
      fullOutage.map((report) => [
        report.accountKey,
        report.state.status,
        report.windows[0]?.percentUsed,
        report.state.refreshedAt,
      ]),
    ).toEqual([
      ["openai-codex-2", "stale", 35, STALE_LATER],
      ["openai-codex-other", "stale", 80, STALE_EARLIER],
    ]);
  });

  it("keeps the superseded lane's snapshot when no coalesced reading is fresh", async () => {
    writeCachedProviders([
      {
        ...live("acct-a", 20, "cli", undefined, undefined, "codex"),
        accountKey: "openai-codex-work",
      },
    ]);

    await fetchAccountQuotas(
      laneAdapter(["codex-home", "openai-codex-work"], () => ({
        ...rejected("acct-a", "oauth"),
        provider: "codex",
        label: "Codex",
      })),
      OPTIONS,
    );

    expect(readCachedProvider("codex", "openai-codex-work")).toBeDefined();
  });

  it("publishes the same coalesced lanes to JSON, TOON, and the TUI", async () => {
    const reports = await fetchAccountQuotas(
      adapter([
        ["native", live("acct-a", 20, "oauth")],
        ["pi-standard", live("acct-a", 20, "cli")],
        ["pi-work", live("acct-b", 80, "api")],
      ]),
      OPTIONS,
    );
    const response = annotateQuotaAdvice({
      generatedAt: GENERATED_AT,
      providers: reports.map((report) =>
        withQuotaSemantics(report, GENERATED_AT),
      ),
    });

    expect(response.schemaVersion).toBe(6);
    expect(response.providers.map((provider) => provider.accountKey)).toEqual([
      "native",
      "pi-work",
    ]);

    const json = quotaJsonReport(response, true);
    expect(json.providers.map((provider) => provider.accountKey)).toEqual([
      "native",
      "pi-work",
    ]);
    expect(
      json.providers.map((provider) => provider.account?.accountId),
    ).toEqual(["acct-a", "acct-b"]);

    const toon = renderQuotaToon(response, "/quota-axi", false);
    expect(toon).toContain("native");
    expect(toon).toContain("pi-work");
    expect(toon).not.toContain("pi-standard");

    const tui = renderQuotaTui(response, { columns: 100 });
    expect(tui).toContain("account native");
    expect(tui).toContain("account pi-work");
    expect(tui).not.toContain("account pi-standard");
    expect(tui).not.toContain("sign-in required");
  });

  it("does not expand a single selected account", async () => {
    const reports = await fetchAccountQuotas(
      {
        ...adapter([["native", live("acct-a", 20, "oauth")]]),
        discoverAccounts: undefined,
        async fetchQuota() {
          return live("acct-a", 20, "oauth");
        },
      },
      OPTIONS,
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]?.accountKey).toBeUndefined();
  });
});

function adapter(lanes: [string, ProviderQuota][]): ProviderAdapter {
  return {
    id: "claude",
    label: "Claude",
    async discoverAccounts() {
      return lanes.map(([accountKey, quota]) => ({
        accountKey,
        async fetchQuota() {
          return quota;
        },
        async inspectAuth() {
          return { provider: quota.provider, sources: [] };
        },
      }));
    },
    async fetchQuota() {
      throw new Error("single-lane fetchQuota should not run when lanes exist");
    },
    async inspectAuth() {
      return { provider: "claude", sources: [] };
    },
  };
}

function laneAdapter(
  keys: string[],
  read: (accountKey: string) => ProviderQuota,
): ProviderAdapter {
  return {
    id: "codex",
    label: "Codex",
    async discoverAccounts() {
      return keys.map((accountKey) => ({
        accountKey,
        async fetchQuota() {
          return read(accountKey);
        },
        async inspectAuth() {
          return { provider: "codex", sources: [] };
        },
      }));
    },
    async fetchQuota() {
      throw new Error("single-lane fetchQuota should not run when lanes exist");
    },
    async inspectAuth() {
      return { provider: "codex", sources: [] };
    },
  };
}

function failed(accountKey: string): ProviderQuota {
  return {
    provider: "codex",
    label: "Codex",
    source: "oauth",
    accountKey,
    windows: [],
    state: {
      status: "error",
      stale: false,
      error: "fetch failed",
      sourcesTried: ["oauth"],
    },
  };
}

function live(
  accountId: string | undefined,
  percentUsed: number,
  source: ProviderSource,
  email?: string,
  identityStatus?: "verified" | "unverified",
  provider: "claude" | "codex" = "claude",
): ProviderQuota {
  return {
    provider,
    label: provider === "codex" ? "Codex" : "Claude",
    source,
    account: {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(identityStatus !== undefined ? { identityStatus } : {}),
    },
    windows: [windowAt(percentUsed)],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: STALE_LATER,
      sourcesTried: [source],
    },
    attempts: [{ source, status: "success" }],
  };
}

function refreshedAt(report: ProviderQuota, at: string): ProviderQuota {
  return { ...report, state: { ...report.state, refreshedAt: at } };
}

function stale(
  accountId: string,
  percentUsed: number,
  source: ProviderSource,
): ProviderQuota {
  return {
    ...live(accountId, percentUsed, source),
    source: "cache",
    state: {
      status: "stale",
      stale: true,
      error: "fetch failed",
      sourcesTried: [source, "cache"],
    },
    attempts: [{ source, status: "failed", error: "fetch failed" }],
  };
}

function rejected(
  accountId: string | undefined,
  source: ProviderSource,
): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source,
    account: accountId !== undefined ? { accountId } : undefined,
    windows: [],
    state: {
      status: "auth_required",
      stale: false,
      error: "sign-in required",
      sourcesTried: [source],
    },
    attempts: [{ source, status: "failed", error: "unauthorized" }],
  };
}

function windowAt(percentUsed: number): QuotaWindow {
  return {
    id: "five_hour",
    label: "session",
    kind: "session",
    percentUsed,
    percentRemaining: 100 - percentUsed,
  };
}

function summarize(reports: ProviderQuota[]) {
  return reports.map((report) => [
    report.accountKey,
    report.account?.accountId,
    report.state.status,
    report.windows[0]?.percentUsed,
  ]);
}

function percentages(reports: ProviderQuota[]) {
  return reports.map((report) => report.windows[0]?.percentUsed);
}
