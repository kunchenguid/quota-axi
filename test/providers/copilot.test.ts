import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchQuota,
  normalizeCopilotUser,
} from "../../src/providers/copilot.js";

const originalAppsJson = process.env.GITHUB_COPILOT_APPS_JSON;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
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
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function writeAppsJson(value: unknown): void {
  writeFileSync(process.env.GITHUB_COPILOT_APPS_JSON!, JSON.stringify(value));
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
});
