import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import {
  createKiroAdapter,
  normalizeKiroUsage,
  readCredentialState,
  type KiroCredentialState,
} from "../../src/providers/kiro.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const ORIGINAL_CACHE_HOME = process.env.XDG_CACHE_HOME;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-kiro-"));
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  vi.stubEnv("KIRO_CLI_DB", join(tempDir, "kiro-cli", "data.sqlite3"));
  vi.stubEnv("KIRO_REGION", "us-east-1");
  vi.stubEnv("KIRO_PROFILE_ARN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
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
        "CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      database
        .prepare("DELETE FROM auth_kv WHERE key = ?")
        .run("kirocli:odic:token");
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

  it.each([undefined, "", "not-a-date", "2099-10-01T00:00:00.000Z"])(
    "includes active trial credits in the balance and all_models bound with expiry %s",
    async (expiry) => {
      const report = await adapterWith(CREDENTIALS, async () =>
        jsonResponse({
          ...USAGE_PAYLOAD,
          usageBreakdownList: [
            {
              resourceType: "CREDIT",
              currentUsage: 0,
              usageLimit: 50,
              freeTrialInfo: {
                freeTrialStatus: "ACTIVE",
                freeTrialExpiry: expiry,
                currentUsage: 999,
                currentUsageWithPrecision: 100,
                usageLimit: 999,
                usageLimitWithPrecision: 500,
              },
            },
          ],
        }),
      ).fetchQuota(OPTIONS);
      expect(report.credits).toEqual({ remaining: 450, unit: "credits" });
      expect(report.windows[0].percentRemaining).toBeCloseTo((450 / 550) * 100);
      const interpreted = withQuotaSemantics(report, new Date().toISOString());
      expect(interpreted.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
        scope: "all_models",
        limitingWindowIds: ["credit"],
      });
      expect(
        interpreted.quotaSemantics?.effectiveAvailability[0]
          .effectivePercentRemaining,
      ).toBeCloseTo((450 / 550) * 100);
    },
  );

  it.each([
    [1995, 5, 99.75, 0.25, "unknown"],
    [1999.5, 0.5, 99.975, 0.025, "unknown"],
    [2000, 0, 100, 0, "exhausted_now"],
  ] as const)(
    "preserves quota precision at %s of 2000 credits used",
    async (used, remaining, usedPercent, remainingPercent, runway) => {
      const report = await adapterWith(CREDENTIALS, async () =>
        jsonResponse({
          ...USAGE_PAYLOAD,
          usageBreakdownList: [
            {
              resourceType: "CREDIT",
              currentUsageWithPrecision: used,
              usageLimitWithPrecision: 2000,
            },
          ],
        }),
      ).fetchQuota(OPTIONS);
      expect(report.credits?.remaining).toBe(remaining);
      expect(report.windows[0].percentUsed).toBeCloseTo(usedPercent, 10);
      expect(report.windows[0].percentRemaining).toBe(remainingPercent);
      const interpreted = withQuotaSemantics(report, new Date().toISOString());
      const availability = interpreted.quotaSemantics?.effectiveAvailability[0];
      expect(availability?.effectivePercentRemaining).toBe(remainingPercent);
      expect(availability?.runway?.status).toBe(runway);
      writeCachedProviders([interpreted]);
      expect(readCachedProvider("kiro")?.windows[0].percentRemaining).toBe(
        remainingPercent,
      );
    },
  );

  it.each([
    ["EXPIRED", "2099-10-01T00:00:00.000Z"],
    ["ACTIVE", "2000-01-01T00:00:00.000Z"],
  ])("excludes an inapplicable trial (%s, %s)", (status, expiry) => {
    expect(
      normalizeKiroUsage({
        ...USAGE_PAYLOAD,
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            currentUsage: 0,
            usageLimit: 50,
            freeTrialInfo: {
              freeTrialStatus: status,
              freeTrialExpiry: expiry,
              currentUsage: 100,
              usageLimit: 500,
            },
          },
        ],
      })?.credits?.remaining,
    ).toBe(50);
  });

  it("retains a trial when the base allowance is zero", () => {
    expect(
      normalizeKiroUsage({
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            currentUsage: 0,
            usageLimit: 0,
            freeTrialInfo: {
              freeTrialStatus: "ACTIVE",
              currentUsage: 100,
              usageLimit: 500,
            },
          },
        ],
      }),
    ).toMatchObject({
      credits: { remaining: 400 },
      windows: [{ percentRemaining: 80 }],
    });
  });

  it("withholds an incomplete active trial instead of reporting only the base", () => {
    expect(
      normalizeKiroUsage({
        subscriptionInfo: USAGE_PAYLOAD.subscriptionInfo,
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            currentUsage: 0,
            usageLimit: 50,
            freeTrialInfo: { freeTrialStatus: "ACTIVE", usageLimit: 500 },
          },
        ],
      }),
    ).toMatchObject({ windows: [], credits: undefined });
  });

  it("accepts canonical camelCase fields without snake_case aliases", () => {
    expect(
      normalizeKiroUsage({
        usage_breakdown_list: [{ current_usage: 0, usage_limit: 50 }],
        subscription_info: { type: "ignored" },
        next_date_reset: 1_788_220_800,
      }),
    ).toBeUndefined();
    expect(
      normalizeKiroUsage({
        subscriptionInfo: USAGE_PAYLOAD.subscriptionInfo,
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            current_usage_with_precision: 10,
            usage_limit_with_precision: 50,
          },
        ],
      }),
    ).toMatchObject({ windows: [], credits: undefined });
    const quota = normalizeKiroUsage({
      usageBreakdownList: [
        {
          resourceType: "CREDIT",
          currentUsage: 10,
          usageLimit: 50,
          current_usage_with_precision: 49,
          usage_limit_with_precision: 100,
          display_name_plural: "Ignored",
          next_date_reset: 1_788_220_800,
        },
      ],
      next_date_reset: 1_788_220_800,
    });
    expect(quota).toMatchObject({
      credits: { remaining: 40 },
      windows: [{ id: "credit", label: "Credits", percentRemaining: 80 }],
    });
    expect(quota?.windows[0].resetsAt).toBeUndefined();
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
    vi.stubEnv("KIRO_REGION", "");
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

