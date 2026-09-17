import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../src/types.js";

let home: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const options: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};
const now = "2026-09-15T10:00:00.000Z";

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "quota-accounts-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("USER", "fixture-user");
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.doMock("../src/lib/process.js", () => ({
    execFileText: vi.fn(async () => {
      throw new Error("unexpected process boundary");
    }),
  }));
  vi.doMock(
    "../src/providers/delegated-refresh.js",
    async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("../src/providers/delegated-refresh.js")
      >()),
      runRefreshDelegate: vi.fn(async () => {
        throw new Error("unexpected refresh");
      }),
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("authorization")!;
      if (_url.endsWith("/profile")) {
        return new Response(
          JSON.stringify({
            account: {
              uuid: token.endsWith("personal") ? "account-one" : "account-two",
              email: "private@example.invalid",
            },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: token.endsWith("personal") ? 20 : 80,
            resets_at: "2026-09-15T12:00:00Z",
          },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("../src/lib/process.js");
  vi.doUnmock("../src/providers/delegated-refresh.js");
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

function credential(name: string, token: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: token, subscriptionType: "pro" },
    }),
  );
  return dir;
}

async function modelsJson(args: string[]) {
  const { modelsCommand } = await import("../src/commands.js");
  return modelsCommand(
    ["--provider", "claude", "--json", "--no-credential-refresh", ...args],
    undefined,
  );
}

async function command(args: string[] = []) {
  const { quotaCommand } = await import("../src/commands.js");
  return quotaCommand(
    ["--provider", "claude", "--no-credential-refresh", ...args],
    undefined,
  );
}

function bearerTokens(): (string | null)[] {
  return (
    vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][]
  ).map(([, init]) => new Headers(init.headers).get("authorization"));
}

function response(text: string): {
  schemaVersion: number;
  providers: ProviderQuota[];
  help?: string[];
} {
  return JSON.parse(text);
}

function mockMacKeychain(services: Map<string, string>) {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  const exec = vi.fn(async (command: string, args: string[]) => {
    expect(command).toBe("security");
    if (args[0] === "list-keychains")
      return '    "/fixture/login.keychain-db"\n';
    if (args[0] === "dump-keychain")
      return [...services.keys()]
        .map(
          (service) =>
            `keychain: "/fixture/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="fixture-user"\n    "svce"<blob>="${service}"\n`,
        )
        .join("");
    expect(args[0]).toBe("find-generic-password");
    expect(args).toContain("fixture-user");
    const service = args[args.indexOf("-s") + 1];
    if (!services.has(service))
      throw Object.assign(new Error("unreachable"), { code: 44 });
    return args.includes("-w")
      ? JSON.stringify({
          claudeAiOauth: { accessToken: services.get(service) },
        })
      : "present";
  });
  vi.doMock("../src/lib/process.js", () => ({ execFileText: exec }));
  return exec;
}

