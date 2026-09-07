import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMiniMaxAdapter,
  extractMiniMaxCliCredential,
  extractMiniMaxCredential,
  normalizeMiniMaxPayload,
  resolveMiniMaxCredential,
  resolveMiniMaxCredentials,
} from "../../src/providers/minimax.js";
import { withQuotaSemantics } from "../../src/interpretation.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-minimax-key-42";
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`test/fixtures/minimax/${name}.json`, "utf8"));

describe("MiniMax provider", () => {
  it("reads the first-party token-plan response and preserves model scopes", async () => {
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.minimax.io/v1/token_plan/remains",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${KEY}`,
        );
        return new Response(JSON.stringify(fixture("quota")), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    const report = await createMiniMaxAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "pi:minimax",
        path: "/auth.json",
        baseUrl: "https://api.minimax.io",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "minimax",
      source: "api",
      state: { status: "fresh", stale: false },
      attempts: [{ source: "pi:minimax", status: "success" }],
    });
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "model:minimax-m3:5h",
        kind: "model",
        percentRemaining: 91,
        windowSeconds: 18_000,
      }),
      expect.objectContaining({
        id: "model:minimax-m3:7d",
        kind: "model",
        percentRemaining: 70,
        windowSeconds: 604_800,
      }),
      expect.objectContaining({
        id: "model:minimax-m2.7-highspeed:5h",
        percentRemaining: 50,
      }),
      expect.objectContaining({
        id: "model:minimax-m2.7-highspeed:7d",
        kind: "model",
        percentRemaining: 67,
      }),
    ]);
    const interpreted = withQuotaSemantics(report, "2026-09-01T00:00:00.000Z");
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "known",
      effectiveAvailability: [
        {
          scope: "model:minimax-m3",
          status: "known",
          effectivePercentRemaining: 70,
        },
        {
          scope: "model:minimax-m2.7-highspeed",
          status: "known",
          effectivePercentRemaining: 50,
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("uses the balance endpoint for a secret API key without inventing windows", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.minimax.io/account/query_balance",
      );
      return new Response(JSON.stringify(fixture("balance")));
    });
    const report = await createMiniMaxAdapter({
      credential: () => ({
        status: "available",
        key: "sk-api-synthetic",
        source: "minimax:config.json",
        baseUrl: "https://api.minimax.io",
      }),
      fetch: request,
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      windows: [],
      credits: { remaining: 12.5, unit: "usd" },
      state: { status: "fresh" },
    });
  });

  it("tries CLI config after a Pi key is rejected", async () => {
    const deleteCachedProvider = vi.fn();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === "Bearer stale-pi-key") {
        return new Response(null, { status: 401 });
      }
      return new Response(JSON.stringify(fixture("balance")));
    });

    const report = await createMiniMaxAdapter({
      credential: () => [
        {
          status: "available",
          key: "stale-pi-key",
          source: "pi:minimax",
          baseUrl: "https://api.minimax.io",
        },
        {
          status: "available",
          key: "sk-api-synthetic",
          source: "minimax:config.json",
          baseUrl: "https://api.minimax.io",
        },
      ],
      fetch: request,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: {
        status: "fresh",
        sourcesTried: ["pi:minimax", "minimax:config.json"],
      },
      attempts: [
        {
          source: "pi:minimax",
          status: "failed",
          error: "provider_auth_rejected",
        },
        { source: "minimax:config.json", status: "success" },
      ],
      credits: { remaining: 12.5, unit: "usd" },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(deleteCachedProvider).not.toHaveBeenCalled();
  });

  it.each([1004, 2049])(
    "tries CLI config after MiniMax application auth error %s",
    async (statusCode) => {
      const request = vi.fn(async (_url: string, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization");
        if (bearer === "Bearer stale-pi-key") {
          return new Response(
            JSON.stringify({ base_resp: { status_code: statusCode } }),
          );
        }
        return new Response(JSON.stringify(fixture("balance")));
      });

      const report = await createMiniMaxAdapter({
        credential: () => [
          {
            status: "available",
            key: "stale-pi-key",
            source: "pi:minimax",
            baseUrl: "https://api.minimax.io",
          },
          {
            status: "available",
            key: "sk-api-synthetic",
            source: "minimax:config.json",
            baseUrl: "https://api.minimax.io",
          },
        ],
        fetch: request,
        deleteCachedProvider: vi.fn(),
      }).fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        state: { status: "fresh" },
        attempts: [
          {
            source: "pi:minimax",
            status: "failed",
            error: "provider_auth_rejected",
          },
          { source: "minimax:config.json", status: "success" },
        ],
        credits: { remaining: 12.5, unit: "usd" },
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("reports MiniMax application rate limits", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ base_resp: { status_code: 1002 } })),
    );

    const report = await createMiniMaxAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "pi:minimax",
        baseUrl: "https://api.minimax.io",
      }),
      fetch: request,
      readCachedProvider: () => undefined,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "rate_limited", error: "provider_rate_limited" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("accepts the vendor's legacy remaining-count fallback only when no percentage exists", () => {
    expect(
      normalizeMiniMaxPayload({
        model_remains: [
          {
            model_name: "MiniMax-M3",
            start_time: 1788264000000,
            end_time: 1788282000000,
            current_interval_total_count: 100,
            current_interval_usage_count: 25,
            current_interval_status: 1,
          },
        ],
      }).windows,
    ).toEqual([
      expect.objectContaining({
        id: "model:minimax-m3:5h",
        percentRemaining: 25,
        percentUsed: 75,
      }),
    ]);
    expect(normalizeMiniMaxPayload({ model_remains: [{}] })).toEqual({
      windows: [],
    });
  });

  it("omits MiniMax model rows with no allocation", () => {
    expect(
      normalizeMiniMaxPayload({
        model_remains: [
          {
            model_name: "Speech-HD",
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
            current_interval_remaining_percent: 100,
            current_interval_status: 3,
            current_weekly_total_count: 0,
            current_weekly_usage_count: 0,
            current_weekly_remaining_percent: 100,
            current_weekly_status: 3,
          },
        ],
      }).windows,
    ).toEqual([]);
  });

  it("labels MiniMax interval windows from reported duration", () => {
    expect(
      normalizeMiniMaxPayload({
        model_remains: [
          {
            model_name: "Speech-HD",
            start_time: 1788264000000,
            end_time: 1788350400000,
            current_interval_total_count: 100,
            current_interval_usage_count: 75,
            current_interval_status: 1,
          },
        ],
      }).windows,
    ).toEqual([
      expect.objectContaining({
        id: "model:speech-hd:window:1d",
        label: "Speech-HD 1d",
        percentRemaining: 75,
        windowSeconds: 86_400,
      }),
    ]);
  });

  it("preserves rate limits with an invalid Retry-After date", async () => {
    const report = await createMiniMaxAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "pi:minimax",
        baseUrl: "https://api.minimax.io",
      }),
      fetch: async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "999999999999999999999" },
        }),
      readCachedProvider: () => undefined,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: { status: "rate_limited", error: "provider_rate_limited" },
    });
    expect(report.state.retryAfter).toBeUndefined();
  });

  it("reports missing and invalid local credentials without making a request", async () => {
    const fetch = vi.fn();
    const deleteCachedProvider = vi.fn();
    const missing = await createMiniMaxAdapter({
      credential: () => ({ status: "missing", source: "pi:minimax" }),
      fetch: fetch as typeof globalThis.fetch,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);
    const invalid = await createMiniMaxAdapter({
      credential: () => ({
        status: "invalid",
        source: "minimax:config.json",
        error: "credential_missing",
      }),
      fetch: fetch as typeof globalThis.fetch,
      deleteCachedProvider,
    }).inspectAuth(OPTIONS);

    expect(missing).toMatchObject({
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "minimax_credential_unavailable",
      },
    });
    expect(invalid.sources).toEqual([
      expect.objectContaining({
        source: "minimax:config.json",
        status: "invalid",
        error: "credential_missing",
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(deleteCachedProvider).toHaveBeenCalledWith("minimax");
  });

  it("recognizes provider-owned config and Pi auth shapes", () => {
    expect(
      extractMiniMaxCredential(
        { minimax: { type: "api_key", key: KEY } },
        "/auth.json",
      ),
    ).toMatchObject({
      status: "available",
      key: KEY,
    });
    expect(
      extractMiniMaxCliCredential(
        { api_key: KEY, region: "cn" },
        "/config.json",
      ),
    ).toMatchObject({
      status: "available",
      key: KEY,
      baseUrl: "https://api.minimaxi.com",
    });
    expect(extractMiniMaxCredential({ minimax: KEY }, "/auth.json")).toEqual({
      status: "invalid",
      source: "pi:minimax",
      path: "/auth.json",
      error: "credential_missing",
    });
  });

  it("uses co-stored MiniMax CLI credentials in OAuth-first order", async () => {
    const originalHome = process.env.HOME;
    const originalPiDir = process.env.PI_CODING_AGENT_DIR;
    const originalMmxDir = process.env.MMX_CONFIG_DIR;
    const originalApiKey = process.env.MINIMAX_API_KEY;
    const tempDir = mkdtempSync(join(tmpdir(), "quota-axi-minimax-"));
    const mmxDir = join(tempDir, "mmx");
    try {
      process.env.HOME = tempDir;
      process.env.PI_CODING_AGENT_DIR = join(tempDir, "missing-pi");
      process.env.MMX_CONFIG_DIR = mmxDir;
      delete process.env.MINIMAX_API_KEY;
      mkdirSync(mmxDir, { recursive: true });
      writeFileSync(
        join(mmxDir, "config.json"),
        JSON.stringify({
          api_key: "sk-api-synthetic",
          oauth: { access_token: "stale-oauth-token" },
        }),
      );
      const request = vi.fn(async (_url: string, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization");
        if (bearer === "Bearer stale-oauth-token") {
          return new Response(null, { status: 401 });
        }
        return new Response(JSON.stringify(fixture("balance")));
      });

      const report = await createMiniMaxAdapter({
        credential: resolveMiniMaxCredentials,
        fetch: request,
      }).fetchQuota(OPTIONS);

      expect(
        request.mock.calls.map(([, init]) =>
          new Headers(init?.headers).get("authorization"),
        ),
      ).toEqual(["Bearer stale-oauth-token", "Bearer sk-api-synthetic"]);
      expect(report).toMatchObject({
        state: { status: "fresh" },
        credits: { remaining: 12.5, unit: "usd" },
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalPiDir;
      if (originalMmxDir === undefined) delete process.env.MMX_CONFIG_DIR;
      else process.env.MMX_CONFIG_DIR = originalMmxDir;
      if (originalApiKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = originalApiKey;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the shared Pi auth path expansion", () => {
    const originalHome = process.env.HOME;
    const originalPiDir = process.env.PI_CODING_AGENT_DIR;
    const originalMmxDir = process.env.MMX_CONFIG_DIR;
    const originalApiKey = process.env.MINIMAX_API_KEY;
    const tempDir = mkdtempSync(join(tmpdir(), "quota-axi-minimax-"));
    const piDir = join(tempDir, "pi-agent");
    try {
      process.env.HOME = tempDir;
      process.env.PI_CODING_AGENT_DIR = "~\\pi-agent";
      process.env.MMX_CONFIG_DIR = join(tempDir, "missing-mmx");
      delete process.env.MINIMAX_API_KEY;
      mkdirSync(piDir, { recursive: true });
      writeFileSync(
        join(piDir, "auth.json"),
        JSON.stringify({ minimax: { api_key: KEY } }),
      );

      expect(resolveMiniMaxCredential()).toMatchObject({
        status: "available",
        key: KEY,
        source: "pi:minimax",
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalPiDir;
      if (originalMmxDir === undefined) delete process.env.MMX_CONFIG_DIR;
      else process.env.MMX_CONFIG_DIR = originalMmxDir;
      if (originalApiKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = originalApiKey;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls through to CLI config while reporting a broken Pi source", async () => {
    const originalPiDir = process.env.PI_CODING_AGENT_DIR;
    const originalMmxDir = process.env.MMX_CONFIG_DIR;
    const originalApiKey = process.env.MINIMAX_API_KEY;
    const tempDir = mkdtempSync(join(tmpdir(), "quota-axi-minimax-"));
    const piDir = join(tempDir, "pi-agent");
    const mmxDir = join(tempDir, "mmx");
    try {
      process.env.PI_CODING_AGENT_DIR = piDir;
      process.env.MMX_CONFIG_DIR = mmxDir;
      delete process.env.MINIMAX_API_KEY;
      mkdirSync(piDir, { recursive: true });
      mkdirSync(mmxDir, { recursive: true });
      writeFileSync(
        join(piDir, "auth.json"),
        JSON.stringify({ minimax: { api_key: "${MINIMAX_API_KEY}" } }),
      );
      writeFileSync(
        join(mmxDir, "config.json"),
        JSON.stringify({ api_key: "sk-api-synthetic" }),
      );
      const request = vi.fn(
        async () => new Response(JSON.stringify(fixture("balance"))),
      );

      const report = await createMiniMaxAdapter({
        credential: resolveMiniMaxCredential,
        fetch: request,
        now: () => Date.parse("2026-09-01T00:00:00.000Z"),
      }).fetchQuota(OPTIONS);
      const interpreted = withQuotaSemantics(
        report,
        "2026-09-01T00:00:00.000Z",
      );

      expect(report).toMatchObject({
        state: {
          status: "fresh",
          sourcesTried: ["pi:minimax", "minimax:config.json"],
        },
        attempts: [
          {
            source: "pi:minimax",
            status: "failed",
            error: "credential_missing",
          },
          { source: "minimax:config.json", status: "success" },
        ],
        credits: { remaining: 12.5, unit: "usd" },
      });
      expect(interpreted.state.degradedSources).toEqual([
        { source: "pi:minimax", error: "credential_missing" },
      ]);
      expect(request).toHaveBeenCalledOnce();
    } finally {
      if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalPiDir;
      if (originalMmxDir === undefined) delete process.env.MMX_CONFIG_DIR;
      else process.env.MMX_CONFIG_DIR = originalMmxDir;
      if (originalApiKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = originalApiKey;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps cache on a later transient source failure", async () => {
    const originalPiDir = process.env.PI_CODING_AGENT_DIR;
    const originalMmxDir = process.env.MMX_CONFIG_DIR;
    const originalApiKey = process.env.MINIMAX_API_KEY;
    const tempDir = mkdtempSync(join(tmpdir(), "quota-axi-minimax-"));
    const piDir = join(tempDir, "pi-agent");
    const mmxFile = join(tempDir, "mmx-file");
    try {
      process.env.PI_CODING_AGENT_DIR = piDir;
      process.env.MMX_CONFIG_DIR = mmxFile;
      delete process.env.MINIMAX_API_KEY;
      mkdirSync(piDir, { recursive: true });
      writeFileSync(
        join(piDir, "auth.json"),
        JSON.stringify({ minimax: { api_key: "${MINIMAX_API_KEY}" } }),
      );
      writeFileSync(mmxFile, "not a directory");
      const deleteCachedProvider = vi.fn();

      const report = await createMiniMaxAdapter({
        credential: resolveMiniMaxCredential,
        fetch: vi.fn() as typeof globalThis.fetch,
        deleteCachedProvider,
      }).fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        state: { status: "error", error: "credential_resolution_failed" },
        attempts: [
          {
            source: "pi:minimax",
            status: "failed",
            error: "credential_missing",
          },
          {
            source: "minimax:config.json",
            status: "failed",
            error: "credential_resolution_failed",
          },
        ],
      });
      expect(deleteCachedProvider).not.toHaveBeenCalled();
    } finally {
      if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalPiDir;
      if (originalMmxDir === undefined) delete process.env.MMX_CONFIG_DIR;
      else process.env.MMX_CONFIG_DIR = originalMmxDir;
      if (originalApiKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = originalApiKey;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls through to CLI config when the Pi path cannot be read", async () => {
    const originalPiDir = process.env.PI_CODING_AGENT_DIR;
    const originalMmxDir = process.env.MMX_CONFIG_DIR;
    const originalApiKey = process.env.MINIMAX_API_KEY;
    const tempDir = mkdtempSync(join(tmpdir(), "quota-axi-minimax-"));
    const piFile = join(tempDir, "pi-agent-file");
    const mmxDir = join(tempDir, "mmx");
    try {
      process.env.PI_CODING_AGENT_DIR = piFile;
      process.env.MMX_CONFIG_DIR = mmxDir;
      delete process.env.MINIMAX_API_KEY;
      writeFileSync(piFile, "not a directory");
      mkdirSync(mmxDir, { recursive: true });
      writeFileSync(
        join(mmxDir, "config.json"),
        JSON.stringify({ api_key: "sk-api-synthetic" }),
      );
      const request = vi.fn(
        async () => new Response(JSON.stringify(fixture("balance"))),
      );

      const report = await createMiniMaxAdapter({
        credential: resolveMiniMaxCredential,
        fetch: request,
      }).fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        state: { status: "fresh" },
        attempts: [
          {
            source: "pi:minimax",
            status: "failed",
            error: "file_read_error",
          },
          { source: "minimax:config.json", status: "success" },
        ],
      });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalPiDir;
      if (originalMmxDir === undefined) delete process.env.MMX_CONFIG_DIR;
      else process.env.MMX_CONFIG_DIR = originalMmxDir;
      if (originalApiKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = originalApiKey;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
