import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quotaCommand } from "../../src/commands.js";
import { writeCachedProviders } from "../../src/cache.js";
import { fetchQuota } from "../../src/providers/copilot.js";
import { execFileText } from "../../src/lib/process.js";
import { providerFetch } from "../../src/lib/http.js";

const fixture = vi.hoisted(() => ({
  home: "",
  login: "account-a",
  platform: "darwin" as NodeJS.Platform,
}));
vi.mock("../../src/providers/copilot-cli-credential.js", async (actual) => {
  const native =
    await actual<
      typeof import("../../src/providers/copilot-cli-credential.js")
    >();
  return {
    ...native,
    resolveCopilotCliCredential: (
      options: Parameters<typeof native.resolveCopilotCliCredential>[0],
      presenceOnly: boolean | "silence",
    ) =>
      native.resolveCopilotCliCredential(options, presenceOnly, {
        platform: fixture.platform,
        homeDirectory: () => fixture.home,
      }),
  };
});
vi.mock("../../src/lib/process.js", () => ({ execFileText: vi.fn() }));
vi.mock("../../src/lib/http.js", () => ({ providerFetch: vi.fn() }));
vi.mock("../../src/tui-live.js", async (actual) => ({
  ...(await actual<typeof import("../../src/tui-live.js")>()),
  runLiveTui: () => {
    throw new Error("one-shot command must not enter the refresh loop");
  },
}));

const tokenA = "gho_synthetic_account_a";
const tokenB = "gho_synthetic_account_b";
const appsToken = "gho_synthetic_apps";
const ghToken = "gho_synthetic_gh";
const optIn = { allowKeychainPrompt: true, refreshCredentials: false };
const ordinary = { allowKeychainPrompt: false, refreshCredentials: false };
const oneShot = [
  "--provider",
  "copilot",
  "--tui",
  "--once",
  "--allow-keychain-prompt",
  "--no-credential-refresh",
];

function select(login: string) {
  fixture.login = login;
  writeFileSync(
    join(fixture.home, ".copilot/config.json"),
    JSON.stringify({
      lastLoggedInUser: { host: "https://github.com", login },
      loggedInUsers: ["account-a", "account-b"].map((user) => ({
        host: "https://github.com",
        login: user,
      })),
    }),
  );
}
function response(status = 200, headers?: HeadersInit) {
  return new Response(
    JSON.stringify({
      copilot_plan: "individual",
      quota_snapshots: { chat: { percent_remaining: 80 } },
    }),
    { status, headers },
  );
}
function storedFiles(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? storedFiles(path)
      : [{ path, text: readFileSync(path, "utf8") }];
  });
}
function resetCalls() {
  vi.mocked(execFileText).mockClear();
  vi.mocked(providerFetch).mockClear();
}

