import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuota } from "../src/types.js";

/**
 * Opt-in Claude profile lanes (`QUOTA_AXI_CLAUDE_PROFILES`), exercised through
 * the public commands against synthetic profile directories, a mocked
 * `security` boundary, and a stubbed vendor. No real Keychain, profile, or
 * network is touched.
 */

let home: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const now = "2026-09-15T10:00:00.000Z";
const KEYCHAIN = "/fixture/login.keychain-db";

type Identity = { account: string; organization?: string };

/** Which vendor identity each synthetic bearer belongs to. */
let identities: Map<string, Identity>;
let runRefreshDelegate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "quota-claude-profiles-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("USER", "fixture-user");
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", undefined);
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  identities = new Map();
  vi.doMock("../src/lib/process.js", () => ({
    execFileText: vi.fn(async () => {
      throw new Error("unexpected process boundary");
    }),
  }));
  vi.doMock("../src/lib/running-processes.js", () => ({
    listRunningCommandLines: vi.fn(async () => ({
      status: "listed" as const,
      processes: [],
    })),
  }));
  runRefreshDelegate = vi.fn(async () => {
    throw new Error("unexpected refresh");
  });
  vi.doMock(
    "../src/providers/delegated-refresh.js",
    async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("../src/providers/delegated-refresh.js")
      >()),
      runRefreshDelegate,
    }),
  );
  vi.stubGlobal("fetch", vi.fn(vendor));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("../src/lib/process.js");
  vi.doUnmock("../src/lib/running-processes.js");
  vi.doUnmock("../src/providers/delegated-refresh.js");
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

/** The synthetic usage and profile endpoints, keyed by bearer. */
async function vendor(url: string, init: RequestInit): Promise<Response> {
  const token = new Headers(init.headers)
    .get("authorization")!
    .replace("Bearer ", "");
  if (token.includes("rejected")) return new Response("", { status: 401 });
  if (url.endsWith("/profile")) {
    const identity = identities.get(token) ?? { account: `account-${token}` };
    return new Response(
      JSON.stringify({
        account: { uuid: identity.account, email: "private@example.invalid" },
        ...(identity.organization
          ? { organization: { uuid: identity.organization, name: "Org" } }
          : {}),
      }),
    );
  }
  return new Response(
    JSON.stringify({
      five_hour: {
        utilization: usedPercent(token),
        resets_at: "2026-09-15T12:00:00Z",
      },
    }),
  );
}

/** A distinct, deterministic usage figure per synthetic bearer. */
function usedPercent(token: string): number {
  return [...token].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 90;
}

function credential(
  name: string,
  token: string,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: token, subscriptionType: "pro", ...extra },
    }),
  );
  return dir;
}

function optIn(...dirs: string[]): void {
  vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", dirs.join(delimiter));
}

async function command(args: string[] = [], providers = "claude") {
  const { quotaCommand } = await import("../src/commands.js");
  return quotaCommand(
    ["--provider", providers, "--no-credential-refresh", ...args],
    undefined,
  );
}

function response(text: string): {
  schemaVersion: number;
  providers: ProviderQuota[];
  help?: string[];
} {
  return JSON.parse(text);
}

function bearers(): string[] {
  return (vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][])
    .filter(([url]) => url.endsWith("/usage"))
    .map(([, init]) =>
      new Headers(init.headers).get("authorization")!.replace("Bearer ", ""),
    );
}

function cacheFile(): string {
  return join(home, "cache", "quota-axi", "quotas.json");
}

function remaining(text: string): number[] {
  return response(text).providers.map((p) => p.windows[0]?.percentRemaining);
}

/** A synthetic macOS Keychain holding one Claude item per service. */
function mockMacKeychain(services: Map<string, string>) {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  const exec = vi.fn(async (command: string, args: string[]) => {
    expect(command).toBe("security");
    if (args[0] === "list-keychains") return `    "${KEYCHAIN}"\n`;
    if (args[0] === "dump-keychain")
      return [...services.keys()]
        .map(
          (service) =>
            `keychain: "${KEYCHAIN}"\nclass: "genp"\nattributes:\n    "acct"<blob>="fixture-user"\n    "svce"<blob>="${service}"\n`,
        )
        .join("");
    expect(args[0]).toBe("find-generic-password");
    expect(args).toContain("fixture-user");
    const service = args[args.indexOf("-s") + 1];
    if (!services.has(service))
      throw Object.assign(new Error("not found"), { code: 44 });
    return args.includes("-w")
      ? JSON.stringify({
          claudeAiOauth: { accessToken: services.get(service) },
        })
      : "present";
  });
  vi.doMock("../src/lib/process.js", () => ({ execFileText: exec }));
  return exec;
}

