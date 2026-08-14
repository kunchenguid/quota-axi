import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuota, inspectAuth } from "../../src/providers/cline.js";

const options = { allowKeychainPrompt: false };

const originalClineConfig = process.env.CLINE_CONFIG;
const originalClineApiKey = process.env.CLINE_API_KEY;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

// Response shapes captured live against a Cline Pass account.
const ME_RESPONSE = {
  data: {
    id: "user_1",
    email: "adi@example.com",
    organizations: [
      {
        memberId: "mem_1",
        organizationId: "org_1",
        name: "Cyber Security RO",
        roles: ["owner"],
        active: true,
      },
    ],
  },
  success: true,
};

const BALANCE_RESPONSE = {
  data: { organizationId: "org_1", balance: 17075999 },
  success: true,
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cline-"));
  // Isolate the cache so stale-from-cache never masks a fresh/failed result.
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.CLINE_CONFIG = join(tempDir, "providers.json");
  delete process.env.CLINE_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  restore("CLINE_CONFIG", originalClineConfig);
  restore("CLINE_API_KEY", originalClineApiKey);
  restore("XDG_CACHE_HOME", originalXdgCacheHome);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeProvidersJson(accessToken: string): void {
  const path = process.env.CLINE_CONFIG!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        cline: {
          settings: {
            auth: { accessToken, metadata: { tokenType: "Bearer" } },
          },
        },
      },
    }),
  );
}

function stubApi(
  responses: Record<string, { status?: number; body: unknown }>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    const match = Object.keys(responses).find((key) => target.includes(key));
    if (!match) throw new Error(`unexpected fetch: ${target}`);
    const { status = 200, body } = responses[match]!;
    void init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("cline fetchQuota", () => {
  it("reports the daily credit balance for an authenticated account", async () => {
    writeProvidersJson("tok_ABC");
    const fetchMock = stubApi({
      "/users/me": { body: ME_RESPONSE },
      "/organizations/org_1/balance": { body: BALANCE_RESPONSE },
    });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("api");
    expect(result.credits).toEqual({ remaining: 17075999, unit: "credits" });
    expect(result.account).toEqual({
      email: "adi@example.com",
      organization: "Cyber Security RO",
    });
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({
      id: "daily_credits",
      kind: "credits",
    });
    // No daily maximum is exposed, so no percentage is fabricated.
    expect(result.windows[0]?.percentRemaining).toBeUndefined();
    expect(result.windows[0]?.percentUsed).toBeUndefined();
    expect(result.windows[0]?.resetsAt).toMatch(/T00:00:00\.000Z$/);

    // Bearer token forwarded; org resolved before the balance call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0]!;
    expect(String(firstUrl)).toContain("/users/me");
    expect(new Headers(firstInit?.headers).get("authorization")).toBe(
      "Bearer tok_ABC",
    );
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/organizations/org_1/balance",
    );
  });

  it("honors the CLINE_API_KEY inline token override", async () => {
    process.env.CLINE_API_KEY = "tok_ENV";
    const fetchMock = stubApi({
      "/users/me": { body: ME_RESPONSE },
      "/balance": { body: BALANCE_RESPONSE },
    });

    const result = await fetchQuota(options);

    expect(result.credits).toEqual({ remaining: 17075999, unit: "credits" });
    expect(
      new Headers(fetchMock.mock.calls[0]![1]?.headers).get("authorization"),
    ).toBe("Bearer tok_ENV");
  });

  it("reports sign-in required when no local token is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Cline sign-in required");
    expect(result.windows).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a 401 as sign-in required", async () => {
    writeProvidersJson("tok_STALE");
    stubApi({ "/users/me": { status: 401, body: { error: "unauthorized" } } });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Cline sign-in required");
    expect(result.windows).toHaveLength(0);
  });

  it("reports quota unavailable when the balance payload is malformed", async () => {
    writeProvidersJson("tok_ABC");
    stubApi({
      "/users/me": { body: ME_RESPONSE },
      "/balance": { body: { data: {}, success: true } },
    });

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("Cline quota unavailable");
  });
});

describe("cline inspectAuth", () => {
  it("reports available when a providers.json token is present", async () => {
    writeProvidersJson("tok_ABC");
    const report = await inspectAuth(options);
    expect(report.provider).toBe("cline");
    expect(report.sources[0]).toMatchObject({
      source: "cline-providers-json",
      status: "available",
    });
  });

  it("reports missing when no providers.json exists", async () => {
    const report = await inspectAuth(options);
    expect(report.sources[0]).toMatchObject({
      source: "cline-providers-json",
      status: "missing",
    });
  });

  it("reports available via the CLINE_API_KEY override", async () => {
    process.env.CLINE_API_KEY = "tok_ENV";
    const report = await inspectAuth(options);
    expect(report.sources[0]).toMatchObject({
      source: "cline-api-key",
      status: "available",
    });
  });
});