describe("independent account reporting", () => {
  it("keeps the single-account JSON, TOON, and TUI byte-compatible", async () => {
    credential(".claude", "synthetic-personal");
    const { PROVIDERS } = await import("../src/providers/index.js");
    const original = PROVIDERS.claude;
    const discovered = await Promise.all([
      command(["--json"]),
      command(),
      command(["--tui", "--once"]),
    ]);
    PROVIDERS.claude = { ...original, discoverAccounts: undefined };
    try {
      expect(
        await Promise.all([
          command(["--json"]),
          command(),
          command(["--tui", "--once"]),
        ]),
      ).toEqual(discovered);
      expect(response(discovered[0]).schemaVersion).toBe(5);
      expect(discovered.join("\n")).not.toContain("accountKey");
    } finally {
      PROVIDERS.claude = original;
    }
  });

  it("reports both profiles, independent windows and selection, with stable non-secret keys", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    mkdirSync(join(home, ".claude-unrelated"));
    const first = response(await command(["--json"]));
    expect(first.schemaVersion).toBe(6);
    expect(first.providers).toHaveLength(2);
    expect(first.providers.map((p) => p.windows[0].percentRemaining)).toEqual([
      80, 20,
    ]);
    const keys = first.providers.map((p) => p.accountKey);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(/^profile:[a-f0-9]{24}$/);
    const scopes = first.providers.map(
      (p) => p.quotaSemantics!.effectiveAvailability[0],
    );
    expect(scopes[0].selection?.spendPriority).not.toBe(
      scopes[1].selection?.spendPriority,
    );
    expect(JSON.stringify(first)).not.toMatch(
      /private@example|synthetic-|\.claude|accountLocator/,
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    const reordered = response(await command(["--json"]));
    expect(reordered.providers.map((p) => p.accountKey)).toEqual(
      [...keys].reverse(),
    );
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(work);
    const full = response(await command(["--full", "--json"]));
    expect(full.providers[0].accountLocator?.path).toBe(work);
    expect(full.providers[0].account?.email).toBe("private@example.invalid");
    const toon = await command(["--full"]);
    for (const block of [
      "quota",
      "exhaustion",
      "providers",
      "windows",
      "scopeAudit",
      "accounts",
      "attempts",
    ]) {
      if (new RegExp(`${block}\\[[1-9]`).test(toon))
        expect(toon).toMatch(
          new RegExp(`${block}\\[\\d+\\]\\{provider,accountKey,`),
        );
    }
    const tui = await command(["--tui", "--once"]);
    for (const key of keys) expect(tui).toContain(`account ${key}`);
    expect(tui).not.toContain(work);
  });

  it("keeps an unreadable profile's auth_required row beside a healthy one", async () => {
    credential(".claude", "synthetic-personal");
    const work = join(home, ".claude-work");
    mkdirSync(join(work, ".credentials.json"), { recursive: true });
    const output = response(await command(["--json"]));
    expect(output.providers.map((p) => p.state.status)).toEqual([
      "fresh",
      "auth_required",
    ]);
    expect(output.providers[1].accountKey).toBeDefined();
    const toon = await command();
    expect(toon).toMatch(
      /attention\[\d+\]\{provider,accountKey,scope,kind,detail,remedy\}/,
    );
    expect(toon).toContain(output.providers[1].accountKey!);
    expect(process.exitCode).toBeUndefined();
    // The sibling reauth remedy names the lane's config directory, so it is
    // demoted to `--full` with the rest of the account evidence.
    expect(output.providers[1].state.reason).toBe("credentials_expired");
    expect(output.providers[1].state.remedyCommand).toBeUndefined();
    for (const ordinary of [
      JSON.stringify(output),
      toon,
      await command(["--tui", "--once"]),
      await modelsJson([]),
    ]) {
      expect(ordinary).not.toContain(work);
    }
    const full = response(await command(["--full", "--json"]));
    expect(full.providers[1].state.remedyCommand).toContain(work);
    expect(JSON.stringify(full.help)).toContain(work);
    expect(await modelsJson(["--full"])).toContain(work);
  });

  it("lets the environment token select only the process-selected lane", async () => {
    credential(".claude", "synthetic-personal");
    credential(".claude-work", "synthetic-work");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-env-personal");
    const output = response(await command(["--json"]));
    expect(output.providers).toHaveLength(2);
    const bearers = bearerTokens();
    expect(bearers).toContain("Bearer synthetic-env-personal");
    expect(bearers).toContain("Bearer synthetic-work");
    expect(bearers).not.toContain("Bearer synthetic-personal");
  });

  it("keeps the macOS account key stable across the environment token", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    const { claudeAccountKey } =
      await import("../src/providers/claude-accounts.js");
    const { claudeProfileLocations } =
      await import("../src/lib/claude-profile.js");
    const profile = claudeProfileLocations({});
    const stored = claudeAccountKey(profile);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-env-personal");
    expect(claudeAccountKey(profile)).toBe(stored);
  });

  it("announces the single-lane fallback when discovery faults", async () => {
    const { fetchAccountQuotas, inspectAccountAuth } =
      await import("../src/providers/accounts.js");
    const { renderQuotaToon } = await import("../src/render.js");
    const healthy: ProviderQuota = {
      provider: "codex",
      windows: [],
      state: { status: "fresh", stale: false },
    };
    const adapter = (
      discoverAccounts: () => Promise<ProviderAccount[]>,
    ): ProviderAdapter => ({
      id: "codex",
      label: "Codex",
      fetchQuota: vi.fn(async () => healthy),
      inspectAuth: async () => ({ provider: "codex", sources: [] }),
      discoverAccounts,
    });
    const duplicate: ProviderAccount = {
      accountKey: "one",
      locator: { kind: "synthetic", path: "/fixture" },
      fetchQuota: async () => healthy,
      inspectAuth: async () => ({ provider: "codex", sources: [] }),
    };
    const degraded = [
      { source: "account-discovery", error: "account_discovery_failed" },
    ];
    for (const discover of [
      async () => {
        throw new Error("private-token");
      },
      async () => [duplicate, duplicate],
    ]) {
      const faulty = adapter(discover);
      const [report] = await fetchAccountQuotas(faulty, options);
      expect(faulty.fetchQuota).toHaveBeenCalledTimes(1);
      expect(report.accountKey).toBeUndefined();
      expect(report.state.status).toBe("fresh");
      expect(report.state.degradedSources).toEqual(degraded);
      expect(JSON.stringify(report)).not.toContain("private-token");
      const toon = renderQuotaToon(
        { generatedAt: now, schemaVersion: 5, providers: [report] },
        "quota-axi",
        false,
      );
      expect(toon).toContain("codex,all,degraded_source,account-discovery");
      expect(toon).toContain("account_discovery_failed");
      const [auth] = await inspectAccountAuth(faulty, options);
      expect(auth.sources).toEqual([
        {
          source: "account-discovery",
          status: "error",
          error: "account_discovery_failed",
        },
      ]);
    }
  });

  it("enrolls the process-selected profile while an environment token is set", async () => {
    const work = credential(".claude-work", "synthetic-work");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-env-personal");
    const output = response(await command(["--full", "--json"]));
    expect(output.providers).toHaveLength(2);
    expect(output.providers.map((p) => p.accountLocator?.path)).toEqual([
      join(home, ".claude"),
      work,
    ]);
    expect(output.providers[0].accountLocator?.delegateEligible).toBe(true);
    expect(output.providers[1].accountLocator?.delegateEligible).toBe(false);
    const bearers = bearerTokens();
    expect(bearers).toContain("Bearer synthetic-env-personal");
    expect(bearers).toContain("Bearer synthetic-work");
  });

  it("preserves Z.AI and OpenCode Go bounds beside expanded Claude accounts", async () => {
    credential(".claude", "synthetic-personal");
    credential(".claude-work", "synthetic-work");
    const { PROVIDERS } = await import("../src/providers/index.js");
    const { fetchQuota } = await import("../src/commands.js");
    const { renderQuotaToon } = await import("../src/render.js");
    const window = (
      id: string,
      kind: ProviderQuota["windows"][number]["kind"],
      percentRemaining: number,
    ) => ({ id, label: id, kind, percentRemaining });
    const zai = vi.spyOn(PROVIDERS.zai, "fetchQuota").mockResolvedValue({
      provider: "zai",
      windows: [
        window("five_hour", "session", 80),
        window("weekly", "weekly", 60),
        window("mcp_month", "monthly", 10),
      ],
      state: { status: "fresh", stale: false },
    });
    const go = vi
      .spyOn(PROVIDERS["opencode-go"], "fetchQuota")
      .mockResolvedValue({
        provider: "opencode-go",
        windows: [
          window("rolling", "unknown", 90),
          window("weekly", "weekly", 70),
          window("monthly", "monthly", 50),
        ],
        state: { status: "fresh", stale: false },
      });
    try {
      const standalone = await fetchQuota(["zai", "opencode-go"], options);
      const mixed = await fetchQuota(["claude", "zai", "opencode-go"], options);
      expect(mixed.schemaVersion).toBe(6);
      expect(mixed.providers.map((p) => p.provider)).toEqual([
        "claude",
        "claude",
        "zai",
        "opencode-go",
      ]);
      expect(mixed.providers.slice(2)).toEqual(
        standalone.providers.map((p) => ({ ...p, accountKey: "default" })),
      );
      expect(mixed.providers[2].quotaSemantics?.effectiveAvailability).toEqual([
        expect.objectContaining({
          scope: "all_models",
          effectivePercentRemaining: 60,
        }),
        expect.objectContaining({
          scope: "tools",
          effectivePercentRemaining: 10,
        }),
      ]);
      expect(mixed.providers[3].quotaSemantics?.effectiveAvailability).toEqual([
        expect.objectContaining({
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: 50,
          boundedBy: ["rolling", "weekly", "monthly"],
          limitingWindowIds: ["monthly"],
          runway: expect.objectContaining({ status: "unknown" }),
          selection: expect.objectContaining({ status: "unknown" }),
        }),
      ]);
      const toon = renderQuotaToon(mixed, "quota-axi", false);
      expect(toon).toContain("quota[5]{provider,accountKey,scope,");
      expect(toon).toContain("zai,default,all_models,60,unknown,");
      expect(toon).toContain("zai,default,tools,10,unknown,");
      expect(toon).toContain("opencode-go,default,all_models,50,unknown,");
    } finally {
      zai.mockRestore();
      go.mockRestore();
    }
  });

  it("preserves profile-only's exact file, no discovery and no cache contract", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    const output = response(await command(["--profile-only", "--json"]));
    expect(output.schemaVersion).toBe(5);
    expect(output.providers).toHaveLength(1);
    expect(output.providers[0].windows[0].percentRemaining).toBe(20);
    expect(output.providers[0].accountKey).toBeUndefined();
    expect(() => statSync(join(home, "cache"))).toThrow();
  });

  it("deduplicates the explicitly selected default file on Linux", async () => {
    const dir = credential(".claude", "synthetic-personal");
    vi.stubEnv("CLAUDE_CONFIG_DIR", `${dir}/../.claude`);
    expect(response(await command(["--json"])).providers).toHaveLength(1);
  });

  it("reads each macOS Keychain profile through its own existing consent marker", async () => {
    const work = join(home, ".claude-work");
    mkdirSync(work);
    const { claudeProfileLocations } =
      await import("../src/lib/claude-profile.js");
    const workService = claudeProfileLocations({
      CLAUDE_CONFIG_DIR: work,
    }).keychainService;
    const exec = mockMacKeychain(
      new Map([
        ["Claude Code-credentials", "synthetic-personal"],
        [workService, "synthetic-work"],
      ]),
    );
    const { claudeKeychainAccessMarkerPath } = await import("../src/lib/fs.js");
    mkdirSync(join(home, "cache", "quota-axi"), { recursive: true });
    writeFileSync(
      claudeKeychainAccessMarkerPath("fixture-user", "Claude Code-credentials"),
      "granted\n",
    );
    const blocked = response(await command(["--json"]));
    expect(blocked.providers).toHaveLength(2);
    expect(blocked.providers[0].state.status).toBe("fresh");
    expect(blocked.providers[1].state.reason).toBe("keychain_access_required");
    expect(
      exec.mock.calls
        .filter(([, args]) => args.includes("-w"))
        .every(([, args]) => args.includes("Claude Code-credentials")),
    ).toBe(true);
    const allowed = response(
      await command(["--allow-keychain-prompt", "--json"]),
    );
    expect(allowed.providers.map((p) => p.windows[0].percentRemaining)).toEqual(
      [80, 20],
    );
    expect(allowed.providers.map((p) => p.accountKey)).toEqual(
      blocked.providers.map((p) => p.accountKey),
    );
    expect(
      readFileSync(
        claudeKeychainAccessMarkerPath("fixture-user", workService),
        "utf8",
      ),
    ).toBeTruthy();
  });

  it("isolates stale fallback and definitive auth cache retirement across profiles", async () => {
    credential(".claude", "synthetic-personal");
    credential(".claude-work", "synthetic-work");
    const fresh = response(await command(["--json"]));
    const cacheFile = join(home, "cache", "quota-axi", "quotas.json");
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).providers).toHaveLength(
      2,
    );
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (
          new Headers(init.headers).get("authorization")!.endsWith("personal")
        )
          return new Response("", { status: 401 });
        throw new Error("fixture transport failed");
      }),
    );
    const failed = response(await command(["--json"]));
    expect(failed.providers.map((p) => p.state.status)).toEqual([
      "auth_required",
      "stale",
    ]);
    expect(failed.providers.map((p) => p.accountKey)).toEqual(
      fresh.providers.map((p) => p.accountKey),
    );
    expect(failed.providers[1].windows[0].percentRemaining).toBe(20);
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cached.providers).toHaveLength(1);
    expect(cached.providers[0].accountKey).toBe(fresh.providers[1].accountKey);
    expect(JSON.stringify(cached)).not.toMatch(
      /synthetic-|private@example|accountLocator|accountId|\.claude/,
    );
  });

  it("keeps context attached to the reading after the ambient profile changes", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    const { fetchQuota } = await import("../src/commands.js");
    const { writeCachedProviders } = await import("../src/cache.js");
    const report = await fetchQuota(["claude"], options);
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    writeCachedProviders(report.providers);
    const records = JSON.parse(
      readFileSync(join(home, "cache", "quota-axi", "quotas.json"), "utf8"),
    ).providers;
    expect(records).toHaveLength(2);
    expect(
      new Set(
        records.map((p: { credentialContext: string }) => p.credentialContext),
      ).size,
    ).toBe(2);
  });

  it("inspects each profile's auth without HTTP or delegated refresh", async () => {
    credential(".claude", "synthetic-personal");
    credential(".claude-work", "synthetic-work");
    const { authCommand } = await import("../src/commands.js");
    const auth = JSON.parse(
      await authCommand(["--provider", "claude", "--json"], undefined),
    );
    expect(auth.schemaVersion).toBe(2);
    expect(auth.auth).toHaveLength(2);
    expect(
      new Set(auth.auth.map((p: { accountKey: string }) => p.accountKey)).size,
    ).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isolates unexpected reader failures using the shared adapter hook", async () => {
    const { fetchAccountQuotas } = await import("../src/providers/accounts.js");
    const healthy: ProviderQuota = {
      provider: "codex",
      windows: [],
      state: { status: "fresh", stale: false },
    };
    const unused = vi.fn(async () => healthy);
    const reports = await fetchAccountQuotas(
      {
        id: "codex",
        label: "Codex",
        fetchQuota: unused,
        inspectAuth: async () => ({ provider: "codex", sources: [] }),
        discoverAccounts: async () =>
          ["one", "two"].map((key) => ({
            accountKey: key,
            locator: { kind: "synthetic", path: "/fixture" },
            fetchQuota: async () => {
              if (key === "one") throw new Error("private-token");
              return healthy;
            },
            inspectAuth: async () => ({ provider: "codex", sources: [] }),
          })),
      },
      options,
    );
    expect(reports.map((p) => p.state.status)).toEqual(["error", "fresh"]);
    expect(reports.map((p) => p.accountKey)).toEqual(["one", "two"]);
    expect(JSON.stringify(reports)).not.toContain("private-token");
    expect(unused).not.toHaveBeenCalled();
  });

  it("joins models independently for each account instead of overwriting a provider", async () => {
    credential(".claude", "synthetic-personal");
    credential(".claude-work", "synthetic-work");
    const { modelsCommand } = await import("../src/commands.js");
    const output = JSON.parse(
      await modelsCommand(
        [
          "--provider",
          "claude",
          "--json",
          "--sort",
          "runway",
          "--no-credential-refresh",
        ],
        undefined,
      ),
    );
    expect(output.schemaVersion).toBe(2);
    const ids = [
      ...new Set(output.models.map((model: { id: string }) => model.id)),
    ];
    for (const id of ids) {
      const rows = output.models.filter(
        (model: { id: string }) => model.id === id,
      );
      expect(rows).toHaveLength(2);
      expect(
        new Set(rows.map((model: { accountKey: string }) => model.accountKey))
          .size,
      ).toBe(2);
    }
    for (const group of output.sort.tieGroups)
      for (const row of group) expect(row.accountKey).toBeDefined();
  });
});