async function keychainService(dir?: string): Promise<string> {
  const { claudeProfileLocations } =
    await import("../src/lib/claude-profile.js");
  return claudeProfileLocations(
    dir === undefined ? {} : { CLAUDE_CONFIG_DIR: dir },
  ).keychainService;
}

async function grant(service: string): Promise<void> {
  const { claudeKeychainAccessMarkerPath } = await import("../src/lib/fs.js");
  const marker = claudeKeychainAccessMarkerPath("fixture-user", service);
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, "granted\n");
}

describe("unconfigured Claude stays one selected lane", () => {
  it("reports exactly the pre-existing output and cache when the variable is unset or blank", async () => {
    credential(".claude", "synthetic-personal");
    // Profiles that exist on disk are never discovered without the opt-in
    credential(".claude-work", "synthetic-work");
    const { PROVIDERS } = await import("../src/providers/index.js");
    const original = PROVIDERS.claude;

    const read = async () => {
      rmSync(join(home, "cache"), { recursive: true, force: true });
      const outputs = [
        await command(["--json"]),
        await command(["--full", "--json"]),
        await command(),
        await command(["--tui", "--once"]),
      ];
      const cache = JSON.parse(readFileSync(cacheFile(), "utf8"));
      for (const record of cache.providers) delete record.reuse?.context;
      return { outputs, cache };
    };

    PROVIDERS.claude = { ...original, discoverAccounts: undefined };
    let baseline;
    try {
      baseline = await read();
    } finally {
      PROVIDERS.claude = original;
    }
    for (const value of [undefined, "", "   ", delimiter]) {
      vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", value);
      expect(await read()).toEqual(baseline);
    }
    expect(response(baseline.outputs[0]).schemaVersion).toBe(5);
    expect(baseline.outputs.join("\n")).not.toMatch(
      /\baccountKey\b|accountLocator|profile:/,
    );
    expect(bearers()).not.toContain("synthetic-work");
  });

  it("returns no accounts from discovery without the opt-in", async () => {
    credential(".claude", "synthetic-personal");
    credential(".claude-work", "synthetic-work");
    const { claudeAdapter } = await import("../src/providers/claude.js");
    expect(await claudeAdapter.discoverAccounts?.()).toBeUndefined();
    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", " ");
    expect(await claudeAdapter.discoverAccounts?.()).toBeUndefined();
  });
});

