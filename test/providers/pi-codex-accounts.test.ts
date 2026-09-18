import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
  vi.doUnmock("node:child_process");
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
    });
    expect(reports[1]).toMatchObject({
      provider: "codex",
      source: "pi:openai-codex-work",
      account: { email: "work@example.invalid", accountId: "acct-work" },
      windows: [{ percentUsed: 80 }],
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

  it("uses a later Pi sibling when the first same-account token is rejected", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "rejected-personal-access-token",
        accountId: "acct-same",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-same",
      }),
    });
    stubUsageByToken({
      "rejected-personal-access-token": new Response("unauthorized", {
        status: 401,
      }),
      "work-access-token": usage(20, "same@example.invalid", "acct-same"),
    });

    const { fetchQuota } = await import("../../src/commands.js");
    const response = await fetchQuota(["codex"], OPTIONS);
    expect(response.providers).toHaveLength(1);
    expect(response.providers[0]).toMatchObject({
      source: "pi:openai-codex-work",
      account: { accountId: "acct-same" },
      state: { status: "fresh" },
      windows: [{ percentUsed: 20, percentRemaining: 80 }],
    });
    expect(response.providers[0]?.state.status).not.toBe("auth_required");
    const json = quotaJsonReport(response, true);
    expect(json.providers.map((provider) => provider.source)).toEqual([
      "pi:openai-codex-work",
    ]);
    const tui = renderQuotaTui(response, { columns: 100 });
    expect(tui).not.toContain("sign-in required");
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
    expect(json.providers.map((provider) => provider.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(json.providers[0]?.account?.accountId).toBe("acct-personal");
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

  it("keeps a native Codex login as its own lane beside Pi siblings", async () => {
    writeNativeAuth("native-access-token", "acct-native");
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
    stubUsageByToken({
      "native-access-token": usage(5, "native@example.invalid", "acct-native"),
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(
      reports.map((report) => [
        report.accountKey,
        report.source,
        report.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      ["codex-home", "oauth", 5],
      ["openai-codex", "pi:openai-codex", 20],
      ["openai-codex-work", "pi:openai-codex-work", 80],
    ]);

    const auth = await inspectAccountAuth(adapter, OPTIONS);
    expect(auth[0]).toMatchObject({ accountKey: "codex-home" });
    expect(auth[0]?.sources.map((source) => source.source)).toEqual([
      "auth-json",
      "cli-rpc",
    ]);
  });

  it("reads a usable native login instead of its expired Pi copy", async () => {
    writeNativeAuth("native-access-token", "acct-personal");
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "expired-personal-access-token",
        accountId: "acct-personal",
        expires: Date.now() - 3_600_000,
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "native-access-token": usage(
        30,
        "personal@example.invalid",
        "acct-personal",
      ),
      "expired-personal-access-token": new Response("unauthorized", {
        status: 401,
      }),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      accountKey: "codex-home",
      source: "oauth",
      windows: [{ percentUsed: 30 }],
      state: { status: "fresh" },
    });
    expect(reports[1]).toMatchObject({
      accountKey: "openai-codex-work",
      windows: [{ percentUsed: 80 }],
    });
  });

  it("falls back to the same account's Pi copy when the native login is rejected", async () => {
    writeNativeAuth("rejected-native-access-token", "acct-personal");
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
    stubUsageByToken({
      "rejected-native-access-token": new Response("unauthorized", {
        status: 401,
      }),
      "personal-access-token": usage(
        30,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "codex-home",
      "openai-codex-work",
    ]);
    expect(reports[0]).toMatchObject({
      source: "pi:openai-codex",
      windows: [{ percentUsed: 30 }],
    });
  });

  it("coalesces a native login without a stored account id into the matching Pi lane", async () => {
    process.env.QUOTA_AXI_CODEX_BINARY = join(tempDir!, "missing-codex");
    writeNativeAuth("native-access-token");
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-same",
      }),
    });
    stubUsageByToken({
      "native-access-token": usage(20, "same@example.invalid", "acct-same"),
      "work-access-token": usage(20, "same@example.invalid", "acct-same"),
    });

    const { fetchQuota } = await import("../../src/commands.js");
    const response = await fetchQuota(["codex"], OPTIONS);
    expect(response.providers).toHaveLength(1);
    expect(response.providers[0]).toMatchObject({
      accountKey: "openai-codex-work",
      account: { accountId: "acct-same" },
      state: { status: "fresh" },
      windows: [{ percentUsed: 20, percentRemaining: 80 }],
    });

    const json = quotaJsonReport(response, true);
    expect(
      json.providers.map((provider) => provider.account?.accountId),
    ).toEqual(["acct-same"]);
    const tui = renderQuotaTui(response, { columns: 100 });
    expect(tui).toContain("account openai-codex-work");
    expect(tui).not.toContain("account codex-home");
  });

  it("shows the live Pi sibling when the same account's native login is rejected", async () => {
    process.env.QUOTA_AXI_CODEX_BINARY = join(tempDir!, "missing-codex");
    writeNativeAuth("rejected-native-access-token", "acct-same");
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-same",
      }),
    });
    stubUsageByToken({
      "rejected-native-access-token": new Response("unauthorized", {
        status: 401,
      }),
      "work-access-token": usage(20, "same@example.invalid", "acct-same"),
    });

    const { fetchQuota } = await import("../../src/commands.js");
    const response = await fetchQuota(["codex"], OPTIONS);
    expect(response.providers).toHaveLength(1);
    expect(response.providers[0]).toMatchObject({
      accountKey: "openai-codex-work",
      source: "pi:openai-codex-work",
      account: { accountId: "acct-same" },
      state: { status: "fresh" },
      windows: [{ percentUsed: 20, percentRemaining: 80 }],
    });

    const json = quotaJsonReport(response, true);
    expect(json.providers.map((provider) => provider.state.status)).toEqual([
      "fresh",
    ]);
    const tui = renderQuotaTui(response, { columns: 100 });
    expect(tui).toContain("account openai-codex-work");
    expect(tui).not.toContain("account codex-home");
  });

  it("keeps a native login and a Pi sibling for different accounts as two lanes", async () => {
    process.env.QUOTA_AXI_CODEX_BINARY = join(tempDir!, "missing-codex");
    writeNativeAuth("native-access-token");
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "native-access-token": usage(20, "same@example.invalid", "acct-home"),
      "work-access-token": usage(60, "same@example.invalid", "acct-work"),
    });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(
      reports.map((report) => [
        report.accountKey,
        report.account?.accountId,
        report.state.status,
        report.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      ["codex-home", "acct-home", "fresh", 20],
      ["openai-codex-work", "acct-work", "fresh", 60],
    ]);
  });

  it("keeps a CLI-only Codex login beside a work-only Pi sibling", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    const spawn = mockCodexCli({ accountId: "acct-cli", usedPercent: 15 });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(
      reports.map((report) => [
        report.accountKey,
        report.source,
        report.state.status,
        report.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      ["codex-home", "cli-rpc", "fresh", 15],
      ["openai-codex-work", "pi:openai-codex-work", "fresh", 80],
    ]);
    expect(spawn).toHaveBeenCalledOnce();

    const auth = await inspectAccountAuth(adapter, OPTIONS);
    expect(
      auth[0]?.sources.map((source) => [source.source, source.status]),
    ).toEqual([
      ["auth-json", "missing"],
      ["cli-rpc", "available"],
    ]);
  });

  it("opens no CLI lane when the Codex CLI fallback is unavailable", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    const spawn = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn }));

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: "pi:openai-codex-work",
      windows: [{ percentUsed: 80 }],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("renders no lane for an installed but logged-out Codex CLI", async () => {
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
    stubUsageByToken({
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    const spawn = mockCodexCli("signed-out");

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(spawn).toHaveBeenCalledOnce();
    expect(
      reports.map((report) => [report.accountKey, report.state.status]),
    ).toEqual([
      ["openai-codex", "fresh"],
      ["openai-codex-work", "fresh"],
    ]);
  });

  it("keeps a CLI-only reading whose backend omits the optional accountId", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    mockCodexCli({ usedPercent: 15 });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "codex-home",
      "openai-codex-work",
    ]);
    expect(reports[0]).toMatchObject({
      source: "cli-rpc",
      windows: [{ percentUsed: 15 }],
      state: { status: "fresh" },
    });
    expect(reports[0]?.account?.accountId).toBeUndefined();
  });

  it("keeps an established CLI lane stale when its probe cannot be reached", async () => {
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([
      {
        provider: "codex",
        accountKey: "codex-home",
        label: "Codex",
        source: "cli-rpc",
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentUsed: 42,
            windowSeconds: 604_800,
          },
        ],
        state: { status: "fresh", stale: false, sourcesTried: ["cli-rpc"] },
      },
    ]);
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    mockCodexCli("unreachable");

    vi.resetModules();
    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "codex-home",
      "openai-codex-work",
    ]);
    expect(reports[0]).toMatchObject({
      windows: [{ percentUsed: 42 }],
      state: { status: "stale", stale: true },
    });
  });

  it("never revives a cached CLI account after a confirmed logout", async () => {
    await writeCodexHomeSnapshot(42);
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    mockCodexCli("signed-out");
    const signedOut = await readCodexLanes();
    expect(signedOut.map((report) => report.accountKey)).toEqual([
      "openai-codex-work",
    ]);

    mockCodexCli("unreachable");
    const unreachable = await readCodexLanes();
    expect(unreachable.map((report) => report.accountKey)).toEqual([
      "openai-codex-work",
    ]);
    expect(
      unreachable.some((report) => report.windows[0]?.percentUsed === 42),
    ).toBe(false);
  });

  it("never revives a cached CLI account after it coalesces into a Pi lane", async () => {
    await writeCodexHomeSnapshot(42);
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    mockCodexCli({ accountId: "acct-work", usedPercent: 80 });
    const coalesced = await readCodexLanes();
    expect(coalesced.map((report) => report.accountKey)).toEqual([
      "openai-codex-work",
    ]);

    mockCodexCli("unreachable");
    const unreachable = await readCodexLanes();
    expect(unreachable.map((report) => report.accountKey)).toEqual([
      "openai-codex-work",
    ]);
    expect(
      unreachable.some((report) => report.windows[0]?.percentUsed === 42),
    ).toBe(false);
  });

  it("reports every lane unchanged when retiring the CLI snapshot fails", async () => {
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
    stubUsageByToken({
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": new Response("unauthorized", { status: 401 }),
    });
    vi.doMock("../../src/cache.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/cache.js")>()),
      deleteCachedProvider: vi.fn(() => {
        throw new Error("read-only cache");
      }),
    }));

    try {
      for (const fixture of ["signed-out", "coalesced"] as const) {
        mockCodexCli(
          fixture === "signed-out"
            ? "signed-out"
            : { accountId: "acct-personal", usedPercent: 20 },
        );
        const reports = await readCodexLanes();
        expect(
          reports.map((report) => [report.accountKey, report.state.status]),
        ).toEqual([
          ["openai-codex", "fresh"],
          ["openai-codex-work", "auth_required"],
        ]);
      }
    } finally {
      vi.doUnmock("../../src/cache.js");
    }
  });

  it("adds no CLI lane when the probe fails before any account evidence", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    const spawn = mockCodexCli("unreachable");

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(spawn).toHaveBeenCalledOnce();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      accountKey: "openai-codex-work",
      windows: [{ percentUsed: 80 }],
    });

    const auth = await inspectAccountAuth(adapter, OPTIONS);
    expect(
      auth[0]?.sources.find((source) => source.source === "cli-rpc"),
    ).toMatchObject({ status: "available" });
  });

  it("discloses a confirmed CLI login whose quota read fails", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    mockCodexCli("limits-fail");

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "codex-home",
      "openai-codex-work",
    ]);
    expect(reports[0]?.windows).toEqual([]);
    expect(reports[0]?.state.status).not.toBe("fresh");
  });

  it("keeps the remaining Pi lane keyed when the CLI is signed out", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    mockCodexCli("signed-out");

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      accountKey: "openai-codex-work",
      windows: [{ percentUsed: 80 }],
    });
  });

  it("coalesces a CLI login with the fresh Pi lane for the same account", async () => {
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
    stubUsageByToken({
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    mockCodexCli({ accountId: "acct-work", usedPercent: 80 });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(
      reports.map((report) => [
        report.accountKey,
        report.source,
        report.state.status,
      ]),
    ).toEqual([
      ["openai-codex", "pi:openai-codex", "fresh"],
      ["openai-codex-work", "pi:openai-codex-work", "fresh"],
    ]);
  });

  it("keeps the usable CLI reading when the same account's Pi copy is expired", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "expired-work-access-token",
        accountId: "acct-work",
        expires: Date.now() - 3_600_000,
      }),
    });
    stubUsageByToken({
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "expired-work-access-token": new Response("unauthorized", {
        status: 401,
      }),
    });
    mockCodexCli({ accountId: "acct-work", usedPercent: 35 });

    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(reports[1]).toMatchObject({
      source: "cli-rpc",
      windows: [{ percentUsed: 35 }],
      state: { status: "fresh" },
    });
    expect(reports[1]?.state.sourcesTried).toContain("pi:openai-codex-work");
  });

  it("keeps the usable CLI reading when the same account's Pi lane is stale", async () => {
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([
      {
        provider: "codex",
        accountKey: "openai-codex-work",
        label: "Codex",
        source: "pi:openai-codex-work",
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentUsed: 90,
            windowSeconds: 604_800,
          },
        ],
        state: {
          status: "fresh",
          stale: false,
          sourcesTried: ["pi:openai-codex-work"],
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
    stubUsageByToken({
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": new Response("slow down", { status: 429 }),
    });
    mockCodexCli({ accountId: "acct-work", usedPercent: 35 });

    vi.resetModules();
    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const reports = await fetchAccountQuotas(adapter, OPTIONS);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({
      accountKey: "openai-codex-work",
      source: "cli-rpc",
      windows: [{ percentUsed: 35 }],
      state: { status: "fresh", stale: false },
    });
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

  it("reuses the sole lane's own cached reading when its probe fails", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-personal",
      }),
    });
    stubUsageByToken({
      "personal-access-token": usage(
        30,
        "personal@example.invalid",
        "acct-personal",
      ),
    });

    const first = await cacheCodexRead();
    expect(first).toHaveLength(1);
    expect(first[0]?.accountKey).toBeUndefined();
    expect(first[0]?.windows[0]?.percentUsed).toBe(30);

    stubUsageByToken({});
    const second = await readCodexLanes();
    expect(second).toHaveLength(1);
    expect(second[0]?.accountKey).toBeUndefined();
    expect(second[0]).toMatchObject({
      windows: [{ percentUsed: 30 }],
      state: { status: "stale", stale: true },
    });
  });

  it("reuses the native lane's snapshot when its folded Pi copy fails transiently", async () => {
    writeNativeAuth("native-access-token", "acct-personal");
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "pi-personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "native-access-token": usage(
        10,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    const first = await cacheCodexRead();
    expect(
      first.map((report) => [
        report.accountKey,
        report.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      ["codex-home", 10],
      ["openai-codex-work", 80],
    ]);

    stubUsageByToken({
      "native-access-token": new Response("unauthorized", { status: 401 }),
      "pi-personal-access-token": new Response("unavailable", { status: 503 }),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });
    const second = await readCodexLanes();
    expect(second[0]).toMatchObject({
      accountKey: "codex-home",
      windows: [{ percentUsed: 10 }],
      state: { status: "stale", stale: true },
    });
    expect(second[1]).toMatchObject({
      accountKey: "openai-codex-work",
      windows: [{ percentUsed: 80 }],
      state: { status: "fresh", stale: false },
    });
  });

  it("reports the usable lane instead of failing when a Pi key cannot be a lane key", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      [`openai-codex-${"w".repeat(90)}`]: piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    const reports = await readCodexLanes();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.accountKey).toBeUndefined();
    expect(reports[0]).toMatchObject({
      source: "pi:openai-codex",
      windows: [{ percentUsed: 20 }],
      state: { status: "fresh" },
    });
  });

  it("keeps the valid sibling lanes when one Pi key cannot be a lane key", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "personal-access-token",
        accountId: "acct-personal",
      }),
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
      [`openai-codex-${"o".repeat(90)}`]: piOauthEntry({
        access: "other-access-token",
        accountId: "acct-other",
      }),
    });
    stubUsageByToken({
      "personal-access-token": usage(
        20,
        "personal@example.invalid",
        "acct-personal",
      ),
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
      "other-access-token": usage(50, "other@example.invalid", "acct-other"),
    });

    const reports = await readCodexLanes();
    expect(
      reports.map((report) => [
        report.accountKey,
        report.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      ["openai-codex", 20],
      ["openai-codex-work", 80],
    ]);
  });

  it("never serves a replaced sole account's cached windows under the next one", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-work",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-work"),
    });

    const first = await cacheCodexRead();
    expect(first).toHaveLength(1);
    expect(first[0]?.accountKey).toBeUndefined();
    expect(first[0]?.windows[0]?.percentUsed).toBe(80);

    // The Pi sibling is gone and this machine now holds one native login for
    // another ChatGPT account, whose probe fails.
    rmSync(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"));
    writeNativeAuth("native-access-token", "acct-other");
    stubUsageByToken({
      "native-access-token": new Response("unavailable", { status: 503 }),
    });

    const second = await readCodexLanes();
    expect(second).toHaveLength(1);
    expect(second[0]?.accountKey).toBeUndefined();
    expect(second[0]?.windows).toEqual([]);
    expect(second[0]?.state.stale).toBe(false);
  });

  it("keeps stale windows when the vendor account id differs from the stored one", async () => {
    writePiAuth({
      "openai-codex-work": piOauthEntry({
        access: "work-access-token",
        accountId: "acct-stored",
      }),
    });
    stubUsageByToken({
      "work-access-token": usage(80, "work@example.invalid", "acct-vendor"),
    });

    const first = await cacheCodexRead();
    expect(first).toHaveLength(1);
    expect(first[0]?.account?.accountId).toBe("acct-vendor");
    expect(first[0]?.windows[0]?.percentUsed).toBe(80);

    stubUsageByToken({
      "work-access-token": new Response("unavailable", { status: 503 }),
    });

    const second = await readCodexLanes();
    expect(second).toHaveLength(1);
    expect(second[0]?.state.stale).toBe(true);
    expect(second[0]?.windows[0]?.percentUsed).toBe(80);
  });

  it("never serves an untried Pi entry's cached windows for a native probe that failed", async () => {
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "pi-access-token",
        accountId: "acct-b",
      }),
    });
    stubUsageByToken({
      "pi-access-token": usage(40, "b@example.invalid", "acct-b"),
    });

    const first = await cacheCodexRead();
    expect(first).toHaveLength(1);
    expect(first[0]?.source).toBe("pi:openai-codex");
    expect(first[0]?.windows[0]?.percentUsed).toBe(40);

    // A native login for another account now outranks B's Pi entry. Its probe
    // gets no answer, so B's credential is never tried and cannot vouch for
    // the snapshot it filled.
    writeNativeAuth("native-access-token", "acct-a");
    stubUsageByToken({
      "native-access-token": new Response("unavailable", { status: 503 }),
      "pi-access-token": usage(40, "b@example.invalid", "acct-b"),
    });

    const second = await readCodexLanes();
    expect(second).toHaveLength(1);
    expect(second[0]?.source).toBe("oauth");
    expect(second[0]?.state.stale).toBe(false);
    expect(second[0]?.windows).toEqual([]);
  });
  it("never serves a rejected native login's cached windows for a Pi probe that failed", async () => {
    writeNativeAuth("native-access-token", "acct-a");
    stubUsageByToken({
      "native-access-token": usage(10, "a@example.invalid", "acct-a"),
    });

    const first = await cacheCodexRead();
    expect(first).toHaveLength(1);
    expect(first[0]?.source).toBe("oauth");
    expect(first[0]?.windows[0]?.percentUsed).toBe(10);

    // A's login is now signed out and B's Pi entry answers for this reading,
    // but its probe gets no answer.
    writePiAuth({
      "openai-codex": piOauthEntry({
        access: "pi-access-token",
        accountId: "acct-b",
      }),
    });
    stubUsageByToken({
      "native-access-token": new Response("unauthorized", { status: 401 }),
      "pi-access-token": new Response("unavailable", { status: 503 }),
    });

    const second = await readCodexLanes();
    expect(second).toHaveLength(1);
    expect(second[0]?.source).toBe("pi:openai-codex");
    expect(second[0]?.state.stale).toBe(false);
    expect(second[0]?.windows).toEqual([]);
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

async function writeCodexHomeSnapshot(percentUsed: number): Promise<void> {
  const { writeCachedProviders } = await import("../../src/cache.js");
  writeCachedProviders([
    {
      provider: "codex",
      accountKey: "codex-home",
      label: "Codex",
      source: "cli-rpc",
      windows: [
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed,
          windowSeconds: 604_800,
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["cli-rpc"] },
    },
  ]);
}

async function readCodexLanes() {
  vi.resetModules();
  const adapter = (
    await import("../../src/providers/codex.js")
  ).createCodexAdapter();
  return fetchAccountQuotas(adapter, OPTIONS);
}

/**
 * The quota command's own path: it copies every report through
 * `withQuotaSemantics` and `annotateQuotaAdvice` before caching it, so a stamp
 * bound to the adapter's object alone never reaches the cache writer.
 */
async function cacheCodexRead() {
  vi.resetModules();
  const { fetchQuota } = await import("../../src/commands.js");
  const { writeCachedProviders } = await import("../../src/cache.js");
  const response = await fetchQuota(["codex"], OPTIONS);
  writeCachedProviders(response.providers);
  return response.providers;
}

function writeNativeAuth(accessToken: string, accountId?: string): void {
  writeFileSync(
    join(process.env.CODEX_HOME!, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: accessToken,
        ...(accountId ? { account_id: accountId } : {}),
      },
    }),
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

function stubUsageByToken(responses: Record<string, Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const token = new Headers(init?.headers)
        .get("authorization")
        ?.replace(/^Bearer /, "");
      const response = token ? responses[token] : undefined;
      if (!response) return new Response("not found", { status: 404 });
      return response.clone();
    }),
  );
}

