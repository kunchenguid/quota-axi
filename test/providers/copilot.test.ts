import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  degradedSources,
  providerPresence,
} from "../../src/lib/source-attempts.js";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import {
  copilotAdapter,
  fetchQuota,
  inspectAuth,
  normalizeCopilotUser,
} from "../../src/providers/copilot.js";
import type { ProviderQuota } from "../../src/types.js";

const originalAppsJson = process.env.GITHUB_COPILOT_APPS_JSON;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalGhConfigDir = process.env.GH_CONFIG_DIR;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-copilot-"));
  process.env.GITHUB_COPILOT_APPS_JSON = join(tempDir, "apps.json");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.GH_CONFIG_DIR = join(tempDir, "gh");
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalAppsJson === undefined)
    delete process.env.GITHUB_COPILOT_APPS_JSON;
  else process.env.GITHUB_COPILOT_APPS_JSON = originalAppsJson;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (originalGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
  else process.env.GH_CONFIG_DIR = originalGhConfigDir;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function writeAppsJson(value: unknown): void {
  writeFileSync(process.env.GITHUB_COPILOT_APPS_JSON!, JSON.stringify(value));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function withPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

describe("GitHub Copilot quota parsing", () => {
  it("normalizes quota snapshots without inventing comparable percentages", () => {
    const result = normalizeCopilotUser({
      login: "fixture-user",
      copilot_plan: "individual",
      quota_reset_date_utc: "2026-08-01T00:00:00Z",
      quota_snapshots: {
        chat: {
          percent_remaining: 80,
          quota_reset_at: 1784332800,
        },
        premium_interactions: {
          percent_remaining: "25",
        },
      },
    });

    expect(result?.plan).toBe("individual");
    expect(result?.account?.accountId).toBe("fixture-user");
    expect(result?.windows).toMatchObject([
      {
        id: "chat",
        label: "chat",
        kind: "monthly",
        percentUsed: 20,
        percentRemaining: 80,
        resetsAt: "2026-07-18T00:00:00.000Z",
      },
      {
        id: "premium_interactions",
        label: "premium interactions",
        kind: "monthly",
        percentUsed: 75,
        percentRemaining: 25,
        resetsAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("uses the top-level reset date when a snapshot reset is non-positive", () => {
    const result = normalizeCopilotUser({
      quota_reset_date_utc: "2026-10-01T00:00:00Z",
      quota_snapshots: {
        chat: {
          percent_remaining: 80,
          quota_reset_at: 0,
        },
        completions: {
          percent_remaining: 60,
          quota_reset_at: -1,
        },
        premium_interactions: {
          percent_remaining: 40,
          quota_reset_at: "0",
        },
      },
    });

    expect(result?.windows).toMatchObject([
      { id: "chat", resetsAt: "2026-10-01T00:00:00.000Z" },
      { id: "completions", resetsAt: "2026-10-01T00:00:00.000Z" },
      { id: "premium_interactions", resetsAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("can return a fresh entitlement report with no numeric windows", () => {
    const result = normalizeCopilotUser({
      login: "fixture-user",
      access_type_sku: "business",
    });

    expect(result).toMatchObject({
      plan: "business",
      account: { accountId: "fixture-user" },
      windows: [],
    });
  });

  it("skips quota snapshots without numeric remaining percentages", () => {
    const result = normalizeCopilotUser({
      login: "fixture-user",
      access_type_sku: "business",
      quota_snapshots: {
        chat: {
          quota_reset_at: 1785542400,
        },
      },
    });

    expect(result).toMatchObject({
      plan: "business",
      account: { accountId: "fixture-user" },
      windows: [],
    });
    expect(
      normalizeCopilotUser({
        quota_snapshots: {
          chat: {
            quota_reset_at: 1785542400,
          },
        },
      }),
    ).toBeUndefined();
  });

  it("rejects empty Copilot payloads as unusable quota", () => {
    expect(normalizeCopilotUser({})).toBeUndefined();
  });

  it("classifies GitHub 403 rate-limit responses before auth failures", async () => {
    writeAppsJson({
      fixture: {
        oauth_token: "valid-token",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1785542400",
            },
          }),
      ),
    );

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("rate_limited");
    expect(result.state.retryAfter).toBe("2026-08-01T00:00:00.000Z");
    expect(result.state.error).toBe(
      "GitHub Copilot quota endpoint rate limited",
    );
  });

  it("selects the public GitHub token when apps.json has multiple hosts", async () => {
    writeAppsJson({
      "ghe.example.test": {
        oauth_token: "enterprise-token",
      },
      "github.com": {
        oauth_token: "public-token",
      },
    });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer public-token",
      );
      return new Response(
        JSON.stringify({
          login: "fixture-user",
          access_type_sku: "individual",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not send host-specific enterprise tokens to the public endpoint", async () => {
    writeAppsJson({
      "ghe.example.test": {
        oauth_token: "enterprise-token",
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("auth_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects public GitHub token from app-id keyed auth entries", async () => {
    writeAppsJson({
      "ghe.example.test:Iv1.enterprise": {
        oauth_token: "enterprise-token",
      },
      "github.com:Iv1.public": {
        oauth_token: "public-token",
      },
    });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer public-token",
      );
      return new Response(
        JSON.stringify({
          login: "fixture-user",
          access_type_sku: "individual",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("resolves Copilot auth under XDG config home", async () => {
    const xdgConfigHome = join(tempDir!, "xdg-config");
    const authFile = join(xdgConfigHome, "github-copilot", "apps.json");
    delete process.env.GITHUB_COPILOT_APPS_JSON;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.HOME = join(tempDir!, "home");
    writeJson(authFile, {
      fixture: {
        oauth_token: "valid-token",
      },
    });

    const result = await inspectAuth({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.sources).toContainEqual({
      source: "apps-json",
      path: authFile,
      status: "available",
    });
  });

  it("resolves Copilot auth under Windows local app data", async () => {
    const localAppData = join(tempDir!, "local-app-data");
    const authFile = join(localAppData, "github-copilot", "apps.json");
    delete process.env.GITHUB_COPILOT_APPS_JSON;
    delete process.env.XDG_CONFIG_HOME;
    process.env.LOCALAPPDATA = localAppData;
    process.env.HOME = join(tempDir!, "home");
    writeJson(authFile, {
      fixture: {
        oauth_token: "valid-token",
      },
    });

    await withPlatform("win32", async () => {
      const result = await inspectAuth({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.sources).toContainEqual({
        source: "apps-json",
        path: authFile,
        status: "available",
      });
    });
  });
});

describe("GitHub Copilot credential sources", () => {
  const options = { allowKeychainPrompt: false, refreshCredentials: false };
  const quotaBody = JSON.stringify({
    login: "fixture-user",
    copilot_plan: "business",
    quota_snapshots: {
      premium_interactions: { percent_remaining: 40 },
    },
  });

  function cachedCopilotSnapshot(): ProviderQuota {
    return {
      provider: "copilot",
      label: "GitHub Copilot",
      source: "api",
      windows: [
        {
          id: "chat",
          label: "chat",
          kind: "monthly",
          percentUsed: 40,
          percentRemaining: 60,
          resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date().toISOString(),
        sourcesTried: ["api"],
      },
    };
  }

  function writeGhHosts(text: string): void {
    const dir = process.env.GH_CONFIG_DIR!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hosts.yml"), text, { mode: 0o600 });
  }

  function writeGhToken(token: string): void {
    writeGhHosts(
      `github.com:\n    oauth_token: ${token}\n    user: fixture-user\n`,
    );
  }

  /** Answers each bearer from a table; every request is recorded in order. */
  function stubUserEndpoint(statusByToken: Record<string, number>): {
    bearers: string[];
  } {
    const bearers: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        bearers.push(bearer);
        const status = statusByToken[bearer.replace(/^Bearer /, "")] ?? 401;
        return new Response(status === 200 ? quotaBody : "{}", { status });
      }),
    );
    return { bearers };
  }

  it("answers from a healthy apps.json exactly as before, without reading the GitHub CLI login", async () => {
    writeAppsJson({ "github.com": { oauth_token: "apps-token" } });
    writeGhToken("gho_cli_fixture");
    const api = stubUserEndpoint({ "apps-token": 200, gho_cli_fixture: 200 });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("fresh");
    expect(result.state.sourcesTried).toEqual(["api"]);
    expect(result.attempts).toEqual([{ source: "api", status: "success" }]);
    expect(api.bearers).toEqual(["Bearer apps-token"]);
  });

  it("reads quota from the GitHub CLI login when apps.json is absent, without degrading the absent store", async () => {
    writeGhToken("gho_cli_fixture");
    const api = stubUserEndpoint({ gho_cli_fixture: 200 });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("fresh");
    expect(result.plan).toBe("business");
    expect(result.windows.map((window) => window.id)).toEqual([
      "premium_interactions",
    ]);
    expect(result.attempts).toEqual([
      { source: "apps-json", status: "skipped", error: "credentials_missing" },
      {
        source: "copilot-cli:keychain",
        status: "skipped",
        error: "credentials_missing",
        degraded: false,
      },
      { source: "gh:hosts.yml", status: "success" },
    ]);
    expect(degradedSources(result.attempts)).toEqual([]);
    expect(api.bearers).toEqual(["Bearer gho_cli_fixture"]);
  });

  it("hands over to a live GitHub CLI login when the apps.json token is rejected, naming the superseded store", async () => {
    writeAppsJson({ "github.com": { oauth_token: "stale-apps-token" } });
    writeGhToken("gho_cli_fixture");
    const api = stubUserEndpoint({
      "stale-apps-token": 401,
      gho_cli_fixture: 200,
    });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("fresh");
    expect(api.bearers).toEqual([
      "Bearer stale-apps-token",
      "Bearer gho_cli_fixture",
    ]);
    expect(degradedSources(result.attempts)).toEqual([
      { source: "api", error: "GitHub Copilot sign-in required" },
    ]);
    expect(JSON.stringify(result)).not.toContain("gho_cli_fixture");
    expect(JSON.stringify(result)).not.toContain("stale-apps-token");
  });

  it("marks a present but structurally invalid apps.json as degraded when the GitHub CLI login answers", async () => {
    writeFileSync(process.env.GITHUB_COPILOT_APPS_JSON!, "{not json");
    writeGhToken("gho_cli_fixture");
    stubUserEndpoint({ gho_cli_fixture: 200 });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("fresh");
    expect(result.attempts?.[0]).toEqual({
      source: "apps-json",
      status: "skipped",
      error: "credentials_invalid",
      credentialPresent: true,
    });
    expect(degradedSources(result.attempts)).toEqual([
      { source: "apps-json", error: "credentials_invalid" },
    ]);
  });

  it("retires a cached snapshot on sign-out and keeps it for a transient failure", async () => {
    const snapshot: ProviderQuota = {
      provider: "copilot",
      label: "GitHub Copilot",
      source: "api",
      windows: [
        {
          id: "chat",
          label: "chat",
          kind: "monthly",
          percentUsed: 40,
          percentRemaining: 60,
          resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-09-12T12:00:00.000Z",
        sourcesTried: ["api"],
      },
    };
    writeCachedProviders([snapshot]);
    const signedOut = await fetchQuota(options);
    expect(signedOut.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "GitHub Copilot sign-in required",
    });
    expect(signedOut.windows).toEqual([]);
    expect(readCachedProvider("copilot")).toBeUndefined();

    const bare = await fetchQuota(options);
    expect(bare.state.status).toBe("auth_required");

    writeAppsJson({ "github.com": { oauth_token: "gho_live_fixture" } });
    writeCachedProviders([snapshot]);
    stubUserEndpoint({ gho_live_fixture: 503 });
    const transient = await fetchQuota(options);
    expect(transient.state.status).toBe("stale");
    expect(transient.windows.length).toBeGreaterThan(0);
    expect(readCachedProvider("copilot")).toBeDefined();
  });

  it("reports sign-in required when neither store holds a credential, without a request", async () => {
    const api = stubUserEndpoint({});

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("GitHub Copilot sign-in required");
    expect(api.bearers).toEqual([]);
    expect(result.attempts).toEqual([
      { source: "apps-json", status: "skipped", error: "credentials_missing" },
      {
        source: "copilot-cli:keychain",
        status: "skipped",
        error: "credentials_missing",
        degraded: false,
      },
      {
        source: "gh:hosts.yml",
        status: "skipped",
        error: "credentials_missing",
      },
    ]);
  });

  it("reports sign-in required only after every store's token is rejected, probing in declared order", async () => {
    writeAppsJson({ "github.com": { oauth_token: "stale-apps-token" } });
    writeGhToken("gho_revoked_fixture");
    const api = stubUserEndpoint({
      "stale-apps-token": 401,
      gho_revoked_fixture: 403,
    });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(api.bearers).toEqual([
      "Bearer stale-apps-token",
      "Bearer gho_revoked_fixture",
    ]);
    expect(result.attempts).toEqual([
      {
        source: "api",
        status: "failed",
        error: "GitHub Copilot sign-in required",
      },
      {
        source: "copilot-cli:keychain",
        status: "skipped",
        error: "credentials_missing",
        degraded: false,
      },
      {
        source: "gh:hosts.yml",
        status: "failed",
        error: "GitHub Copilot sign-in required",
      },
    ]);
  });

  it("has no refresh path: a rejected GitHub CLI token costs one request and no token exchange", async () => {
    writeGhHosts(
      "github.com:\n  oauth_token: gho_revoked_fixture\n  refresh_token: must-not-be-read\n",
    );
    const api = stubUserEndpoint({ gho_revoked_fixture: 401 });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(api.bearers).toEqual(["Bearer gho_revoked_fixture"]);
    expect(JSON.stringify(result)).not.toContain("must-not-be-read");
  });

  it.each([
    ["a server failure", 500, "error"],
    ["a rate limit", 429, "rate_limited"],
  ])(
    "stops at %s on apps.json instead of handing over to the GitHub CLI login",
    async (_label, status, providerStatus) => {
      writeAppsJson({ "github.com": { oauth_token: "apps-token" } });
      writeGhToken("gho_cli_fixture");
      const api = stubUserEndpoint({ "apps-token": status });

      const result = await fetchQuota(options);

      expect(result.state.status).toBe(providerStatus);
      expect(api.bearers).toEqual(["Bearer apps-token"]);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts?.[0]).toMatchObject({
        source: "api",
        status: "failed",
      });
    },
  );

  it("reports a GitHub CLI server failure as an error, not a sign-out", async () => {
    writeAppsJson({ "github.com": { oauth_token: "stale-apps-token" } });
    writeGhToken("gho_cli_fixture");
    const api = stubUserEndpoint({
      "stale-apps-token": 401,
      gho_cli_fixture: 500,
    });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("error");
    expect(result.state.error).not.toBe("GitHub Copilot sign-in required");
    expect(api.bearers).toEqual([
      "Bearer stale-apps-token",
      "Bearer gho_cli_fixture",
    ]);
    expect(result.attempts?.[0]).toEqual({
      source: "api",
      status: "failed",
      error: "GitHub Copilot sign-in required",
    });
    expect(result.attempts?.[2]).toMatchObject({
      source: "gh:hosts.yml",
      status: "failed",
      error: result.state.error,
    });
  });

  it("keeps the sign-in verdict when the GitHub CLI login is in the keyring", async () => {
    writeAppsJson({ "github.com": { oauth_token: "stale-apps-token" } });
    writeGhHosts(
      "github.com:\n    users:\n        fixture-user:\n    user: fixture-user\n",
    );
    const api = stubUserEndpoint({ "stale-apps-token": 401 });
    writeCachedProviders([cachedCopilotSnapshot()]);

    const result = await fetchQuota(options);

    expect(result.state).toMatchObject({
      status: "auth_required",
      stale: false,
      error: "GitHub Copilot sign-in required",
    });
    expect(result.windows).toEqual([]);
    expect(readCachedProvider("copilot")).toBeUndefined();
    expect(api.bearers).toEqual(["Bearer stale-apps-token"]);
    expect((await fetchQuota(options)).state.status).toBe("auth_required");
    expect(result.attempts?.[2]).toEqual({
      source: "gh:hosts.yml",
      status: "skipped",
      error: "credentials_keyring_storage",
      credentialPresent: true,
    });
  });

  it("keeps the sign-in verdict when the GitHub CLI store cannot be parsed", async () => {
    writeGhHosts("github.com:\n\toauth_token: gho_cli_fixture\n");
    const api = stubUserEndpoint({ gho_cli_fixture: 200 });
    writeCachedProviders([cachedCopilotSnapshot()]);

    const result = await fetchQuota(options);

    expect(result.state).toMatchObject({
      status: "auth_required",
      stale: false,
    });
    expect(result.windows).toEqual([]);
    expect(readCachedProvider("copilot")).toBeUndefined();
    expect(api.bearers).toEqual([]);
    expect((await fetchQuota(options)).state.status).toBe("auth_required");
    expect(result.attempts?.[2]).toEqual({
      source: "gh:hosts.yml",
      status: "skipped",
      error: "credentials_invalid",
      credentialPresent: true,
    });
  });

  it("does not send a GitHub Enterprise GitHub CLI token to the public endpoint", async () => {
    writeGhHosts(
      "ghe.example.test:\n  oauth_token: enterprise-fixture\n  user: fixture-user\n",
    );
    const api = stubUserEndpoint({ "enterprise-fixture": 200 });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(api.bearers).toEqual([]);
  });

  it("inspects both stores in declared order without printing a token", async () => {
    writeGhToken("gho_cli_fixture");

    const result = await inspectAuth(options);

    expect(result.sources).toEqual([
      {
        source: "apps-json",
        path: process.env.GITHUB_COPILOT_APPS_JSON,
        status: "missing",
      },
      {
        source: "copilot-cli:keychain",
        path: join(process.env.COPILOT_HOME!, "config.json"),
        status: "missing",
      },
      {
        source: "gh:hosts.yml",
        path: join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
        status: "available",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("gho_cli_fixture");
  });

  describe("presence in the human report", () => {
    const presence = (result: Awaited<ReturnType<typeof fetchQuota>>) =>
      providerPresence(result, copilotAdapter);

    it("folds a GitHub CLI login that shows no Copilot access", async () => {
      // A keyring login and an unparseable store describe gh, not Copilot, and
      // a token Copilot refuses is a definitive answer: a gh-only user folds.
      writeGhHosts(
        "github.com:\n    users:\n        fixture-user:\n    user: fixture-user\n",
      );
      stubUserEndpoint({});
      const keyring = await fetchQuota(options);
      expect(keyring.attempts?.[2]).toMatchObject({
        error: "credentials_keyring_storage",
        credentialPresent: true,
      });
      expect(presence(keyring)).toBe("absent");

      writeGhHosts("github.com:\n\toauth_token: gho_cli_fixture\n");
      expect(presence(await fetchQuota(options))).toBe("absent");

      writeGhToken("gho_revoked_fixture");
      const api = stubUserEndpoint({ gho_revoked_fixture: 403 });
      const rejected = await fetchQuota(options);
      expect(api.bearers).toEqual(["Bearer gho_revoked_fixture"]);
      expect(rejected.attempts?.[2]).toMatchObject({
        status: "failed",
      });
      expect(presence(rejected)).toBe("absent");
    });

    it("keeps Copilot in view when its CLI configuration cannot be confirmed as absent", async () => {
      const originalCopilotHome = process.env.COPILOT_HOME;
      process.env.COPILOT_HOME = join(tempDir!, "copilot");
      const config = join(process.env.COPILOT_HOME, "config.json");
      stubUserEndpoint({});
      try {
        // A Copilot CLI configuration that selects no account it can confirm.
        writeJson(config, { lastLoggedInUser: null });
        const unconfirmed = await fetchQuota(options);
        expect(unconfirmed.attempts?.[1]).toMatchObject({
          source: "copilot-cli:keychain",
          status: "skipped",
          error: "selected_account_unconfirmed",
          degraded: false,
        });
        expect(presence(unconfirmed)).toBe("attention");

        // A signed-in Copilot CLI on a platform with no supported secure store.
        writeJson(config, {
          lastLoggedInUser: { host: "https://github.com", login: "octocat" },
        });
        const unsupported = await withPlatform("linux", () =>
          fetchQuota(options),
        );
        expect(unsupported.attempts?.[1]).toMatchObject({
          error: "secure_store_unsupported",
          degraded: false,
        });
        expect(presence(unsupported)).toBe("attention");

        // Without a configuration the source is plainly absent.
        rmSync(config);
        expect(presence(await fetchQuota(options))).toBe("absent");
      } finally {
        if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = originalCopilotHome;
      }
    });

    it("keeps a Copilot CLI account awaiting Keychain consent in view", async () => {
      const originalCopilotHome = process.env.COPILOT_HOME;
      delete process.env.COPILOT_HOME;
      process.env.HOME = join(tempDir!, "home");
      stubUserEndpoint({});
      try {
        // apps.json and gh are absent; the native CLI is signed in but its
        // secure-store value still waits on --allow-keychain-prompt.
        writeJson(join(process.env.HOME, ".copilot", "config.json"), {
          lastLoggedInUser: { host: "https://github.com", login: "octocat" },
        });
        const gated = await withPlatform("win32", () => fetchQuota(options));

        expect(gated.attempts?.[1]).toMatchObject({
          source: "copilot-cli:keychain",
          status: "skipped",
          error: "keychain_prompt_required",
          degraded: false,
        });
        expect(gated.attempts?.[1].credentialPresent).toBeUndefined();
        expect(presence(gated)).toBe("attention");
      } finally {
        if (originalCopilotHome !== undefined)
          process.env.COPILOT_HOME = originalCopilotHome;
      }
    });

    it.each([
      ["a server failure", 500, "error"],
      ["a rate limit", 429, "rate_limited"],
    ])(
      "keeps Copilot in view after %s on a GitHub CLI credential",
      async (_label, status, providerStatus) => {
        writeGhToken("gho_cli_fixture");
        stubUserEndpoint({ gho_cli_fixture: status });

        const result = await fetchQuota(options);

        expect(result.state.status).toBe(providerStatus);
        expect(result.attempts?.[2]).toMatchObject({
          source: "gh:hosts.yml",
          status: "failed",
        });
        expect(result.attempts?.[2]?.degraded).toBeUndefined();
        expect(presence(result)).toBe("attention");
      },
    );

    it("keeps Copilot in view when its own store holds a credential", async () => {
      writeAppsJson({ "github.com": { oauth_token: "stale-apps-token" } });
      writeGhHosts(
        "github.com:\n    users:\n        fixture-user:\n    user: fixture-user\n",
      );
      stubUserEndpoint({ "stale-apps-token": 401 });

      expect(presence(await fetchQuota(options))).toBe("attention");
    });

    it("counts a Copilot reading through the GitHub CLI login as live", async () => {
      writeGhToken("gho_cli_fixture");
      stubUserEndpoint({ gho_cli_fixture: 200 });

      expect(presence(await fetchQuota(options))).toBe("live");
    });
  });
});