describe("opt-in Claude profile lanes", () => {
  it("reports the selected, default, and listed profiles in order with stable non-secret keys", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    const team = credential(".claude-team", "synthetic-team");
    // Not listed: never read, however it is named
    credential(".claude-other", "synthetic-other");
    optIn(work, team);

    const first = response(await command(["--json"]));
    expect(first.schemaVersion).toBe(6);
    expect(first.providers).toHaveLength(3);
    expect(remaining(JSON.stringify(first))).toEqual(
      ["synthetic-personal", "synthetic-work", "synthetic-team"].map(
        (token) => 100 - usedPercent(token),
      ),
    );
    const keys = first.providers.map((p) => p.accountKey!);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^profile:[a-f0-9]{24}$/);
    expect(first.providers.map((p) => p.accountKeys)).toEqual(
      keys.map((key) => [key]),
    );
    expect(bearers()).not.toContain("synthetic-other");
    expect(JSON.stringify(first)).not.toMatch(
      /private@example|synthetic-|\.claude|accountLocator/,
    );

    // The process-selected profile leads; keys follow the profile, not order
    vi.stubEnv("CLAUDE_CONFIG_DIR", team);
    const reordered = response(await command(["--json"]));
    expect(reordered.providers.map((p) => p.accountKey)).toEqual([
      keys[2],
      keys[0],
      keys[1],
    ]);
  });

  it("publishes each lane's accountLocator only in --full", async () => {
    const personal = credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    optIn(work);

    const full = response(await command(["--full", "--json"]));
    expect(full.providers.map((p) => p.accountLocator)).toEqual([
      { kind: "config-dir", path: personal, delegateEligible: true },
      { kind: "config-dir", path: work, delegateEligible: false },
    ]);
    expect(full.providers[1].account?.email).toBe("private@example.invalid");
    const toon = await command(["--full"]);
    expect(toon).toMatch(
      /accounts\[2\]\{provider,accountKey,email,organization,accountId,identityStatus,locatorKind,locatorPath,keychainService,delegateEligible\}/,
    );
    expect(toon).toContain("config-dir,~/.claude-work,none,false");
    expect(await command(["--json"])).not.toContain("accountLocator");
  });

  it("names the default lane by its unsuffixed Keychain service on macOS", async () => {
    const work = join(home, ".claude-work");
    mkdirSync(work);
    const workService = await keychainService(work);
    mockMacKeychain(
      new Map([
        ["Claude Code-credentials", "synthetic-personal"],
        [workService, "synthetic-work"],
      ]),
    );
    await grant("Claude Code-credentials");
    await grant(workService);
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    optIn(work);

    const full = response(await command(["--full", "--json"]));
    expect(full.providers.map((p) => p.accountLocator)).toEqual([
      {
        kind: "config-dir",
        path: work,
        keychainService: workService,
        delegateEligible: true,
      },
      {
        kind: "config-dir",
        path: join(home, ".claude"),
        keychainService: "Claude Code-credentials",
        delegateEligible: false,
      },
    ]);
    expect(full.providers.map((p) => p.state.status)).toEqual([
      "fresh",
      "fresh",
    ]);
  });

  it("lets the environment token answer only for the process-selected lane", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-env-session");
    optIn(work);

    const output = response(await command(["--json"]));
    expect(output.providers).toHaveLength(2);
    expect(bearers()).toEqual(["synthetic-env-session", "synthetic-work"]);

    // The key names the profile, so it never moves with the token
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
    const without = response(await command(["--json"]));
    expect(without.providers.map((p) => p.accountKey)).toEqual(
      output.providers.map((p) => p.accountKey),
    );
  });

  it("reports a listed profile without a credential as its own read instead of dropping it", async () => {
    credential(".claude", "synthetic-personal");
    const empty = join(home, ".claude-empty");
    mkdirSync(empty);
    const missing = join(home, ".claude-typo");
    optIn(empty, missing);

    const output = response(await command(["--json"]));
    expect(output.providers.map((p) => p.state.status)).toEqual([
      "fresh",
      "auth_required",
      "auth_required",
    ]);
    expect(output.providers.slice(1).map((p) => p.state.error)).toEqual([
      "credentials_missing",
      "credentials_missing",
    ]);
    expect(output.providers.slice(1).map((p) => p.notSetUp)).toEqual([
      true,
      true,
    ]);
    const toon = await command();
    for (const lane of output.providers.slice(1))
      expect(toon).toContain(
        `claude,"${lane.accountKey}",all,auth_required,credentials_missing`,
      );
    expect(process.exitCode).toBeUndefined();
  });

  it("adds the unlisted default profile only when it holds a credential", async () => {
    const work = credential(".claude-work", "synthetic-work");
    const team = credential(".claude-team", "synthetic-team");
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    optIn(team);

    const full = response(await command(["--full", "--json"]));
    expect(full.providers.map((p) => p.accountLocator?.path)).toEqual([
      work,
      team,
    ]);
  });

  it("keeps a listed default profile without a credential when another profile is selected", async () => {
    const work = credential(".claude-work", "synthetic-work");
    const personal = join(home, ".claude");
    mkdirSync(personal);
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    optIn(personal);

    const full = response(await command(["--full", "--json"]));
    expect(full.providers.map((p) => p.accountLocator?.path)).toEqual([
      work,
      personal,
    ]);
    expect(full.providers.map((p) => p.state.error)).toEqual([
      undefined,
      "credentials_missing",
    ]);
  });

  it("reports one lane per credential store", async () => {
    const personal = credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    symlinkSync(work, join(home, "work-link"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", `${personal}/../.claude`);
    optIn(personal, work, join(home, "work-link"), `${work}/`);

    const output = response(await command(["--json"]));
    expect(output.providers).toHaveLength(2);
    expect(bearers()).toEqual(["synthetic-personal", "synthetic-work"]);
  });

  it("keeps one row and no locator when only the selected profile remains", async () => {
    const personal = credential(".claude", "synthetic-personal");
    optIn(personal);

    const output = response(await command(["--full", "--json"]));
    expect(output.schemaVersion).toBe(5);
    expect(output.providers).toHaveLength(1);
    expect(output.providers[0].accountKey).toBeUndefined();
    expect(output.providers[0].accountLocator).toBeUndefined();
    expect(output.providers[0].accountKeys?.[0]).toMatch(/^profile:/);
  });

  it("fails loudly on a relative entry and ignores the variable under --profile-only", async () => {
    const work = credential(".claude-work", "synthetic-work");
    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", `${work}${delimiter}.claude-team`);
    await expect(command(["--json"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const { authCommand } = await import("../src/commands.js");
    await expect(
      authCommand(["--provider", "claude", "--json"], undefined),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Another provider's read never depends on the Claude list
    await expect(command(["--json"], "zai")).resolves.toBeDefined();

    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    const output = response(await command(["--profile-only", "--json"]));
    expect(output.schemaVersion).toBe(5);
    expect(output.providers).toHaveLength(1);
    expect(output.providers[0].accountKey).toBeUndefined();
    expect(() => statSync(join(home, "cache"))).toThrow();
  });

  it("joins models per lane instead of overwriting one Claude row", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    optIn(work);
    const { modelsCommand } = await import("../src/commands.js");
    const output = JSON.parse(
      await modelsCommand(
        ["--provider", "claude", "--json", "--no-credential-refresh"],
        undefined,
      ),
    );
    expect(output.schemaVersion).toBe(2);
    const keys = response(await command(["--json"])).providers.map(
      (p) => p.accountKey,
    );
    for (const id of new Set(
      output.models.map((model: { id: string }) => model.id),
    )) {
      expect(
        output.models
          .filter((model: { id: string }) => model.id === id)
          .map((model: { accountKey: string }) => model.accountKey)
          .sort(),
      ).toEqual([...keys].sort());
    }
  });

  it("inspects each lane's auth without a vendor request", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    optIn(work);
    const { authCommand } = await import("../src/commands.js");
    const auth = JSON.parse(
      await authCommand(["--provider", "claude", "--json"], undefined),
    );
    expect(auth.schemaVersion).toBe(2);
    expect(auth.auth.map((p: { accountKey: string }) => p.accountKey)).toEqual(
      response(await command(["--json"])).providers.map((p) => p.accountKey),
    );
    expect(
      auth.auth.map(
        (p: { sources: { path?: string }[] }) =>
          p.sources.find((source) => source.path)?.path,
      ),
    ).toEqual([
      join(home, ".claude", ".credentials.json"),
      join(work, ".credentials.json"),
    ]);
  });
});

describe("Claude profile lane refresh and remedies", () => {
  const expired = "2000-01-01T00:00:00.000Z";

  it("delegates refresh only for the process-selected lane and points a sibling at its own claude doctor", async () => {
    credential(".claude", "synthetic-rejected-personal", {
      expiresAt: expired,
      refreshToken: "present",
    });
    const work = credential(".claude work", "synthetic-rejected-work", {
      expiresAt: expired,
      refreshToken: "present",
    });
    optIn(work);
    runRefreshDelegate.mockImplementation(async () => ({
      status: "ran",
      exitCode: 0,
    }));
    const { quotaCommand } = await import("../src/commands.js");
    const output = response(
      await quotaCommand(["--provider", "claude", "--json"], undefined),
    );

    expect(runRefreshDelegate).toHaveBeenCalledTimes(1);
    expect(output.providers.map((p) => p.state.authStatus)).toEqual([
      "expired_refreshable",
      "expired_refreshable",
    ]);
    // The selected lane keeps its existing remedy
    expect(output.providers[0].state.remedyCommand).toBe("claude");
    expect(output.providers[1].state.reason).toBe("credentials_expired");
    expect(output.providers[1].state.remedyCommand).toBe(
      `CLAUDE_CONFIG_DIR='${work}' claude doctor`,
    );
    expect(output.help).toContain(
      `Tell your user: run \`CLAUDE_CONFIG_DIR='${work}' claude doctor\` once so Claude Code refreshes the session of the Claude account ${output.providers[1].accountKey}. quota-axi refreshes only the process-selected Claude profile and never rotates credentials itself.`,
    );
  });

  it("asks for a sibling's Keychain grant with a command that selects only that profile", async () => {
    const work = join(home, ".claude-work");
    mkdirSync(work);
    const workService = await keychainService(work);
    const exec = mockMacKeychain(
      new Map([
        ["Claude Code-credentials", "synthetic-personal"],
        [workService, "synthetic-work"],
      ]),
    );
    await grant("Claude Code-credentials");
    optIn(work);

    const blocked = response(await command(["--json"]));
    expect(blocked.providers.map((p) => p.state.status)).toEqual([
      "fresh",
      "auth_required",
    ]);
    const remedy = `env -u QUOTA_AXI_CLAUDE_PROFILES CLAUDE_CONFIG_DIR='${work}' quota-axi --provider claude --allow-keychain-prompt`;
    expect(blocked.providers[1].state.reason).toBe("keychain_access_required");
    expect(blocked.providers[1].state.remedyCommand).toBe(remedy);
    expect(blocked.help?.[0]).toBe(
      `Tell your user: run \`${remedy}\` once and approve Keychain access ("Always Allow") so quota-axi can read live quota for the Claude account ${blocked.providers[1].accountKey}.`,
    );
    // No value was read for the ungranted item
    expect(
      exec.mock.calls
        .filter(([, args]) => args.includes("-w"))
        .every(([, args]) => args.includes("Claude Code-credentials")),
    ).toBe(true);

    // Running that remedy reads and grants exactly the sibling's item
    exec.mockClear();
    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", undefined);
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    response(await command(["--allow-keychain-prompt", "--json"]));
    expect(
      exec.mock.calls
        .filter(([, args]) => args.includes("-w"))
        .map(([, args]) => args[args.indexOf("-s") + 1]),
    ).toEqual([workService]);

    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    optIn(work);
    expect(remaining(await command(["--json"]))).toEqual([
      100 - usedPercent("synthetic-personal"),
      100 - usedPercent("synthetic-work"),
    ]);
  });

  it("selects the default profile by unsetting CLAUDE_CONFIG_DIR in its remedy", async () => {
    const work = join(home, ".claude-work");
    mkdirSync(work);
    const workService = await keychainService(work);
    mockMacKeychain(
      new Map([
        ["Claude Code-credentials", "synthetic-personal"],
        [workService, "synthetic-work"],
      ]),
    );
    await grant(workService);
    vi.stubEnv("CLAUDE_CONFIG_DIR", work);
    optIn(work);

    const output = response(await command(["--json"]));
    expect(output.providers[1].state.remedyCommand).toBe(
      "env -u QUOTA_AXI_CLAUDE_PROFILES -u CLAUDE_CONFIG_DIR quota-axi --provider claude --allow-keychain-prompt",
    );
  });

  it("never reads a listed sibling's Keychain item as the default profile's own", async () => {
    const work = join(home, ".claude-work");
    mkdirSync(work);
    const workService = await keychainService(work);
    const exec = mockMacKeychain(new Map([[workService, "synthetic-work"]]));
    await grant(workService);
    optIn(work);

    const output = response(await command(["--json"]));
    expect(output.providers).toHaveLength(2);
    expect(output.providers.map((p) => p.state.status)).toEqual([
      "auth_required",
      "fresh",
    ]);
    expect(output.providers[0].state.error).toBe("credentials_missing");
    expect(bearers()).toEqual(["synthetic-work"]);
    expect(
      exec.mock.calls.filter(([, args]) => args[0] === "dump-keychain"),
    ).toHaveLength(1);
  });
});

describe("Claude profile lane cache isolation", () => {
  it("serves each lane's own stale snapshot and retires only the signed-out lane", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    optIn(work);
    const fresh = response(await command(["--json"]));
    expect(
      JSON.parse(readFileSync(cacheFile(), "utf8")).providers,
    ).toHaveLength(2);
    expect(statSync(cacheFile()).mode & 0o777).toBe(0o600);

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
    expect(failed.providers[1].windows[0].percentRemaining).toBe(
      100 - usedPercent("synthetic-work"),
    );
    const cached = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(cached.providers.map((p: ProviderQuota) => p.accountKey)).toEqual([
      fresh.providers[1].accountKey,
    ]);
    expect(
      JSON.stringify(
        cached.providers.map(
          ({ reuse, ...p }: { reuse?: unknown }) => (void reuse, p),
        ),
      ),
    ).not.toMatch(
      /synthetic-|private@example|accountLocator|accountId|\.claude/,
    );
  });

  it("serves the newest stale snapshot a profile has in either mode", async () => {
    credential(".claude", "synthetic-older");
    await command(["--json"]);
    credential(".claude", "synthetic-personal");
    optIn(credential(".claude-work", "synthetic-work"));
    vi.setSystemTime("2026-09-15T10:10:00.000Z");
    await command(["--json"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fixture transport failed");
      }),
    );
    vi.setSystemTime("2026-09-15T10:20:00.000Z");
    const optedIn = response(await command(["--json"]));
    expect(optedIn.providers[0].state.status).toBe("stale");
    expect(optedIn.providers[0].windows[0].percentRemaining).toBe(
      100 - usedPercent("synthetic-personal"),
    );

    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", undefined);
    expect(remaining(await command(["--json"]))).toEqual([
      100 - usedPercent("synthetic-personal"),
    ]);
  });

  it("keeps listed lanes' snapshots when an unconfigured run signs out", async () => {
    credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    optIn(work);
    const fresh = response(await command(["--json"]));

    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", undefined);
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
    expect(response(await command(["--json"])).providers[0].state.status).toBe(
      "auth_required",
    );
    const cached = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(cached.providers.map((p: ProviderQuota) => p.accountKey)).toEqual([
      fresh.providers[1].accountKey,
    ]);

    optIn(work);
    const failed = response(await command(["--json"]));
    expect(failed.providers.map((p) => p.state.status)).toEqual([
      "auth_required",
      "stale",
    ]);
  });

  it("keeps a reused --full reading's accountLocator", async () => {
    const personal = credential(".claude", "synthetic-personal");
    const work = credential(".claude-work", "synthetic-work");
    optIn(work);
    await command(["--json"]);
    const reused = response(
      await command(["--full", "--json", "--max-age", "90s"]),
    );
    expect(reused.providers.map((p) => p.state.reused)).toEqual([true, true]);
    expect(reused.providers.map((p) => p.accountLocator?.path)).toEqual([
      personal,
      work,
    ]);
    expect(bearers()).toHaveLength(2);
  });
});

