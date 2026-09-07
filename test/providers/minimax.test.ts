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

  it("accepts the vendor's legacy remaining-count fallback only when no percentage exists", () => {
    expect(
      normalizeMiniMaxPayload({
        model_remains: [
          {
            model_name: "MiniMax-M3",
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
