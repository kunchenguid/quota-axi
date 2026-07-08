import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-copilot-"));
  process.env.GITHUB_COPILOT_APPS_JSON = join(tempDir, "apps.json");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
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

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("rate_limited");
    expect(result.state.retryAfter).toBe("2026-08-01T00:00:00.000Z");
    expect(result.state.error).toBe(
      "GitHub Copilot quota endpoint rate limited",
    );
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

    const result = await inspectAuth({ allowKeychainPrompt: false });

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
      const result = await inspectAuth({ allowKeychainPrompt: false });

      expect(result.sources).toContainEqual({
        source: "apps-json",
        path: authFile,
        status: "available",
      });
    });
  });
});