beforeEach(() => {
  fixture.platform = "darwin";
  fixture.home = mkdtempSync(join(tmpdir(), "quota-copilot-synthetic-"));
  mkdirSync(join(fixture.home, ".copilot"));
  vi.stubEnv("COPILOT_HOME", join(fixture.home, ".copilot"));
  vi.stubEnv("GITHUB_COPILOT_APPS_JSON", join(fixture.home, "apps.json"));
  vi.stubEnv("GH_CONFIG_DIR", join(fixture.home, "gh"));
  vi.stubEnv("XDG_CACHE_HOME", join(fixture.home, "cache"));
  for (const name of [
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_GH_HOST",
    "GH_HOST",
  ])
    vi.stubEnv(name, undefined);
  select("account-a");
  vi.mocked(execFileText).mockImplementation(async (_file, args) => {
    if (fixture.platform === "win32") {
      expect(_file).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      return `ok\n${fixture.login === "account-a" ? tokenA : tokenB}`;
    }
    expect(args).toContain(`https://github.com:${fixture.login}`);
    return args.includes("-w")
      ? fixture.login === "account-a"
        ? tokenA
        : tokenB
      : "synthetic metadata";
  });
  vi.mocked(providerFetch).mockImplementation(async () => response());
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected real transport");
  });
});
afterEach(() => {
  rmSync(fixture.home, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("Copilot composed credential boundaries", () => {
  it("never serves another login's snapshot while the selected native account awaits consent", async () => {
    rmSync(join(fixture.home, ".copilot/config.json"));
    mkdirSync(join(fixture.home, "gh"));
    writeFileSync(
      join(fixture.home, "gh/hosts.yml"),
      `github.com:\n  oauth_token: ${ghToken}\n`,
    );
    const earlier = await fetchQuota(ordinary);
    expect(earlier.state.status).toBe("fresh");
    writeCachedProviders([earlier]);

    select("account-b");
    vi.mocked(providerFetch).mockResolvedValue(response(500));
    const report = await fetchQuota(ordinary);
    expect(report.state).toMatchObject({
      stale: false,
      reason: "keychain_access_required",
    });
    expect(report.windows).toEqual([]);
    expect(vi.mocked(execFileText).mock.calls[0][1]).not.toContain("-w");
  });

  it.each(["darwin", "win32"] as const)(
    "never reads a %s native secret it cannot use after a transient apps.json failure",
    async (platform) => {
      fixture.platform = platform;
      vi.stubEnv("SystemRoot", "C:\\Windows");
      writeFileSync(
        join(fixture.home, "apps.json"),
        JSON.stringify({ "github.com:app": { oauth_token: appsToken } }),
      );
      vi.mocked(providerFetch).mockRejectedValue(new Error("network failure"));
      const report = await fetchQuota(optIn);
      expect(report.state.status).toBe("error");
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(execFileText).not.toHaveBeenCalled();
    },
  );

  it("keeps Windows grants account-scoped and ordinary auth free of vault reads", async () => {
    fixture.platform = "win32";
    vi.stubEnv("SystemRoot", "C:\\Windows");
    expect((await fetchQuota(ordinary)).state.reason).toBe(
      "keychain_access_required",
    );
    expect(execFileText).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect((await fetchQuota(optIn)).source).toBe("cli");
    expect(execFileText).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    resetCalls();
    select("account-b");
    expect((await fetchQuota(ordinary)).state.reason).toBe(
      "keychain_access_required",
    );
    expect(execFileText).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    select("account-a");
    expect((await fetchQuota(ordinary)).source).toBe("cli");
    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${tokenA}` }),
      }),
    );
    expect(
      JSON.stringify(storedFiles(join(fixture.home, "cache"))),
    ).not.toContain(tokenA);
  });

  it.each([
    "credential_not_found",
    "credential_logon_session_unavailable",
    "credential_binding_mismatch",
    "credential_read_timeout",
  ])(
    "keeps Windows %s unavailable without a false sign-out or HTTP call",
    async (reason) => {
      fixture.platform = "win32";
      vi.stubEnv("SystemRoot", "C:\\Windows");
      vi.mocked(execFileText).mockImplementation(async () => {
        if (reason === "credential_read_timeout")
          throw { killed: true, stdout: tokenA };
        return reason;
      });
      const report = await fetchQuota(optIn);
      expect(report.state.status).toBe("unavailable");
      expect(JSON.stringify(report)).not.toContain(tokenA);
      expect(report.attempts).toContainEqual(
        expect.objectContaining({
          source: "copilot-cli:keychain",
          error: reason,
        }),
      );
      expect(execFileText).toHaveBeenCalledTimes(1);
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it("does not hand over from a Windows bearer after a transport failure", async () => {
    fixture.platform = "win32";
    vi.stubEnv("SystemRoot", "C:\\Windows");
    mkdirSync(join(fixture.home, "gh"));
    writeFileSync(
      join(fixture.home, "gh/hosts.yml"),
      `github.com:\n  oauth_token: ${ghToken}\n`,
    );
    vi.mocked(providerFetch).mockRejectedValue(new Error("network failure"));
    const report = await fetchQuota(optIn);
    expect(report.state.status).toBe("error");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(execFileText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(tokenA);
    expect(report.attempts).not.toContainEqual(
      expect.objectContaining({ source: "gh:hosts.yml" }),
    );
  });

  it("isolates persisted grants across account A/B and reuses only the selected account's grant", async () => {
    expect((await fetchQuota(optIn)).source).toBe("cli");
    resetCalls();
    select("account-b");
    expect((await fetchQuota(ordinary)).state.reason).toBe(
      "keychain_access_required",
    );
    expect(execFileText).toHaveBeenCalledOnce();
    expect(vi.mocked(execFileText).mock.calls[0][1]).not.toContain("-w");
    expect(providerFetch).not.toHaveBeenCalled();

    resetCalls();
    expect((await fetchQuota(optIn)).source).toBe("cli");
    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${tokenB}` }),
      }),
    );
    resetCalls();
    select("account-a");
    expect((await fetchQuota(ordinary)).source).toBe("cli");
    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${tokenA}` }),
      }),
    );
    const grants = storedFiles(join(fixture.home, "cache"));
    expect(grants).toHaveLength(2);
    for (const grant of grants) {
      expect(grant.text).toBe("granted\n");
      expect(grant.path).not.toMatch(/account-[ab]|gho_/);
    }
  });

  it("discards an in-flight account A value before HTTP when selection changes to B", async () => {
    vi.mocked(execFileText).mockImplementationOnce(async () => {
      select("account-b");
      return tokenA;
    });
    const result = await fetchQuota(optIn);
    expect(result.state.error).toBe("selected_account_changed");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(tokenA);
    expect(
      storedFiles(fixture.home).some((file) =>
        file.path.includes("access-granted"),
      ),
    ).toBe(false);
  });

  it.each([200, 401, 403, "rate403", 429, 500, "network", "decode"])(
    "caps a native-only one-shot read and sanitizes output for %s",
    async (status) => {
      vi.mocked(providerFetch).mockImplementation(async () => {
        if (status === "network") throw new Error(tokenA);
        if (status === "decode") return new Response(tokenA);
        if (status === "rate403")
          return response(403, { "x-ratelimit-remaining": "0" });
        return response(status);
      });
      const output = await quotaCommand(oneShot, undefined);
      expect(execFileText).toHaveBeenCalledExactlyOnceWith(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "copilot-cli",
          "-a",
          "https://github.com:account-a",
          "-w",
        ],
        60_000,
        16 * 1024,
      );
      expect(providerFetch).toHaveBeenCalledExactlyOnceWith(
        "https://api.github.com/copilot_internal/user",
        expect.objectContaining({ redirect: "error" }),
      );
      expect(output).not.toContain(tokenA);
      expect(output).not.toContain("account-a");
      for (const file of storedFiles(fixture.home))
        expect(file.text).not.toContain(tokenA);
    },
  );

  it.each([{ code: 36 }, { killed: true }, { code: 44 }])(
    "does not send HTTP or expose subprocess output after native failure %j",
    async (failure) => {
      vi.mocked(execFileText).mockRejectedValue({
        ...failure,
        message: tokenA,
        stdout: tokenA,
        stderr: tokenA,
      });
      const output = await quotaCommand(oneShot, undefined);
      expect(execFileText).toHaveBeenCalledOnce();
      expect(providerFetch).not.toHaveBeenCalled();
      expect(output).not.toContain(tokenA);
      for (const file of storedFiles(fixture.home))
        expect(file.text).not.toContain(tokenA);
    },
  );

  it("keeps a working apps source ahead of the native selected account", async () => {
    writeFileSync(
      join(fixture.home, "apps.json"),
      JSON.stringify({ "github.com": { oauth_token: appsToken } }),
    );
    const result = await fetchQuota(optIn);
    expect(result.source).toBe("api");
    expect(result.attempts).toEqual([{ source: "api", status: "success" }]);
    expect(execFileText).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${appsToken}`,
        }),
      }),
    );
  });

  it("reports gh ownership after native rejection without attributing its token to the selected native account", async () => {
    mkdirSync(join(fixture.home, "gh"));
    writeFileSync(
      join(fixture.home, "gh/hosts.yml"),
      `github.com:\n  oauth_token: ${ghToken}\n`,
    );
    vi.mocked(providerFetch).mockResolvedValueOnce(response(401));
    const result = await fetchQuota(optIn);
    expect(result.source).toBe("api");
    expect(result.attempts).toEqual([
      expect.objectContaining({ source: "apps-json", status: "skipped" }),
      expect.objectContaining({
        source: "copilot-cli:keychain",
        status: "failed",
      }),
      { source: "gh:hosts.yml", status: "success" },
    ]);
    expect(providerFetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${ghToken}`,
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(ghToken);
  });
});
