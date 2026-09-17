import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createFireworksAdapter,
  fireworksAuthIniPath,
  normalizeFireworksQuotas,
  parseFireworksAuthIni,
  resolveFireworksAuthIni,
  resolveFireworksCredential,
  type FireworksResolution,
} from "../../src/providers/fireworks.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const ENV_KEY = "synthetic-fireworks-env-key";
const INI_KEY = "synthetic-fireworks-ini-key";
const ACCOUNT = "synthetic-account";
const QUOTAS_URL = `https://api.fireworks.ai/v1/accounts/${ACCOUNT}/quotas?pageSize=200`;
const ACCOUNTS_URL = "https://api.fireworks.ai/v1/accounts?pageSize=2";

const ENV_NAMES = [
  "FIREWORKS_API_KEY",
  "FIREWORKS_ACCOUNT_ID",
  "FIREWORKS_AUTH_INI",
] as const;
const originalEnv = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-fireworks-"));
  for (const name of ENV_NAMES) delete process.env[name];
  // The machine's own `~/.fireworks/auth.ini` must never decide a test.
  process.env.FIREWORKS_AUTH_INI = join(tempDir, "absent", "auth.ini");
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeAuthIni(text: string): string {
  const path = join(tempDir, "auth.ini");
  writeFileSync(path, text, { mode: 0o600 });
  process.env.FIREWORKS_AUTH_INI = path;
  return path;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** One quota entry as the vendor serves it: `int64` arrives as a string. */
function quotaList() {
  return {
    quotas: [
      {
        name: `accounts/${ACCOUNT}/quotas/h100-us-iowa-1`,
        value: "16",
        maxValue: "16",
        usage: 4,
        updateTime: "2026-09-01T00:00:00Z",
      },
      {
        name: `accounts/${ACCOUNT}/quotas/requests-per-minute`,
        value: 6000,
        maxValue: 6000,
        usage: 1500.5,
      },
    ],
    totalSize: 2,
  };
}

type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function adapterWith(
  fetchImplementation: ProviderFetch,
  resolve?: (
    source: "env" | "fireworks:auth.ini",
  ) => Promise<FireworksResolution>,
) {
  return createFireworksAdapter({
    fetch: fetchImplementation,
    now: () => "2026-09-17T12:00:00.000Z",
    ...(resolve ? { resolve } : {}),
  });
}

describe("Fireworks credential discovery", () => {
  it("prefers the environment key and pairs it with the environment account", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;

    expect(await resolveFireworksCredential("env")).toMatchObject({
      status: "resolved",
      credential: { apiKey: ENV_KEY, accountId: ACCOUNT },
      report: { source: "env", status: "available" },
    });
  });

  it("treats a blank environment key as absence, not as a broken credential", async () => {
    process.env.FIREWORKS_API_KEY = "   ";

    const resolution = await resolveFireworksCredential("env");

    expect(resolution.status).toBe("absent");
    expect(resolution.report.credentialPresent).toBeUndefined();
  });

  it("refuses an environment key that is a reference rather than a literal secret", async () => {
    process.env.FIREWORKS_API_KEY = "$SOME_OTHER_VARIABLE";

    expect(await resolveFireworksCredential("env")).toMatchObject({
      status: "structurally_invalid",
      report: { status: "invalid", credentialPresent: true },
    });
  });

  it("refuses an account id that is not a bare path segment", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = "../../v1/accounts/other";

    expect(await resolveFireworksCredential("env")).toMatchObject({
      status: "structurally_invalid",
      report: { error: "account_id_invalid" },
    });
  });

  it("reads only the whitelisted keys out of auth.ini", () => {
    const parsed = parseFireworksAuthIni(
      [
        "# firectl login",
        "[DEFAULT]",
        `api_key = ${INI_KEY}`,
        `account_id = "${ACCOUNT}"`,
        "id_token = must-not-be-read",
        "refresh_token = must-not-be-read",
        "client_id = must-not-be-read",
        "; trailing comment",
      ].join("\n"),
    );

    expect(parsed).toEqual({ api_key: INI_KEY, account_id: ACCOUNT });
    expect(Object.keys(parsed)).toEqual(["api_key", "account_id"]);
  });

  it("resolves an auth.ini login and reports its path", async () => {
    const path = writeAuthIni(
      `api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\nrefresh_token = must-not-be-read\n`,
    );

    expect(await resolveFireworksAuthIni()).toMatchObject({
      status: "resolved",
      credential: { apiKey: INI_KEY, accountId: ACCOUNT },
      report: { source: "fireworks:auth.ini", path, status: "available" },
    });
  });

  it("reports an auth.ini with no api_key as absent and a broken one as present", async () => {
    writeAuthIni(`account_id = ${ACCOUNT}\n`);
    expect((await resolveFireworksAuthIni()).status).toBe("absent");

    writeAuthIni("api_key = \naccount_id = x\n");
    expect((await resolveFireworksAuthIni()).status).toBe("absent");

    writeAuthIni("api_key = $FROM_SOMEWHERE_ELSE\n");
    expect(await resolveFireworksAuthIni()).toMatchObject({
      status: "structurally_invalid",
      report: { credentialPresent: true },
    });
  });

  it("reports an absent auth.ini as missing", async () => {
    expect(await resolveFireworksAuthIni()).toMatchObject({
      status: "absent",
      report: { status: "missing" },
    });
  });

  it.each(["oversized multibyte", "invalid UTF-8"])(
    "rejects an %s auth.ini before any quota request",
    async (kind) => {
      const prefix = `api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n#`;
      const contents =
        kind === "oversized multibyte"
          ? Buffer.from(prefix + "é".repeat(32_768))
          : Buffer.concat([Buffer.from(prefix), Buffer.from([0xc3])]);
      if (kind === "oversized multibyte") {
        expect(contents.byteLength).toBeGreaterThan(65_536);
        expect(contents.toString("utf8").length).toBeLessThan(65_536);
      }
      const path = writeAuthIni("");
      writeFileSync(path, contents);
      const request = vi.fn(async () => jsonResponse(quotaList()));

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(request).not.toHaveBeenCalled();
      expect(report.state).toMatchObject({
        status: "error",
        error: "credential_resolution_failed",
      });
      expect(await resolveFireworksAuthIni(path)).toMatchObject({
        status: "read_error",
        report: {
          status: "error",
          error:
            kind === "oversized multibyte"
              ? "file_too_large"
              : "file_read_error",
        },
      });
    },
  );

  it("resolves a multibyte auth.ini just below the byte cap", async () => {
    const prefix = `api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n#`;
    const remaining = 65_535 - Buffer.byteLength(prefix);
    const text =
      prefix +
      "é".repeat(Math.floor(remaining / 2)) +
      "x".repeat(remaining % 2);
    expect(Buffer.byteLength(text)).toBe(65_535);
    const path = writeAuthIni(text);

    expect(await resolveFireworksAuthIni(path)).toMatchObject({
      status: "resolved",
      credential: { apiKey: INI_KEY, accountId: ACCOUNT },
    });
    const request = vi.fn(async () => jsonResponse(quotaList()));
    const report = await adapterWith(request).fetchQuota(OPTIONS);
    expect(report.state.status).toBe("fresh");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("honours the auth.ini path override and otherwise uses the vendor location", () => {
    const path = join(tempDir, "custom.ini");
    process.env.FIREWORKS_AUTH_INI = path;
    expect(fireworksAuthIniPath()).toBe(path);

    delete process.env.FIREWORKS_AUTH_INI;
    expect(
      fireworksAuthIniPath().endsWith(join(".fireworks", "auth.ini")),
    ).toBe(true);
  });
});

describe("Fireworks quota normalization", () => {
  it("derives each quota's used percentage from its own enforced value", () => {
    expect(normalizeFireworksQuotas(quotaList())).toEqual({
      windows: [
        {
          id: "quota:h100-us-iowa-1",
          label: "h100-us-iowa-1",
          kind: "unknown",
          percentUsed: 25,
          percentRemaining: 75,
        },
        {
          id: "quota:requests-per-minute",
          label: "requests-per-minute",
          kind: "unknown",
          percentUsed: 25,
          percentRemaining: 75,
        },
      ],
      untrustedWindowIds: [],
    });
  });

  it("names a quota with no usable ratio as untrusted instead of inventing one", () => {
    const normalized = normalizeFireworksQuotas({
      quotas: [
        { name: "accounts/a/quotas/zeroed", value: 0, usage: 0 },
        { name: "accounts/a/quotas/no-usage", value: 10 },
        { name: "accounts/a/quotas/negative", value: 10, usage: -1 },
        { name: "accounts/a/quotas/unparseable", value: "n/a", usage: "n/a" },
        { value: 10, usage: 5 },
      ],
    });

    expect(normalized.windows).toEqual([
      {
        id: "quota:5",
        label: "quota 5",
        kind: "unknown",
        percentUsed: 50,
        percentRemaining: 50,
      },
    ]);
    expect(normalized.untrustedWindowIds).toEqual([
      "quota:zeroed",
      "quota:no-usage",
      "quota:negative",
      "quota:unparseable",
    ]);
  });

  it("keeps a repeated quota name from overwriting the earlier reading", () => {
    const normalized = normalizeFireworksQuotas({
      quotas: [
        { name: "accounts/a/quotas/dup", value: 10, usage: 1 },
        { name: "accounts/a/quotas/dup", value: 10, usage: 9 },
      ],
    });

    expect(normalized.windows.map((window) => window.id)).toEqual([
      "quota:dup",
      "quota:2",
    ]);
  });

  it("clamps a quota reported over its own enforced value", () => {
    expect(
      normalizeFireworksQuotas({
        quotas: [{ name: "accounts/a/quotas/over", value: 10, usage: 25 }],
      }).windows[0],
    ).toMatchObject({ percentUsed: 100, percentRemaining: 0 });
  });

  it("reports an account with no quotas as no windows rather than a failure", () => {
    expect(normalizeFireworksQuotas({})).toEqual({
      windows: [],
      untrustedWindowIds: [],
    });
    expect(normalizeFireworksQuotas({ quotas: [] })).toEqual({
      windows: [],
      untrustedWindowIds: [],
    });
  });

  it.each([null, [], "invalid", 7, true].map((payload) => ({ payload })))(
    "rejects a non-object quota root: $payload",
    ({ payload }) => {
      expect(() => normalizeFireworksQuotas(payload)).toThrow("schema_invalid");
    },
  );

  it("rejects a payload whose quota list is not a list", () => {
    expect(() => normalizeFireworksQuotas({ quotas: { a: 1 } })).toThrow(
      "schema_invalid",
    );
  });
});

describe("Fireworks quota reads", () => {
  it("reads the account's quotas with the environment key", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    const request = vi.fn(async () => jsonResponse(quotaList()));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]![0])).toBe(QUOTAS_URL);
    const init = request.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${ENV_KEY}`,
    );
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(report).toMatchObject({
      provider: "fireworks",
      label: "Fireworks AI",
      source: "api",
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: "2026-09-17T12:00:00.000Z",
        sourcesTried: ["env"],
      },
    });
    expect(report.windows).toHaveLength(2);
    expect(report.attempts).toEqual([{ source: "env", status: "success" }]);
    expect(JSON.stringify(report)).not.toContain(ENV_KEY);
  });

  it("discovers the account from the vendor's own listing when none is configured", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    const request = vi.fn(async (input: unknown) =>
      String(input) === ACCOUNTS_URL
        ? jsonResponse({ accounts: [{ name: `accounts/${ACCOUNT}` }] })
        : jsonResponse(quotaList()),
    );

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request.mock.calls.map((call) => String(call[0]))).toEqual([
      ACCOUNTS_URL,
      QUOTAS_URL,
    ]);
    expect(report.state.status).toBe("fresh");
  });

  it("refuses to guess when the account listing is empty or ambiguous", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    for (const accounts of [
      [],
      [{ name: "accounts/one" }, { name: "accounts/two" }],
    ]) {
      const request = vi.fn(async () => jsonResponse({ accounts }));

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(request).toHaveBeenCalledTimes(1);
      expect(report.state).toMatchObject({
        status: "error",
        error: "fireworks_account_unresolved",
      });
      expect(report.windows).toEqual([]);
    }
  });

  it.each([
    { accounts: [{ name: "accounts/a" }], nextPageToken: "more" },
    { accounts: [{ name: "accounts/a" }], totalSize: 2 },
    { accounts: [{ name: "accounts/a" }], totalSize: "2" },
    { accounts: [{ name: "accounts/a" }], totalSize: "invalid" },
    { accounts: [{ name: "accounts/a" }], totalSize: 0 },
    { accounts: [{ name: "accounts/a" }], totalSize: null },
    { accounts: [{ name: "accounts/a" }, {}] },
    { accounts: [{ name: "accounts/a" }, { name: "accounts/../b" }] },
    { accounts: [{ name: "accounts/a" }, null] },
    { accounts: {} },
  ])(
    "rejects an incomplete or invalid account listing: %j",
    async (payload) => {
      process.env.FIREWORKS_API_KEY = ENV_KEY;
      writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
      const request = vi.fn(async () => jsonResponse(payload));

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(request).toHaveBeenCalledTimes(1);
      expect(report.state).toMatchObject({
        status: "error",
        error: "fireworks_account_unresolved",
        sourcesTried: ["env"],
      });
      expect(report.windows).toEqual([]);
    },
  );

  it.each([1, "1", undefined])(
    "accepts a complete single-account listing with totalSize %s",
    async (totalSize) => {
      process.env.FIREWORKS_API_KEY = ENV_KEY;
      const request = vi.fn(async (input: unknown) =>
        String(input) === ACCOUNTS_URL
          ? jsonResponse({
              accounts: [{ name: `accounts/${ACCOUNT}` }],
              nextPageToken: "",
              totalSize,
            })
          : jsonResponse(quotaList()),
      );

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("fresh");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("reports paginated quotas as incomplete without switching credentials", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
    const request = vi.fn(async () =>
      jsonResponse({ ...quotaList(), nextPageToken: "more" }),
    );

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state).toMatchObject({
      status: "error",
      error: "fireworks_quota_incomplete",
      sourcesTried: ["env"],
    });
    expect(report.state.authStatus).toBeUndefined();
    expect(report.windows).toEqual([]);
  });

  it.each([
    [
      "a declared total larger than the rows returned",
      { ...quotaList(), totalSize: 5 },
    ],
    [
      "a declared total that cannot be read as a number",
      { ...quotaList(), totalSize: "many" },
    ],
    ["a declared total beside an empty page", { quotas: [], totalSize: 3 }],
  ])(
    // `nextPageToken` is absent in every case here: a short page is
    // indistinguishable from a complete one once it is published, so an
    // unprovable total has to fail closed on its own.
    "reports %s as incomplete even with no continuation token",
    async (_label, payload) => {
      process.env.FIREWORKS_API_KEY = ENV_KEY;
      process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
      writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
      const request = vi.fn(async () => jsonResponse(payload));

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(request).toHaveBeenCalledTimes(1);
      expect(report.state).toMatchObject({
        status: "error",
        error: "fireworks_quota_incomplete",
        sourcesTried: ["env"],
      });
      expect(report.windows).toEqual([]);
    },
  );

  it.each([
    [
      "a declared total matching the rows returned",
      { ...quotaList(), totalSize: 2 },
    ],
    [
      "a declared total below the rows returned",
      { ...quotaList(), totalSize: 1 },
    ],
    ["an empty page declaring no rows", { quotas: [], totalSize: 0 }],
    ["no declared total at all", { quotas: quotaList().quotas }],
  ])("accepts a quota list proven whole by %s", async (_label, payload) => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    const request = vi.fn(async () => jsonResponse(payload));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.state.error).toBeUndefined();
  });

  it.each([null, [], "invalid", 7, true].map((payload) => ({ payload })))(
    "reports a non-object quota response as a failed read: $payload",
    async ({ payload }) => {
      process.env.FIREWORKS_API_KEY = ENV_KEY;
      process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
      writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
      const request = vi.fn(async () => jsonResponse(payload));

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(request).toHaveBeenCalledTimes(1);
      expect(report.state).toMatchObject({
        status: "error",
        error: "schema_invalid",
        sourcesTried: ["env"],
      });
      expect(report.state.authStatus).toBeUndefined();
      expect(report.windows).toEqual([]);
    },
  );

  it("names untrusted quotas on the fresh reading", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    const request = vi.fn(async () =>
      jsonResponse({
        quotas: [
          { name: "accounts/a/quotas/good", value: 4, usage: 1 },
          { name: "accounts/a/quotas/bad", value: 0, usage: 0 },
        ],
      }),
    );

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(report.state.untrustedWindowIds).toEqual(["quota:bad"]);
    expect(report.windows.map((window) => window.id)).toEqual(["quota:good"]);
  });

  it.each([{}, { quotas: [] }])(
    "returns a fresh empty reading for %j",
    async (payload) => {
      process.env.FIREWORKS_API_KEY = ENV_KEY;
      process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
      const request = vi.fn(async () => jsonResponse(payload));

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("fresh");
      expect(report.windows).toEqual([]);
      expect(report.state.untrustedWindowIds).toBeUndefined();
    },
  );
});

describe("Fireworks credential selection and failures", () => {
  it("hands over to auth.ini only after the environment key is definitively rejected", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
    const bearers: string[] = [];
    const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      bearers.push(bearer);
      return bearer === `Bearer ${INI_KEY}`
        ? jsonResponse(quotaList())
        : jsonResponse({}, 401);
    });

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(bearers).toEqual([`Bearer ${ENV_KEY}`, `Bearer ${INI_KEY}`]);
    expect(report.state.status).toBe("fresh");
    expect(report.state.sourcesTried).toEqual(["env", "fireworks:auth.ini"]);
    expect(report.attempts).toEqual([
      { source: "env", status: "failed", error: "provider_auth_rejected" },
      { source: "fireworks:auth.ini", status: "success" },
    ]);
  });

  it("marks the superseded environment key as a degraded source", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
    const request = vi.fn(async (_input: unknown, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === `Bearer ${INI_KEY}`
        ? jsonResponse(quotaList())
        : jsonResponse({}, 401),
    );

    const report = withQuotaSemantics(
      await adapterWith(request).fetchQuota(OPTIONS),
      "2026-09-17T12:00:00.000Z",
    );

    expect(report.state.degradedSources).toEqual([
      { source: "env", error: "provider_auth_rejected" },
    ]);
  });

  it("reports sign-in required only when every readable key is rejected", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
    const request = vi.fn(async () => jsonResponse({}, 401));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
    expect(report.state.authStatus).toBeUndefined();
  });

  it("treats a refused quota operation as a live key without quota visibility", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    const request = vi.fn(async () => jsonResponse({}, 403));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "unavailable",
      error: "fireworks_quota_forbidden",
      authStatus: "usable",
    });
    expect(report.state.status).not.toBe("auth_required");
    expect(report.windows).toEqual([]);
  });

  it("stops at a permission-refused source without consulting another account", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    writeAuthIni(`api_key = ${INI_KEY}\naccount_id = another-account\n`);
    const resolve = vi.fn(resolveFireworksCredential);
    const request = vi.fn(async (_input: unknown, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === `Bearer ${INI_KEY}`
        ? jsonResponse(quotaList())
        : jsonResponse({}, 403),
    );

    const report = await adapterWith(request, resolve).fetchQuota(OPTIONS);

    expect(resolve.mock.calls).toEqual([["env"]]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]![0])).toBe(QUOTAS_URL);
    expect(report.state).toMatchObject({
      status: "unavailable",
      error: "fireworks_quota_forbidden",
      authStatus: "usable",
      sourcesTried: ["env"],
    });
    expect(report.windows).toEqual([]);
    expect(report.attempts).toEqual([
      { source: "env", status: "failed", error: "fireworks_quota_forbidden" },
    ]);
  });

  it("reports a rate limit with the vendor's retry instant", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
    try {
      const request = vi.fn(
        async () =>
          new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      );

      const report = await adapterWith(request).fetchQuota(OPTIONS);

      expect(report.state).toMatchObject({
        status: "rate_limited",
        error: "provider_rate_limited",
        retryAfter: "2026-09-17T12:00:30.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rate limit as rate limited even with no retry hint", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    const request = vi.fn(async () => new Response(null, { status: 429 }));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "rate_limited",
      error: "provider_rate_limited",
    });
    expect(report.state.retryAfter).toBeUndefined();
  });

  it("stops at a transient failure instead of switching credentials", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    writeAuthIni(`api_key = ${INI_KEY}\naccount_id = ${ACCOUNT}\n`);
    const request = vi.fn(async () => jsonResponse({}, 503));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_unavailable",
    });
    expect(report.state.sourcesTried).toEqual(["env"]);
  });

  it.each([
    [
      "a malformed body",
      async () => new Response("{not json", { status: 200 }),
    ],
    ["a redirect", async () => new Response(null, { status: 302 })],
    [
      "a network failure",
      async () => {
        throw new Error("boom");
      },
    ],
  ])(
    "reports %s as a failed read, never as a sign-out",
    async (_label, impl) => {
      process.env.FIREWORKS_API_KEY = ENV_KEY;
      process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;

      const report = await adapterWith(vi.fn(impl)).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("error");
      expect(report.windows).toEqual([]);
    },
  );

  it("reports no credential at all as sign-in required without any request", async () => {
    const request = vi.fn(async () => jsonResponse(quotaList()));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "fireworks_credential_unavailable",
    });
    expect(report.attempts).toEqual([
      { source: "env", status: "skipped", error: "credentials_missing" },
      {
        source: "fireworks:auth.ini",
        status: "skipped",
        error: "credentials_missing",
      },
    ]);
  });

  it.each(["unreadable", "oversized"])(
    "preserves an %s auth.ini as an indeterminate failure",
    async (kind) => {
      const path = writeAuthIni(
        kind === "oversized" ? "x".repeat(65_537) : `api_key = ${INI_KEY}\n`,
      );
      if (kind === "unreadable") chmodSync(path, 0o000);
      const request = vi.fn(async () => jsonResponse(quotaList()));
      try {
        const report = await adapterWith(request).fetchQuota(OPTIONS);

        expect(request).not.toHaveBeenCalled();
        expect(report.state).toMatchObject({
          status: "error",
          error: "credential_resolution_failed",
        });
        expect(report.windows).toEqual([]);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it("preserves a local read failure after a rejected environment key", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    writeAuthIni("x".repeat(65_537));
    const request = vi.fn(async () => jsonResponse({}, 401));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state).toMatchObject({
      status: "error",
      error: "credential_resolution_failed",
    });
  });

  it("keeps sign-in required for a rejected key and an absent store", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    const request = vi.fn(async () => jsonResponse({}, 401));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
  });

  it("keeps a present but unusable store visible as a credential that exists", async () => {
    process.env.FIREWORKS_API_KEY = "$FROM_SOMEWHERE_ELSE";
    const request = vi.fn(async () => jsonResponse(quotaList()));

    const report = await adapterWith(request).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "fireworks_credential_invalid",
    });
    expect(report.attempts?.[0]).toEqual({
      source: "env",
      status: "skipped",
      error: "credentials_invalid",
      credentialPresent: true,
    });
  });
});

describe("Fireworks auth inspection", () => {
  it("names both stores and never prints a credential value", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    const path = writeAuthIni(`api_key = ${INI_KEY}\n`);

    const report = await createFireworksAdapter().inspectAuth(OPTIONS);

    expect(report).toEqual({
      provider: "fireworks",
      sources: [
        { source: "env", path: "$FIREWORKS_API_KEY", status: "available" },
        { source: "fireworks:auth.ini", path, status: "available" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(ENV_KEY);
    expect(JSON.stringify(report)).not.toContain(INI_KEY);
  });
});

describe("Fireworks quota interpretation", () => {
  it("publishes the windows as data and claims no combined bound", async () => {
    process.env.FIREWORKS_API_KEY = ENV_KEY;
    process.env.FIREWORKS_ACCOUNT_ID = ACCOUNT;
    const request = vi.fn(async () => jsonResponse(quotaList()));

    const report = withQuotaSemantics(
      await adapterWith(request).fetchQuota(OPTIONS),
      "2026-09-17T12:00:00.000Z",
    );

    expect(report.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: [
        "quota:h100-us-iowa-1",
        "quota:requests-per-minute",
      ],
    });
    expect(report.quotaSemantics?.description).toContain("Fireworks");
  });
});
