import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSub2apiAdapter,
  normalizeSub2apiUsage,
} from "../../src/providers/sub2api.js";

let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("sub2API usage parsing", () => {
  it("supports remaining, nested quota remaining, and balance payloads", () => {
    expect(normalizeSub2apiUsage({ remaining: 12.5, unit: "USD" })).toEqual({
      isValid: true,
      remaining: 12.5,
      unit: "usd",
    });
    expect(
      normalizeSub2apiUsage({
        quota: { remaining: "8.25", unit: "credits" },
        is_active: 1,
      }),
    ).toEqual({ isValid: true, remaining: 8.25, unit: "credits" });
    expect(normalizeSub2apiUsage({ balance: 3, isValid: false })).toEqual({
      isValid: false,
      remaining: 3,
      unit: "usd",
    });
  });

  it("rejects payloads without a finite balance", () => {
    expect(normalizeSub2apiUsage({})).toBeUndefined();
    expect(
      normalizeSub2apiUsage({ remaining: "not-a-number" }),
    ).toBeUndefined();
    expect(
      normalizeSub2apiUsage({ remaining: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
  });
});

describe("sub2API provider", () => {
  it("uses explicit environment configuration and reports a USD balance", async () => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.toString()).toBe("https://sub2.example.test/v1/usage");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-key",
      );
      expect(init?.redirect).toBe("manual");
      return Response.json({ remaining: 42, unit: "USD" });
    });
    const adapter = createSub2apiAdapter({
      environment: {
        SUB2API_BASE_URL: "https://sub2.example.test",
        SUB2API_API_KEY: "fixture-key",
      },
      fetch: fetchMock as typeof fetch,
      now: () => Date.parse("2026-07-30T00:00:00Z"),
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      provider: "sub2api",
      label: "sub2API",
      source: "api",
      windows: [],
      credits: { remaining: 42, unit: "usd" },
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-07-30T00:00:00.000Z",
        sourcesTried: ["sub2api-env"],
      },
      attempts: [{ source: "sub2api-env", status: "success" }],
    });
  });

  it("discovers the active sub2api provider and API key from Codex files", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-sub2api-"));
    writeFileSync(
      join(tempDir, "config.toml"),
      [
        'model_provider = "sub2api"',
        "",
        "[model_providers.sub2api]",
        'base_url = "https://sub2.example.test/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
      ].join("\n"),
    );
    writeFileSync(
      join(tempDir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "codex-fixture-key" }),
    );
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.toString()).toBe("https://sub2.example.test/v1/usage");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer codex-fixture-key",
      );
      return Response.json({ quota: { remaining: 9, unit: "USD" } });
    });
    const adapter = createSub2apiAdapter({
      environment: { CODEX_HOME: tempDir },
      fetch: fetchMock as typeof fetch,
    });

    const auth = await adapter.inspectAuth({ allowKeychainPrompt: false });
    const quota = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(auth).toEqual({
      provider: "sub2api",
      sources: [
        {
          source: "codex-config",
          path: join(tempDir, "config.toml"),
          status: "available",
          credentialPresent: true,
        },
      ],
    });
    expect(quota.credits).toEqual({ remaining: 9, unit: "usd" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed on partial environment configuration", async () => {
    const fetchMock = vi.fn();
    const adapter = createSub2apiAdapter({
      environment: { SUB2API_BASE_URL: "https://sub2.example.test" },
      fetch: fetchMock as typeof fetch,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result.state).toMatchObject({
      status: "auth_required",
      sourcesTried: ["sub2api-env"],
    });
    expect(result.attempts).toEqual([
      {
        source: "sub2api-env",
        status: "skipped",
        error: "sub2api_environment_incomplete",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects insecure non-loopback base URLs before sending credentials", async () => {
    const fetchMock = vi.fn();
    const adapter = createSub2apiAdapter({
      environment: {
        SUB2API_BASE_URL: "http://sub2.example.test",
        SUB2API_API_KEY: "fixture-key",
      },
      fetch: fetchMock as typeof fetch,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.attempts?.[0]?.error).toBe("sub2api_base_url_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats inactive accounts and rejected credentials as auth failures", async () => {
    const inactive = createSub2apiAdapter({
      environment: fixtureEnvironment(),
      fetch: (async () =>
        Response.json({ balance: 1, is_active: false })) as typeof fetch,
    });
    const rejected = createSub2apiAdapter({
      environment: fixtureEnvironment(),
      fetch: (async () => new Response("{}", { status: 401 })) as typeof fetch,
    });

    const inactiveResult = await inactive.fetchQuota({
      allowKeychainPrompt: false,
    });
    const rejectedResult = await rejected.fetchQuota({
      allowKeychainPrompt: false,
    });

    expect(inactiveResult.state.status).toBe("auth_required");
    expect(inactiveResult.attempts?.[0]?.error).toBe(
      "sub2api_account_inactive",
    );
    expect(rejectedResult.state.status).toBe("auth_required");
    expect(rejectedResult.attempts?.[0]?.error).toBe(
      "sub2api_credentials_rejected",
    );
  });

  it("does not follow redirects that could receive the bearer token", async () => {
    const cancel = vi.fn();
    const adapter = createSub2apiAdapter({
      environment: fixtureEnvironment(),
      fetch: (async (_url: URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("redirect"));
            },
            cancel,
          }),
          {
            status: 302,
            headers: { location: "https://other.example.test/v1/usage" },
          },
        );
      }) as typeof fetch,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("error");
    expect(result.attempts?.[0]?.error).toBe("sub2api_endpoint_failed");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized response bodies", async () => {
    const adapter = createSub2apiAdapter({
      environment: fixtureEnvironment(),
      fetch: (async () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": "65537" },
        })) as typeof fetch,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("error");
    expect(result.attempts?.[0]?.error).toBe("sub2api_response_too_large");
  });

  it("reports missing Codex configuration without reading arbitrary auth", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-sub2api-"));
    mkdirSync(tempDir, { recursive: true });
    const adapter = createSub2apiAdapter({
      environment: { CODEX_HOME: tempDir },
      fetch: vi.fn() as typeof fetch,
    });

    const auth = await adapter.inspectAuth({ allowKeychainPrompt: false });

    expect(auth).toEqual({
      provider: "sub2api",
      sources: [
        {
          source: "codex-config",
          path: join(tempDir, "config.toml"),
          status: "missing",
          error: "codex_config_missing",
        },
      ],
    });
  });

  it("reports configuration read failures as errors rather than sign-in state", async () => {
    const adapter = createSub2apiAdapter({
      environment: {},
      readFile: async () => {
        throw new Error("fixture read failure");
      },
      fetch: vi.fn() as typeof fetch,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("error");
    expect(result.attempts).toEqual([
      {
        source: "codex-config",
        status: "failed",
        error: "codex_config_read_failed",
      },
    ]);
  });
});

function fixtureEnvironment(): Record<string, string> {
  return {
    SUB2API_BASE_URL: "https://sub2.example.test",
    SUB2API_API_KEY: "fixture-key",
  };
}