describe("Kiro cache retirement without a region override", () => {
  it("withholds account A quota after an unobserved logout and login to B", async () => {
    vi.stubEnv("KIRO_REGION", undefined);
    const path = process.env.KIRO_CLI_DB!;
    writeKiroStore(path, {
      token: JSON.stringify({
        access_token: "synthetic-account-a",
        region: "us-east-1",
      }),
    });
    const fresh = await createKiroAdapter({
      fetch: async () => jsonResponse(USAGE_PAYLOAD),
    }).fetchQuota(OPTIONS);
    writeCachedProviders([fresh]);
    writeKiroStore(path, {});
    writeKiroStore(path, {
      token: JSON.stringify({
        access_token: "synthetic-account-b",
        region: "us-east-1",
      }),
    });
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer synthetic-account-b",
        );
        throw new DOMException("aborted", "AbortError");
      },
    );
    const report = await createKiroAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "Kiro quota request timed out" },
    });
    expect(report.plan).toBeUndefined();
    expect(report.credits).toBeUndefined();
    expect(readCachedProvider("kiro")?.credits?.remaining).toBe(1500);
  });

  it.each([
    ["us-east-1", ""],
    ["eu-west-1", "synthetic-profile-identity"],
  ])(
    "retires a logged-out %s snapshot before another account uses the same store (%s)",
    async (region, profile) => {
      vi.stubEnv("KIRO_REGION", undefined);
      vi.stubEnv("KIRO_PROFILE_ARN", profile);
      const path = process.env.KIRO_CLI_DB!;
      const token = (accessToken: string) =>
        JSON.stringify({
          access_token: accessToken,
          region,
          refresh_token: "synthetic-refresh-secret",
        });
      writeKiroStore(path, { token: token("synthetic-account-a-token") });
      const fresh = await createKiroAdapter({
        fetch: async () => jsonResponse(USAGE_PAYLOAD),
      }).fetchQuota(OPTIONS);
      expect(fresh.state.status).toBe("fresh");
      writeCachedProviders([
        withQuotaSemantics(fresh, new Date().toISOString()),
      ]);
      const saved = JSON.parse(
        readFileSync(
          join(process.env.XDG_CACHE_HOME!, "quota-axi", "quotas.json"),
          "utf8",
        ),
      );
      expect(saved.providers[0].credentialContext).toMatch(/^[a-f0-9]{64}$/);
      expect(saved.providers[0].credentialRetirementContext).toMatch(
        /^[a-f0-9]{64}$/,
      );
      for (const secret of [
        path,
        "synthetic-profile-identity",
        "synthetic-account-a-token",
        "synthetic-refresh-secret",
      ]) {
        expect(JSON.stringify(saved)).not.toContain(secret);
      }
      const retirementId = saved.providers[0].credentialRetirementContext;
      writeCachedProviders([
        {
          provider: "copilot",
          label: "Copilot",
          source: "api",
          windows: [
            {
              id: "chat",
              label: "Chat",
              kind: "monthly",
              percentRemaining: 70,
            },
          ],
          state: { status: "fresh", stale: false, sourcesTried: [] },
        },
      ]);
      writeKiroStore(path, {});
      const request = vi.fn();
      const logout = await createKiroAdapter({ fetch: request }).fetchQuota(
        OPTIONS,
      );
      expect(request).not.toHaveBeenCalled();
      expect(logout).toMatchObject({
        source: "unavailable",
        windows: [],
        state: { status: "auth_required" },
      });
      expect(readCachedProvider("kiro")).toBeUndefined();
      expect(readCachedProvider("copilot")?.windows[0].percentRemaining).toBe(
        70,
      );
      writeKiroStore(path, { token: token("synthetic-account-b-token") });
      const next = await createKiroAdapter({
        fetch: async () => {
          throw new DOMException("aborted", "AbortError");
        },
      }).fetchQuota(OPTIONS);
      expect(next).toMatchObject({
        source: "unavailable",
        windows: [],
        state: { status: "error" },
      });
      expect(next.plan).toBeUndefined();
      expect(next.credits).toBeUndefined();
      const nextFresh = await createKiroAdapter({
        fetch: async () => jsonResponse(USAGE_PAYLOAD),
      }).fetchQuota(OPTIONS);
      writeCachedProviders([nextFresh]);
      const nextSaved = JSON.parse(
        readFileSync(
          join(process.env.XDG_CACHE_HOME!, "quota-axi", "quotas.json"),
          "utf8",
        ),
      );
      expect(
        nextSaved.providers.find(
          (entry: { provider: string }) => entry.provider === "kiro",
        ).credentialRetirementContext,
      ).toBe(retirementId);
    },
  );
});

