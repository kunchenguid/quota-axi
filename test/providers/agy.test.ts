import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuota, inspectAuth } from "../../src/providers/agy.js";

const options = { allowKeychainPrompt: false };

const originalAgyOauthToken = process.env.AGY_OAUTH_TOKEN;
const originalAntigravityOauthToken = process.env.ANTIGRAVITY_OAUTH_TOKEN;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

// Response shape captured live from cloudcode-pa retrieveUserQuota.
const BUCKETS_RESPONSE = {
  buckets: [
    {
      resetTime: "2026-08-15T18:16:05Z",
      tokenType: "REQUESTS",
      modelId: "gemini-2.5-flash",
      remainingFraction: 1,
    },
    {
      resetTime: "2026-08-15T18:16:05Z",
      tokenType: "REQUESTS",
      modelId: "gemini-2.5-flash-lite",
      remainingFraction: 1,
    },
    {
      resetTime: "2026-08-15T18:16:05Z",
      tokenType: "REQUESTS",
      modelId: "gemini-2.5-pro",
      remainingFraction: 1,
    },
    {
      resetTime: "2026-08-15T18:16:05Z",
      tokenType: "REQUESTS",
      modelId: "gemini-3.1-flash-lite",
      remainingFraction: 1,
    },
  ],
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-agy-"));
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.AGY_OAUTH_TOKEN = join(tempDir, "antigravity-oauth-token");
  delete process.env.ANTIGRAVITY_OAUTH_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  restore("AGY_OAUTH_TOKEN", originalAgyOauthToken);
  restore("ANTIGRAVITY_OAUTH_TOKEN", originalAntigravityOauthToken);
  restore("XDG_CACHE_HOME", originalXdgCacheHome);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeToken(accessToken: string, expiry: string): void {
  writeFileSync(
    process.env.AGY_OAUTH_TOKEN!,
    JSON.stringify({
      token: {
        access_token: accessToken,
        token_type: "Bearer",
        refresh_token: "refresh_xyz",
        expiry,
      },
      auth_method: "consumer",
    }),
  );
}

function futureIso(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

function pastIso(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("agy fetchQuota", () => {
  it("reports one real-percent window per model bucket", async () => {
    writeToken("tok_ABC", futureIso());
    const fetchMock = stubFetch(200, BUCKETS_RESPONSE);

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("oauth");
    expect(result.windows.map((window) => window.id)).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-3.1-flash-lite",
    ]);
    expect(result.windows[0]).toMatchObject({
      id: "gemini-2.5-flash",
      label: "gemini-2.5-flash",
      kind: "model",
      percentRemaining: 100,
      percentUsed: 0,
      resetsAt: "2026-08-15T18:16:05Z",
    });

    // POST retrieveUserQuota with Bearer token and empty JSON body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer tok_ABC",
    );
  });

  it("maps a partial remainingFraction to a percentage", async () => {
    writeToken("tok_ABC", futureIso());
    stubFetch(200, {
      buckets: [
        {
          resetTime: "2026-08-15T18:16:05Z",
          tokenType: "REQUESTS",
          modelId: "gemini-2.5-pro",
          remainingFraction: 0.5,
        },
      ],
    });

    const result = await fetchQuota(options);

    expect(result.windows[0]).toMatchObject({
      percentRemaining: 50,
      percentUsed: 50,
    });
  });

  it("reports access-token-expired without calling the API", async () => {
    writeToken("tok_STALE", pastIso());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Antigravity access token expired");
    expect(result.windows).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports sign-in required when no token is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Antigravity sign-in required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a 403 as sign-in required", async () => {
    writeToken("tok_ABC", futureIso());
    stubFetch(403, { error: { status: "PERMISSION_DENIED" } });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Antigravity sign-in required");
    expect(result.windows).toHaveLength(0);
  });

  it("reports quota unavailable when no buckets are returned", async () => {
    writeToken("tok_ABC", futureIso());
    stubFetch(200, { buckets: [] });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("Antigravity quota unavailable");
  });
});

describe("agy inspectAuth", () => {
  it("reports available for a present, unexpired token", async () => {
    writeToken("tok_ABC", futureIso());
    const report = await inspectAuth(options);
    expect(report.provider).toBe("agy");
    expect(report.sources[0]).toMatchObject({
      source: "antigravity-oauth-token",
      status: "available",
    });
  });

  it("reports expired when the token expiry is in the past", async () => {
    writeToken("tok_STALE", pastIso());
    const report = await inspectAuth(options);
    expect(report.sources[0]).toMatchObject({
      source: "antigravity-oauth-token",
      status: "expired",
    });
  });

  it("reports missing when no token file exists", async () => {
    const report = await inspectAuth(options);
    expect(report.sources[0]).toMatchObject({
      source: "antigravity-oauth-token",
      status: "missing",
    });
  });
});
