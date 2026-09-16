import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import {
  createKiroAdapter,
  normalizeKiroUsage,
  readCredentialState,
  type KiroCredentialState,
} from "../../src/providers/kiro.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const ORIGINAL_CACHE_HOME = process.env.XDG_CACHE_HOME;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-kiro-"));
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
});

afterEach(() => {
  if (ORIGINAL_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = ORIGINAL_CACHE_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

const ACCESS_TOKEN = "synthetic-kiro-token";
const SOURCE = {
  source: "kiro-sqlite",
  path: "~/.local/share/kiro-cli/data.sqlite3",
  status: "available" as const,
  credentialPresent: true,
};
const CREDENTIALS: KiroCredentialState = {
  status: "available",
  credentials: {
    accessToken: ACCESS_TOKEN,
    region: "us-east-1",
    storedExpired: false,
    refreshable: true,
  },
  source: SOURCE,
};
const STORED_EXPIRED_REFRESHABLE: KiroCredentialState = {
  status: "expired",
  credentials: { ...CREDENTIALS.credentials, storedExpired: true },
  source: { ...SOURCE, status: "expired", error: "access_token_expired" },
};
const STORED_EXPIRED_UNREFRESHABLE: KiroCredentialState = {
  status: "expired",
  credentials: {
    ...CREDENTIALS.credentials,
    storedExpired: true,
    refreshable: false,
  },
  source: { ...SOURCE, status: "expired", error: "access_token_expired" },
};
const USAGE_PAYLOAD = {
  nextDateReset: 1_788_220_800,
  subscriptionInfo: {
    subscriptionTitle: "KIRO PRO+",
    type: "Q_DEVELOPER_STANDALONE_PRO_PLUS",
  },
  usageBreakdownList: [
    {
      currentUsageWithPrecision: 500,
      usageLimitWithPrecision: 2000,
      displayName: "Credit",
      displayNamePlural: "Credits",
      resourceType: "CREDIT",
    },
  ],
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function adapterWith(
  state: KiroCredentialState,
  request: typeof fetch,
): ReturnType<typeof createKiroAdapter> {
  return createKiroAdapter({
    fetch: request,
    readCredentialState: () => state,
  });
}

/** Builds a Kiro CLI store the way `kiro-cli` lays it out: `auth_kv(key, value)`. */
function writeKiroStore(
  path: string,
  options: { table?: boolean; token?: string },
): void {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    if (options.table !== false) {
      database.exec(
        "CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    }
    if (options.token !== undefined) {
      database
        .prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)")
        .run("kirocli:odic:token", options.token);
    }
  } finally {
    database.close();
  }
}

describe("Kiro quota normalization", () => {
  it("normalizes credit usage, plan, balance, and reset", () => {
    expect(normalizeKiroUsage(USAGE_PAYLOAD)).toMatchObject({
      plan: "KIRO PRO+",
      credits: { remaining: 1500, unit: "credits" },
      windows: [
        {
          id: "credit",
          label: "Credits",
          kind: "credits",
          percentUsed: 25,
          percentRemaining: 75,
          resetsAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("rejects empty responses instead of inventing quota", () => {
    expect(normalizeKiroUsage({})).toBeUndefined();
    expect(normalizeKiroUsage(null)).toBeUndefined();
    expect(normalizeKiroUsage({ limits: [{ percentUsed: 30 }] })).toBe(
      undefined,
    );
  });
});

describe("Kiro credential store reader", () => {
  const storePath = () => join(tempDir, "kiro-cli", "data.sqlite3");
  const liveToken = () =>
    JSON.stringify({
      access_token: ACCESS_TOKEN,
      refresh_token: "must-not-be-read",
      region: "eu-west-1",
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    });

  it("reports an absent store as missing without opening it", () => {
    expect(readCredentialState(storePath())).toEqual({
      status: "missing",
      source: {
        source: "kiro-sqlite",
        path: storePath(),
        status: "missing",
      },
    });
  });

  it("reports a file that is not a database as invalid", () => {
    mkdirSync(join(tempDir, "kiro-cli"), { recursive: true });
    writeFileSync(storePath(), "not a sqlite database");
    expect(readCredentialState(storePath())).toMatchObject({
      status: "invalid",
      source: {
        status: "invalid",
        error: "database_read_error",
        credentialPresent: true,
      },
    });
  });

  it("reports a store without the auth table as invalid", () => {
    writeKiroStore(storePath(), { table: false });
    expect(readCredentialState(storePath())).toMatchObject({
      status: "invalid",
      source: { status: "invalid", error: "database_read_error" },
    });
  });

  it("reports a store without the token row as missing", () => {
    writeKiroStore(storePath(), {});
    expect(readCredentialState(storePath())).toMatchObject({
      status: "missing",
      source: { status: "missing" },
    });
    expect(readCredentialState(storePath()).source.credentialPresent).toBe(
      undefined,
    );
  });

  it("reports a malformed token record as invalid", () => {
    writeKiroStore(storePath(), { token: "{not json" });
    expect(readCredentialState(storePath())).toMatchObject({
      status: "invalid",
      source: {
        status: "invalid",
        error: "json_parse_error",
        credentialPresent: true,
      },
    });
  });

  it("reports a token record without an access token as invalid", () => {
    writeKiroStore(storePath(), {
      token: JSON.stringify({ refresh_token: "x", region: "us-east-1" }),
    });
    expect(readCredentialState(storePath())).toMatchObject({
      status: "invalid",
      source: { status: "invalid", error: "credential_shape_invalid" },
    });
  });

  it("keeps a stored-expired token for the probe and records refresh presence only", () => {
    writeKiroStore(storePath(), {
      token: JSON.stringify({
        access_token: ACCESS_TOKEN,
        refresh_token: "must-not-be-read",
        expires_at: Math.floor(Date.now() / 1000) - 60,
      }),
    });
    const state = readCredentialState(storePath());
    expect(state).toMatchObject({
      status: "expired",
      credentials: {
        accessToken: ACCESS_TOKEN,
        region: "us-east-1",
        storedExpired: true,
        refreshable: true,
      },
      source: { status: "expired", error: "access_token_expired" },
    });
    expect(JSON.stringify(state)).not.toContain("must-not-be-read");
    expect(JSON.stringify(state.source)).not.toContain(ACCESS_TOKEN);
  });

  it("reads a live token with its stored region", () => {
    writeKiroStore(storePath(), { token: liveToken() });
    expect(readCredentialState(storePath())).toMatchObject({
      status: "available",
      credentials: {
        accessToken: ACCESS_TOKEN,
        region: "eu-west-1",
        storedExpired: false,
        refreshable: true,
      },
      source: { status: "available", credentialPresent: true },
    });
  });
});

describe("Kiro quota transport", () => {
  it("calls the first-party usage endpoint with a read-only bearer request", async () => {
    const request = vi.fn(async () => jsonResponse(USAGE_PAYLOAD));
    const report = await adapterWith(CREDENTIALS, request).fetchQuota(OPTIONS);
    expect(request).toHaveBeenCalledOnce();
    const [input, init] = request.mock.calls[0];
    expect(String(input)).toBe(
      "https://codewhisperer.us-east-1.amazonaws.com/",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      body: "{}",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("x-amz-target")).toBe(
      "AmazonCodeWhispererService.GetUsageLimits",
    );
    expect(headers.get("content-type")).toBe("application/x-amz-json-1.0");
    expect(headers.get("cookie")).toBeNull();
    expect(report).toMatchObject({
      provider: "kiro",
      label: "Kiro",
      source: "api",
      state: { status: "fresh", sourcesTried: ["kiro-sqlite"] },
      attempts: [
        { source: "kiro-sqlite", status: "success", credentialPresent: true },
      ],
      plan: "KIRO PRO+",
    });
    expect(JSON.stringify(report)).not.toContain(ACCESS_TOKEN);
  });

  it("reports missing credentials without making a request", async () => {
    const request = vi.fn();
    const missing: KiroCredentialState = {
      status: "missing",
      source: {
        source: "kiro-sqlite",
        path: "~/.local/share/kiro-cli/data.sqlite3",
        status: "missing",
      },
    };
    const report = await adapterWith(missing, request).fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.attempts).toEqual([
      {
        source: "kiro-sqlite",
        status: "skipped",
        error: "credentials_missing",
      },
    ]);
  });

  it("reports a broken store as a present credential that is invalid", async () => {
    const request = vi.fn();
    const invalid: KiroCredentialState = {
      status: "invalid",
      source: {
        ...SOURCE,
        status: "invalid",
        error: "json_parse_error",
      },
    };
    const report = await adapterWith(invalid, request).fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.attempts).toEqual([
      {
        source: "kiro-sqlite",
        status: "skipped",
        error: "credentials_invalid",
        credentialPresent: true,
      },
    ]);
  });

  it("reports a locked store as a transient error, not a sign-out", async () => {
    const request = vi.fn();
    const busy: KiroCredentialState = {
      status: "error",
      source: { ...SOURCE, status: "error", error: "database_busy" },
    };
    const report = await adapterWith(busy, request).fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "error",
      error: "Kiro credential store unavailable",
    });
    expect(report.state.authStatus).toBeUndefined();
  });

  it("probes a stored-expired token and reports fresh quota when it is live", async () => {
    const request = vi.fn(async () => jsonResponse(USAGE_PAYLOAD));
    const report = await adapterWith(
      STORED_EXPIRED_REFRESHABLE,
      request,
    ).fetchQuota(OPTIONS);
    expect(request).toHaveBeenCalledOnce();
    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(report.state.status).toBe("fresh");
  });

  it.each([401, 403])(
    "treats a %d rejection of a stored-valid token as sign-in required",
    async (status) => {
      const request = vi.fn(async () => new Response(null, { status }));
      const report = await adapterWith(CREDENTIALS, request).fetchQuota(
        OPTIONS,
      );
      expect(report.state).toMatchObject({
        status: "auth_required",
        error: "Kiro sign-in required",
        authStatus: "unusable",
      });
      expect(report.attempts).toEqual([
        {
          source: "kiro-sqlite",
          status: "failed",
          error: "Kiro sign-in required",
          credentialPresent: true,
        },
      ]);
    },
  );

  it.each([401, 403])(
    "treats a %d rejection of a stored-expired refreshable token as soft expiry",
    async (status) => {
      const request = vi.fn(async () => new Response(null, { status }));
      const report = await adapterWith(
        STORED_EXPIRED_REFRESHABLE,
        request,
      ).fetchQuota(OPTIONS);
      expect(request).toHaveBeenCalledOnce();
      expect(report.state).toMatchObject({
        status: "unavailable",
        error: "Kiro access token expired",
        authStatus: "expired_refreshable",
      });
    },
  );

  it("treats a rejected stored-expired token without a refresh path as sign-in required", async () => {
    const request = vi.fn(async () => new Response(null, { status: 401 }));
    const report = await adapterWith(
      STORED_EXPIRED_UNREFRESHABLE,
      request,
    ).fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "Kiro sign-in required",
      authStatus: "unusable",
    });
  });

  it("classifies throttling and preserves retry-after", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    );
    const report = await adapterWith(CREDENTIALS, request).fetchQuota(OPTIONS);
    expect(report.state.status).toBe("rate_limited");
    expect(report.state.retryAfter).toBeDefined();
    expect(report.state.error).toBe("Kiro quota endpoint rate limited");
  });

  it("reports an aborted request as a timeout error, not an auth verdict", async () => {
    const request = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const report = await adapterWith(CREDENTIALS, request).fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "error",
      error: "Kiro quota request timed out",
    });
    expect(report.state.authStatus).toBeUndefined();
  });

  it("reports a server failure as an error that keeps auth undecided", async () => {
    const request = vi.fn(async () => new Response(null, { status: 500 }));
    const report = await adapterWith(CREDENTIALS, request).fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "error",
      error: "Kiro quota unavailable (500)",
    });
  });

  describe("with a cached fresh reading", () => {
    const cachedKiro = () => ({
      provider: "kiro" as const,
      label: "Kiro",
      source: "api" as const,
      plan: "KIRO PRO+",
      windows: [
        {
          id: "credit",
          label: "Credits",
          kind: "credits" as const,
          percentUsed: 25,
          percentRemaining: 75,
          resetsAt: "2099-09-01T00:00:00.000Z",
        },
      ],
      state: {
        status: "fresh" as const,
        stale: false,
        refreshedAt: "2026-08-01T00:00:00.000Z",
        sourcesTried: ["kiro-sqlite"],
      },
    });

    beforeEach(() => {
      writeCachedProviders([cachedKiro()]);
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("retires the cache after logout instead of serving stale credit", async () => {
      const missing: KiroCredentialState = {
        status: "missing",
        source: { ...SOURCE, status: "missing" },
      };
      const report = await adapterWith(missing, vi.fn()).fetchQuota(OPTIONS);
      expect(report).toMatchObject({
        source: "unavailable",
        windows: [],
        state: { status: "auth_required", error: "Kiro sign-in required" },
      });
      expect(readCachedProvider("kiro")).toBeUndefined();
    });

    it("retires the cache for a broken store", async () => {
      const invalid: KiroCredentialState = {
        status: "invalid",
        source: { ...SOURCE, status: "invalid", error: "json_parse_error" },
      };
      const report = await adapterWith(invalid, vi.fn()).fetchQuota(OPTIONS);
      expect(report.state.status).toBe("auth_required");
      expect(report.windows).toEqual([]);
      expect(readCachedProvider("kiro")).toBeUndefined();
    });

    it.each([401, 403])(
      "retires the cache when a stored-valid token is rejected with %d",
      async (status) => {
        const request = vi.fn(async () => new Response(null, { status }));
        const report = await adapterWith(CREDENTIALS, request).fetchQuota(
          OPTIONS,
        );
        expect(report).toMatchObject({
          source: "unavailable",
          windows: [],
          state: { status: "auth_required", authStatus: "unusable" },
        });
        expect(readCachedProvider("kiro")).toBeUndefined();
      },
    );

    it("serves the last fresh snapshot for a timed-out request and keeps the cache", async () => {
      const request = vi.fn(async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      });
      const report = await adapterWith(CREDENTIALS, request).fetchQuota(
        OPTIONS,
      );
      expect(report).toMatchObject({
        source: "cache",
        windows: [{ id: "credit", percentRemaining: 75 }],
        state: {
          status: "stale",
          stale: true,
          error: "Kiro quota request timed out",
        },
      });
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("serves the last fresh snapshot for soft expiry and keeps the cache", async () => {
      const request = vi.fn(async () => new Response(null, { status: 401 }));
      const report = await adapterWith(
        STORED_EXPIRED_REFRESHABLE,
        request,
      ).fetchQuota(OPTIONS);
      expect(report).toMatchObject({
        source: "cache",
        windows: [{ id: "credit" }],
        state: { status: "stale", authStatus: "expired_refreshable" },
      });
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("serves the last fresh snapshot for a locked store and keeps the cache", async () => {
      const busy: KiroCredentialState = {
        status: "error",
        source: { ...SOURCE, status: "error", error: "database_busy" },
      };
      const report = await adapterWith(busy, vi.fn()).fetchQuota(OPTIONS);
      expect(report.state).toMatchObject({
        status: "stale",
        error: "Kiro credential store unavailable",
      });
      expect(readCachedProvider("kiro")).toBeDefined();
    });
  });
});