describe("Kiro quota transport", () => {
  const responseLimit = 262_144;

  it("rejects an oversized declared body before reading it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
      { headers: { "content-length": String(responseLimit + 1) } },
    );
    const report = await adapterWith(
      CREDENTIALS,
      async () => response,
    ).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "Kiro quota response too large" },
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each([undefined, "1"])(
    "stops an oversized stream with content-length %s at the byte limit",
    async (contentLength) => {
      const chunk = new TextEncoder().encode("é".repeat(responseLimit / 4));
      const pull = vi.fn(
        (controller: ReadableStreamDefaultController<Uint8Array>) => {
          controller.enqueue(chunk);
          if (pull.mock.calls.length === 4) controller.close();
        },
      );
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
        { headers: contentLength ? { "content-length": contentLength } : {} },
      );
      const report = await adapterWith(
        CREDENTIALS,
        async () => response,
      ).fetchQuota(OPTIONS);
      expect(report).toMatchObject({
        source: "unavailable",
        windows: [],
        state: { status: "error", error: "Kiro quota response too large" },
      });
      expect(pull).toHaveBeenCalledTimes(3);
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    },
  );

  it("accepts valid JSON at the response byte limit", async () => {
    const body = JSON.stringify(USAGE_PAYLOAD).padEnd(responseLimit, " ");
    const report = await adapterWith(
      CREDENTIALS,
      async () =>
        new Response(body, {
          headers: { "content-length": String(responseLimit) },
        }),
    ).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "api",
      state: { status: "fresh" },
      credits: { remaining: 1500 },
    });
  });

  it("reports malformed JSON without exposing response content", async () => {
    const report = await adapterWith(
      CREDENTIALS,
      async () => new Response("not-json-sensitive-response"),
    ).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "Kiro quota response malformed JSON" },
    });
    expect(JSON.stringify(report)).not.toContain("not-json-sensitive-response");
  });

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
    beforeEach(async () => {
      const fresh = await adapterWith(CREDENTIALS, async () =>
        jsonResponse(USAGE_PAYLOAD),
      ).fetchQuota(OPTIONS);
      writeCachedProviders([fresh]);
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it.each(["logout", "rejection"])(
      "withholds stale quota if %s cache retirement cannot write",
      async (failure) => {
        vi.mocked(writeFileSync).mockImplementationOnce(() => {
          throw Object.assign(new Error("read-only filesystem"), {
            code: "EROFS",
          });
        });
        const report = await adapterWith(
          failure === "logout"
            ? { status: "missing", source: { ...SOURCE, status: "missing" } }
            : CREDENTIALS,
          async () => new Response(null, { status: 401 }),
        ).fetchQuota(OPTIONS);
        expect(report).toMatchObject({
          source: "unavailable",
          windows: [],
          state: { status: "auth_required" },
        });
        expect(readCachedProvider("kiro")).toBeDefined();
        expect(vi.mocked(writeFileSync).mock.results.at(-1)?.type).toBe(
          "throw",
        );
      },
    );

    it("preserves retry-after while withholding cached quota on rate limiting", async () => {
      const report = await adapterWith(
        CREDENTIALS,
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" },
          }),
      ).fetchQuota(OPTIONS);
      expect(report.state).toMatchObject({
        status: "rate_limited",
        retryAfter: "2099-01-01T00:00:00.000Z",
      });
      expect(report.windows).toEqual([]);
      expect(report.plan).toBeUndefined();
      expect(report.credits).toBeUndefined();
    });

    it.each(["KIRO_CLI_DB", "KIRO_REGION", "KIRO_PROFILE_ARN"])(
      "isolates reports and retirement when %s selects another context",
      async (key) => {
        const original = process.env[key]!;
        vi.stubEnv(
          key,
          key === "KIRO_REGION" ? "eu-west-1" : "synthetic-other-context",
        );
        const state =
          key === "KIRO_REGION"
            ? {
                ...CREDENTIALS,
                credentials: {
                  ...CREDENTIALS.credentials,
                  region: "eu-west-1",
                },
              }
            : CREDENTIALS;
        const transient = await adapterWith(state, async () => {
          throw new Error("timeout");
        }).fetchQuota(OPTIONS);
        expect(transient).toMatchObject({ source: "unavailable", windows: [] });
        expect(transient.plan).toBeUndefined();
        const rejected = await adapterWith(
          state,
          async () => new Response(null, { status: 401 }),
        ).fetchQuota(OPTIONS);
        expect(rejected.state.status).toBe("auth_required");
        expect(readCachedProvider("kiro")).toBeDefined();
        const empty = await adapterWith(state, async () =>
          jsonResponse({ subscriptionInfo: { type: "new account" } }),
        ).fetchQuota(OPTIONS);
        writeCachedProviders([empty]);
        expect(readCachedProvider("kiro")).toBeDefined();
        vi.stubEnv(key, original);
        const restored = await adapterWith(
          CREDENTIALS,
          async () => new Response(null, { status: 401 }),
        ).fetchQuota(OPTIONS);
        expect(restored.state.status).toBe("auth_required");
        expect(readCachedProvider("kiro")).toBeUndefined();
      },
    );

    it.each(["KIRO_CLI_DB", "KIRO_PROFILE_ARN"])(
      "does not retire another %s context during regionless logout",
      async (key) => {
        vi.stubEnv("KIRO_REGION", undefined);
        const original = process.env[key]!;
        vi.stubEnv(key, "synthetic-other-context");
        const missing: KiroCredentialState = {
          status: "missing",
          source: { ...SOURCE, status: "missing" },
        };
        const logout = await adapterWith(missing, vi.fn()).fetchQuota(OPTIONS);
        expect(logout.state.status).toBe("auth_required");
        expect(readCachedProvider("kiro")).toBeDefined();
        vi.stubEnv(key, original);
        const restored = await adapterWith(
          CREDENTIALS,
          async () => new Response(null, { status: 401 }),
        ).fetchQuota(OPTIONS);
        expect(restored.state.status).toBe("auth_required");
        expect(readCachedProvider("kiro")).toBeUndefined();
      },
    );

    it("retires an invalid store without the deleted token's region", async () => {
      vi.stubEnv("KIRO_REGION", undefined);
      const invalid: KiroCredentialState = {
        status: "invalid",
        source: { ...SOURCE, status: "invalid", error: "json_parse_error" },
      };
      const report = await adapterWith(invalid, vi.fn()).fetchQuota(OPTIONS);
      expect(report).toMatchObject({
        windows: [],
        state: { status: "auth_required" },
      });
      expect(readCachedProvider("kiro")).toBeUndefined();
    });

    it("withholds a regionless logout even when cache retirement cannot write", async () => {
      vi.stubEnv("KIRO_REGION", undefined);
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("read-only filesystem"), {
          code: "EROFS",
        });
      });
      const report = await adapterWith(
        { status: "missing", source: { ...SOURCE, status: "missing" } },
        vi.fn(),
      ).fetchQuota(OPTIONS);
      expect(report).toMatchObject({
        windows: [],
        state: { status: "auth_required" },
      });
      expect(vi.mocked(writeFileSync).mock.results.at(-1)?.type).toBe("throw");
    });

    it("withholds older snapshots without a retirement identity after logout", async () => {
      const path = join(
        process.env.XDG_CACHE_HOME!,
        "quota-axi",
        "quotas.json",
      );
      const saved = JSON.parse(readFileSync(path, "utf8"));
      delete saved.providers[0].credentialRetirementContext;
      writeFileSync(path, JSON.stringify(saved));
      vi.stubEnv("KIRO_REGION", undefined);
      await adapterWith(
        { status: "missing", source: { ...SOURCE, status: "missing" } },
        vi.fn(),
      ).fetchQuota(OPTIONS);
      const next = await adapterWith(CREDENTIALS, async () => {
        throw new Error("timeout");
      }).fetchQuota(OPTIONS);
      expect(next).toMatchObject({ source: "unavailable", windows: [] });
    });

    it("withholds cache when an unreadable store leaves the region unconfirmed", async () => {
      vi.stubEnv("KIRO_REGION", "");
      const report = await adapterWith(
        {
          status: "error",
          source: { ...SOURCE, status: "error", error: "database_busy" },
        },
        vi.fn(),
      ).fetchQuota(OPTIONS);
      expect(report).toMatchObject({
        source: "unavailable",
        windows: [],
        state: { status: "error" },
      });
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("isolates a changed stored region without an environment override", async () => {
      vi.stubEnv("KIRO_REGION", "");
      const state = {
        ...CREDENTIALS,
        credentials: { ...CREDENTIALS.credentials, region: "eu-west-1" },
      };
      const report = await adapterWith(state, async () => {
        throw new Error("timeout");
      }).fetchQuota(OPTIONS);
      expect(report).toMatchObject({ source: "unavailable", windows: [] });
      await adapterWith(
        state,
        async () => new Response(null, { status: 401 }),
      ).fetchQuota(OPTIONS);
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("does not reuse or retire an unscoped legacy snapshot", async () => {
      const path = join(
        process.env.XDG_CACHE_HOME!,
        "quota-axi",
        "quotas.json",
      );
      const saved = JSON.parse(readFileSync(path, "utf8"));
      delete saved.providers[0].credentialContext;
      writeFileSync(path, JSON.stringify(saved));
      const report = await adapterWith(CREDENTIALS, async () => {
        throw new Error("timeout");
      }).fetchQuota(OPTIONS);
      expect(report).toMatchObject({ source: "unavailable", windows: [] });
      await adapterWith(
        CREDENTIALS,
        async () => new Response(null, { status: 401 }),
      ).fetchQuota(OPTIONS);
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("keeps each reading bound to its context across interleaved successful reads", async () => {
      const original = await adapterWith(CREDENTIALS, async () =>
        jsonResponse(USAGE_PAYLOAD),
      ).fetchQuota(OPTIONS);
      vi.stubEnv("KIRO_PROFILE_ARN", "synthetic-other-profile");
      await adapterWith(CREDENTIALS, async () =>
        jsonResponse(USAGE_PAYLOAD),
      ).fetchQuota(OPTIONS);
      writeCachedProviders([
        withQuotaSemantics(original, new Date().toISOString()),
      ]);
      const other = await adapterWith(CREDENTIALS, async () => {
        throw new Error("timeout");
      }).fetchQuota(OPTIONS);
      expect(other).toMatchObject({ source: "unavailable", windows: [] });
      vi.stubEnv("KIRO_PROFILE_ARN", "");
      const restored = await adapterWith(
        CREDENTIALS,
        async () => new Response(null, { status: 401 }),
      ).fetchQuota(OPTIONS);
      expect(restored.state.status).toBe("auth_required");
      expect(readCachedProvider("kiro")).toBeUndefined();
    });

    it("clears a matching context after a fresh response with no windows", async () => {
      const empty = await adapterWith(CREDENTIALS, async () =>
        jsonResponse({ subscriptionInfo: { type: "KIRO FREE" } }),
      ).fetchQuota(OPTIONS);
      writeCachedProviders([empty]);
      expect(readCachedProvider("kiro")).toBeUndefined();
    });

    it("stamps the context used for the request even if configuration changes before caching", async () => {
      const fresh = await adapterWith(CREDENTIALS, async () => {
        vi.stubEnv("KIRO_PROFILE_ARN", "synthetic-new-profile");
        return jsonResponse(USAGE_PAYLOAD);
      }).fetchQuota(OPTIONS);
      writeCachedProviders([
        withQuotaSemantics(fresh, new Date().toISOString()),
      ]);
      const path = join(
        process.env.XDG_CACHE_HOME!,
        "quota-axi",
        "quotas.json",
      );
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved.providers[0].credentialContext).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(saved)).not.toContain("synthetic-new-profile");
      expect(JSON.stringify(saved)).not.toContain(ACCESS_TOKEN);
      const other = await adapterWith(CREDENTIALS, async () => {
        throw new Error("timeout");
      }).fetchQuota(OPTIONS);
      expect(other.windows).toEqual([]);
      vi.stubEnv("KIRO_PROFILE_ARN", "");
      const original = await adapterWith(
        CREDENTIALS,
        async () => new Response(null, { status: 401 }),
      ).fetchQuota(OPTIONS);
      expect(original.state.status).toBe("auth_required");
      expect(readCachedProvider("kiro")).toBeUndefined();
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

    it("withholds cached quota on timeout when account continuity is unconfirmed", async () => {
      const request = vi.fn(async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      });
      const report = await adapterWith(CREDENTIALS, request).fetchQuota(
        OPTIONS,
      );
      expect(report).toMatchObject({
        source: "unavailable",
        windows: [],
        state: {
          status: "error",
          stale: false,
          error: "Kiro quota request timed out",
        },
      });
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("withholds cached quota on soft expiry and keeps the cache", async () => {
      const request = vi.fn(async () => new Response(null, { status: 401 }));
      const report = await adapterWith(
        STORED_EXPIRED_REFRESHABLE,
        request,
      ).fetchQuota(OPTIONS);
      expect(report).toMatchObject({
        source: "unavailable",
        windows: [],
        state: { status: "unavailable", authStatus: "expired_refreshable" },
      });
      expect(readCachedProvider("kiro")).toBeDefined();
    });

    it("withholds cached quota for a locked store and keeps the cache", async () => {
      const busy: KiroCredentialState = {
        status: "error",
        source: { ...SOURCE, status: "error", error: "database_busy" },
      };
      const report = await adapterWith(busy, vi.fn()).fetchQuota(OPTIONS);
      expect(report.state).toMatchObject({
        status: "error",
        error: "Kiro credential store unavailable",
      });
      expect(readCachedProvider("kiro")).toBeDefined();
    });
  });
});
