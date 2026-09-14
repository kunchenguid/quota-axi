import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createMetaAdapter,
  META_MUSE_MINT_URL,
  normalizeMetaMusePayload,
  resolveMetaCredential,
  type MetaCredentialResolution,
} from "../../src/providers/meta.js";
import type { ProviderQuota } from "../../src/types.js";
import { renderQuotaTui } from "../../src/tui.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const IDENTITY = "synthetic-meta-identity-bearer";
const PATH = "/synthetic/pi/auth.json";
const NOW = Date.parse("2026-09-14T18:00:00.000Z");
const LIVE_FIXTURE = JSON.parse(
  readFileSync(
    new URL("../fixtures/meta-muse-mint-redacted.json", import.meta.url),
    "utf8",
  ),
) as unknown;

const credential = (
  overrides: Partial<MetaCredentialResolution> = {},
): MetaCredentialResolution => ({
  status: "available",
  identityBearer: IDENTITY,
  path: PATH,
  storedExpired: false,
  credentialPresent: true,
  ...overrides,
});

const testAdapter = (overrides: Parameters<typeof createMetaAdapter>[0] = {}) =>
  createMetaAdapter({
    readCachedProvider: () => undefined,
    deleteCachedProvider: vi.fn(),
    ...overrides,
  });

describe("Meta Muse provider", () => {
  it("resolves only Pi meta OAuth identity bearers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-meta-auth-"));
    const path = join(directory, "auth.json");
    try {
      expect(await resolveMetaCredential(path, NOW)).toEqual({
        status: "missing",
        path,
      });

      writeFileSync(path, "not-json");
      expect(await resolveMetaCredential(path, NOW)).toMatchObject({
        status: "invalid",
        credentialPresent: true,
      });

      writeFileSync(
        path,
        JSON.stringify({
          meta: {
            type: "oauth",
            access: "model-key-must-not-be-selected",
            refresh: IDENTITY,
            expires: NOW - 1,
          },
        }),
      );
      expect(await resolveMetaCredential(path, NOW)).toEqual({
        status: "available",
        identityBearer: IDENTITY,
        path,
        storedExpired: true,
        credentialPresent: true,
      });

      writeFileSync(
        path,
        JSON.stringify({ meta: { type: "api_key", key: "x" } }),
      );
      expect(await resolveMetaCredential(path, NOW)).toMatchObject({
        status: "unsupported",
        credentialPresent: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads the live fixture with the Pi identity bearer and discards minted secrets", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...(LIVE_FIXTURE as object),
            api_key: "minted-model-key-must-disappear",
            base_url: "https://model-endpoint.invalid",
            user_email: "person@example.invalid",
          }),
        ),
    );
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: request,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toBe(META_MUSE_MINT_URL);
    const init = request.mock.calls[0][1];
    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      credentials: "omit",
      redirect: "manual",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${IDENTITY}`);
    expect(headers.get("x-api-version")).toBe("1.0.0");
    expect(report).toMatchObject({
      provider: "meta",
      label: "Meta Muse",
      source: "pi:meta",
      windows: [
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed: 0,
          percentRemaining: 100,
          windowSeconds: 604_800,
          resetsAt: "2026-09-21T00:00:00.000Z",
        },
        {
          id: "window:300m",
          label: "5h",
          kind: "session",
          percentUsed: 1,
          percentRemaining: 99,
          windowSeconds: 18_000,
          resetsAt: "2026-09-14T22:29:32.000Z",
        },
      ],
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        refreshedAt: "2026-09-14T18:00:00.000Z",
      },
    });
    const serialized = JSON.stringify(report);
    for (const secret of [
      IDENTITY,
      "minted-model-key-must-disappear",
      "person@example.invalid",
      "model-endpoint.invalid",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps recognized windows but makes combined availability unknown", () => {
    const normalized = normalizeMetaMusePayload(LIVE_FIXTURE);
    const quota: ProviderQuota = {
      provider: "meta",
      label: "Meta Muse",
      source: "pi:meta",
      windows: normalized.windows,
      state: { status: "fresh", stale: false, authStatus: "usable" },
    };

    const interpreted = withQuotaSemantics(quota, "2026-09-14T18:00:00.000Z");
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
    });
  });

  it("renders weekly and rolling usage in the generic TUI card", () => {
    const normalized = normalizeMetaMusePayload(LIVE_FIXTURE);
    const quota = withQuotaSemantics(
      {
        provider: "meta",
        label: "Meta Muse",
        source: "pi:meta",
        windows: normalized.windows,
        state: {
          status: "fresh",
          stale: false,
          authStatus: "usable",
          refreshedAt: "2026-09-14T18:00:00.000Z",
        },
      },
      "2026-09-14T18:00:00.000Z",
    );

    const rendered = renderQuotaTui(
      {
        generatedAt: "2026-09-14T18:00:00.000Z",
        schemaVersion: 5,
        providers: [quota],
      },
      { columns: 49, colorDepth: "none", timeZone: "UTC" },
    );

    expect(rendered).toContain("● meta");
    expect(rendered).toContain("pi:meta");
    expect(rendered).toMatch(/per-window usage\s+no combined bound/);
    expect(rendered).toMatch(/5h\s+.*99%/);
    expect(rendered).toMatch(/week\s+.*100%/);

    const colored = renderQuotaTui(
      {
        generatedAt: "2026-09-14T18:00:00.000Z",
        schemaVersion: 5,
        providers: [quota],
      },
      { columns: 49, colorDepth: "truecolor", timeZone: "UTC" },
    );
    expect(colored).toContain("\x1b[1;38;2;8;102;255m");
  });

  it("rejects invalid percentages and durations without clamping", () => {
    const normalized = normalizeMetaMusePayload({
      subs_usage: {
        weekly: { used_percent: 101, resets_at: 1_789_948_800 },
        window: {
          used_percent: -1,
          window_duration_mins: 300.5,
          resets_at: "not-a-time",
        },
      },
    });

    expect(normalized.windows).toEqual([]);
    expect(normalized.untrustedWindowIds).toEqual(["weekly", "window"]);
  });

  it("preserves usage when reset timestamps are absent or invalid", () => {
    const normalized = normalizeMetaMusePayload({
      subs_usage: {
        weekly: { used_percent: 25 },
        window: {
          used_percent: 30,
          window_duration_mins: 90,
          resets_at: "invalid",
        },
      },
    });

    expect(normalized.windows).toEqual([
      expect.objectContaining({ id: "weekly", percentRemaining: 75 }),
      expect.objectContaining({
        id: "window:90m",
        label: "90m",
        percentRemaining: 70,
      }),
    ]);
    for (const window of normalized.windows) {
      expect(window).not.toHaveProperty("resetsAt");
    }
  });

  it("surfaces unfamiliar usage windows without exposing vendor field names", () => {
    const normalized = normalizeMetaMusePayload({
      subs_usage: {
        daily_secret_product_name: {
          used_percent: 12,
          resets_at: 1_789_948_800,
        },
      },
    });

    expect(normalized).toMatchObject({
      windows: [
        {
          id: "limit:1",
          label: "limit 1",
          kind: "unknown",
          percentUsed: 12,
        },
      ],
      untrustedWindowIds: ["limit:1"],
    });
    expect(JSON.stringify(normalized)).not.toContain("secret_product_name");
  });

  it("reports a successful response with no usage snapshot as fresh and usable", async () => {
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: vi.fn(async () => new Response(JSON.stringify({ api_key: "x" }))),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      windows: [],
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
    expect(JSON.stringify(report)).not.toContain('"api_key"');
  });

  it("rejects malformed usage snapshots without retaining the raw payload", async () => {
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              subs_usage: "private malformed payload",
              api_key: "minted-model-key-must-disappear",
            }),
          ),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "schema_invalid",
    });
    expect(JSON.stringify(report)).not.toContain("private malformed payload");
    expect(JSON.stringify(report)).not.toContain("minted-model-key");
  });

  it("bounds the complete request deadline even when fetch ignores abort", async () => {
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: vi.fn(() => new Promise<Response>(() => undefined)),
      deadlineMs: 5,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_timeout",
    });
  });

  it("rejects oversized responses before reading their contents", async () => {
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: vi.fn(
        async () =>
          new Response("private oversized body", {
            headers: { "content-length": "262145" },
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "response_too_large",
    });
    expect(JSON.stringify(report)).not.toContain("private oversized body");
  });

  it.each([401, 403])(
    "treats first-party %s as definitive rejection",
    async (status) => {
      const deleteCachedProvider = vi.fn();
      const report = await testAdapter({
        credential: async () => credential(),
        fetch: vi.fn(async () => new Response("secret body", { status })),
        deleteCachedProvider,
      }).fetchQuota(OPTIONS);

      expect(report.state).toMatchObject({
        status: "auth_required",
        authStatus: "unusable",
        error: "provider_auth_rejected",
      });
      expect(deleteCachedProvider).toHaveBeenCalledWith("meta");
      expect(JSON.stringify(report)).not.toContain("secret body");
    },
  );

  it("uses stale normalized quota on a transient failure", async () => {
    const cached: ProviderQuota = {
      provider: "meta",
      label: "Meta Muse",
      source: "pi:meta",
      windows: normalizeMetaMusePayload(LIVE_FIXTURE).windows,
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-09-14T17:00:00.000Z",
        sourcesTried: ["pi:meta"],
      },
    };
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: vi.fn(async () => {
        throw new Error("offline includes sensitive network detail");
      }),
      readCachedProvider: () => cached,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "cache",
      windows: cached.windows,
      state: { status: "stale", stale: true, error: "network_unavailable" },
    });
    expect(JSON.stringify(report)).not.toContain("sensitive network detail");
  });

  it("drops reset-expired windows before applying duration age limits", async () => {
    const cached: ProviderQuota = {
      provider: "meta",
      label: "Meta Muse",
      source: "pi:meta",
      windows: [
        {
          id: "expired-reset",
          label: "expired reset",
          kind: "weekly",
          percentUsed: 80,
          percentRemaining: 20,
          windowSeconds: 604_800,
          resetsAt: new Date(NOW).toISOString(),
        },
        {
          id: "live-reset",
          label: "live reset",
          kind: "session",
          percentUsed: 40,
          percentRemaining: 60,
          windowSeconds: 18_000,
          resetsAt: new Date(NOW + 1).toISOString(),
        },
        {
          id: "expired-duration",
          label: "expired duration",
          kind: "session",
          percentUsed: 70,
          percentRemaining: 30,
          windowSeconds: 18_000,
        },
        {
          id: "live-duration",
          label: "live duration",
          kind: "weekly",
          percentUsed: 20,
          percentRemaining: 80,
          windowSeconds: 604_800,
        },
      ],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(NOW - 18_000_000).toISOString(),
        sourcesTried: ["pi:meta"],
      },
    };
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      readCachedProvider: () => cached,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.windows.map(({ id }) => id)).toEqual([
      "live-reset",
      "live-duration",
    ]);
  });

  it("returns the current request failure when every cached window expired", async () => {
    const cached: ProviderQuota = {
      provider: "meta",
      label: "Meta Muse",
      source: "pi:meta",
      windows: normalizeMetaMusePayload(LIVE_FIXTURE).windows.map((window) => ({
        ...window,
        resetsAt: new Date(NOW).toISOString(),
      })),
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(NOW - 1).toISOString(),
        sourcesTried: ["pi:meta"],
      },
    };
    const report = await testAdapter({
      credential: async () => credential(),
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      readCachedProvider: () => cached,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "pi:meta",
      windows: [],
      state: { status: "error", error: "network_unavailable" },
    });
  });

  it("keeps cache eligible when the Pi auth file cannot be read", async () => {
    const cached: ProviderQuota = {
      provider: "meta",
      label: "Meta Muse",
      source: "pi:meta",
      windows: normalizeMetaMusePayload(LIVE_FIXTURE).windows,
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-09-14T17:00:00.000Z",
      },
    };
    const report = await testAdapter({
      credential: async () => ({ status: "error", path: PATH }),
      readCachedProvider: () => cached,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "cache",
      state: {
        status: "stale",
        error: "credential_resolution_failed",
      },
      attempts: [{ source: "pi:meta", status: "failed" }],
    });
  });

  it("returns the credential-store failure when resetless cache aged out", async () => {
    const cached: ProviderQuota = {
      provider: "meta",
      label: "Meta Muse",
      source: "pi:meta",
      windows: normalizeMetaMusePayload(LIVE_FIXTURE).windows.map(
        ({ resetsAt: _resetsAt, ...window }) => window,
      ),
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(NOW - 604_800_000).toISOString(),
        sourcesTried: ["pi:meta"],
      },
    };
    const report = await testAdapter({
      credential: async () => ({ status: "error", path: PATH }),
      readCachedProvider: () => cached,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "pi:meta",
      windows: [],
      state: {
        status: "error",
        error: "credential_resolution_failed",
      },
    });
  });

  it.each([
    ["missing", false],
    ["invalid", true],
    ["unsupported", true],
  ] as const)(
    "reports a %s Pi source without making a request",
    async (status, present) => {
      const request = vi.fn();
      const report = await testAdapter({
        credential: async () => ({
          status,
          path: PATH,
          ...(present ? { credentialPresent: true as const } : {}),
        }),
        fetch: request,
      }).fetchQuota(OPTIONS);

      expect(request).not.toHaveBeenCalled();
      expect(report.state.status).toBe("auth_required");
      expect(report.attempts?.[0].credentialPresent).toBe(
        present ? true : undefined,
      );
    },
  );

  it("probes a credential even when the minted key's stored expiry is past", async () => {
    const request = vi.fn(
      async () => new Response(JSON.stringify({ subs_usage: {} })),
    );
    const report = await testAdapter({
      credential: async () => credential({ storedExpired: true }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledOnce();
    expect(report.state.status).toBe("fresh");
  });

  it("does not use a standalone Muse credential when Pi is absent", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      credential: async () => ({ status: "missing", path: PATH }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.error).toBe("meta_identity_unavailable");
    expect(report.state.sourcesTried).toEqual(["pi:meta"]);
  });
});