describe("Claude profile lanes of one subscription", () => {
  it("folds two profiles signed in to the same account and organization", async () => {
    credential(".claude", "synthetic-personal");
    const alias = credential(".claude-alias", "synthetic-alias");
    identities.set("synthetic-personal", {
      account: "user",
      organization: "org",
    });
    identities.set("synthetic-alias", { account: "user", organization: "org" });
    optIn(alias);

    const output = response(await command(["--json"]));
    expect(output.providers).toHaveLength(1);
    expect(output.providers[0].accountKeys).toHaveLength(2);
    expect(output.providers[0].accountKeys?.[0]).toBe(
      output.providers[0].accountKey,
    );
  });

  it("keeps one login's seats in different organizations apart", async () => {
    credential(".claude", "synthetic-personal");
    const team = credential(".claude-team", "synthetic-team");
    identities.set("synthetic-personal", {
      account: "user",
      organization: "personal-org",
    });
    identities.set("synthetic-team", {
      account: "user",
      organization: "team-org",
    });
    optIn(team);
    expect(response(await command(["--json"])).providers).toHaveLength(2);

    // A reading that cannot name its organization is never folded
    identities.set("synthetic-personal", { account: "user" });
    identities.set("synthetic-team", { account: "user" });
    expect(response(await command(["--json"])).providers).toHaveLength(2);
  });
});