type CodexCliFixture =
  | { accountId?: string; usedPercent: number }
  | "signed-out"
  | "limits-fail"
  | "unreachable";

function mockCodexCli(fixture: CodexCliFixture) {
  vi.doMock("../../src/lib/process.js", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("../../src/lib/process.js")>();
    return {
      ...actual,
      findCommandPath: vi.fn(async (command: string) =>
        command === "codex" ? "/fixture/bin/codex" : undefined,
      ),
      terminateChild: vi.fn(),
    };
  });
  const spawn = vi.fn(() => codexCliChild(fixture));
  vi.doMock("node:child_process", () => ({ spawn }));
  return spawn;
}

/** Responses shaped like codex app-server v2 GetAccountResponse and GetAccountRateLimitsResponse. */
function codexCliChild(
  fixture: CodexCliFixture,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  if (fixture === "unreachable") {
    queueMicrotask(() => child.emit("close", 1));
    return child;
  }
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id: number; method: string };
      let reply: Record<string, unknown> = { result: {} };
      if (request.method === "account/read") {
        reply = {
          result:
            fixture === "signed-out"
              ? { account: null, requiresOpenaiAuth: true }
              : {
                  account: {
                    type: "chatgpt",
                    email: "cli@example.invalid",
                    planType: "plus",
                  },
                  requiresOpenaiAuth: true,
                },
        };
      } else if (request.method === "account/rateLimits/read") {
        reply =
          fixture === "signed-out"
            ? { error: { code: -32600, message: "not signed in" } }
            : fixture === "limits-fail"
              ? { error: { code: -32603, message: "usage unavailable" } }
              : {
                  result: {
                    ...(fixture.accountId
                      ? { accountId: fixture.accountId }
                      : {}),
                    rateLimits: {
                      primary: {
                        usedPercent: fixture.usedPercent,
                        windowDurationMins: 10_080,
                      },
                    },
                  },
                };
      }
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      });
    }
  });
  return child;
}
