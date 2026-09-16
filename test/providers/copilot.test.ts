import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degradedSources } from "../../src/lib/source-attempts.js";
import {
  fetchQuota,
  inspectAuth,
  normalizeCopilotUser,
} from "../../src/providers/copilot.js";

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
          quota_reset_at: 1785542400,
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
        resetsAt: "2026-08-01T00:00:00.000Z",
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
      { source: "apps-json", error: "GitHub Copilot sign-in required" },
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

  it("reports sign-in required when neither store holds a credential, without a request", async () => {
    const api = stubUserEndpoint({});

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("GitHub Copilot sign-in required");
    expect(api.bearers).toEqual([]);
    expect(result.attempts).toEqual([
      { source: "apps-json", status: "skipped", error: "credentials_missing" },
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
        source: "apps-json",
        status: "failed",
        error: "GitHub Copilot sign-in required",
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

  it("keeps the sign-in verdict when the GitHub CLI login is in the keyring", async () => {
    writeAppsJson({ "github.com": { oauth_token: "stale-apps-token" } });
    writeGhHosts(
      "github.com:\n    users:\n        fixture-user:\n    user: fixture-user\n",
    );
    const api = stubUserEndpoint({ "stale-apps-token": 401 });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("GitHub Copilot sign-in required");
    expect(api.bearers).toEqual(["Bearer stale-apps-token"]);
    expect(result.attempts?.[1]).toEqual({
      source: "gh:hosts.yml",
      status: "skipped",
      error: "credentials_keyring_storage",
      credentialPresent: true,
    });
  });

  it("keeps the sign-in verdict when the GitHub CLI store cannot be parsed", async () => {
    writeGhHosts("github.com:\n\toauth_token: gho_cli_fixture\n");
    const api = stubUserEndpoint({ gho_cli_fixture: 200 });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(api.bearers).toEqual([]);
    expect(result.attempts?.[1]).toEqual({
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
        source: "gh:hosts.yml",
        path: join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
        status: "available",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("gho_cli_fixture");
  });
});
