import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { devinCacheContextId } from "../../src/providers/devin-cache-context.js";
import {
  createDevinAdapter,
  createDevinEnvSource,
  createDevinFileSource,
  DEVIN_API_ORIGIN,
  DEVIN_ENV_SOURCE,
  DEVIN_FILE_SOURCE,
  DEVIN_SOURCE_ORDER,
  DEVIN_USER_STATUS_PATH,
  devinCredentialsFilePath,
  normalizeDevinPayload,
  type DevinCredentialSource,
  type DevinLocalResolution,
} from "../../src/providers/devin.js";
import type { ProviderQuota } from "../../src/types.js";
import { VERSION } from "../../src/version.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const SYNTHETIC_KEY = "synthetic-devin-key-481";
const FILE_KEY = "synthetic-devin-file-key-772";
const SESSION_TOKEN =
  "devin-session-token$eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uX2lkIjoiZml4dHVyZSJ9.c2lnbmF0dXJl";

const WEEKLY = {
  id: "weekly",
  label: "week",
  kind: "weekly" as const,
  percentRemaining: 60,
  percentUsed: 40,
  windowSeconds: 604_800,
  startsAt: "2026-09-20T08:00:00.000Z",
  resetsAt: "2026-09-27T08:00:00.000Z",
};
const DAILY = {
  id: "daily",
  label: "day",
  kind: "session" as const,
  percentRemaining: 80,
  percentUsed: 20,
  windowSeconds: 86_400,
  startsAt: "2026-09-22T08:00:00.000Z",
  resetsAt: "2026-09-23T08:00:00.000Z",
};

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), `test/fixtures/devin/${name}.json`),
      "utf8",
    ),
  ) as unknown;

const PRO = fixture("pro");
const MAX = fixture("max");
const EXHAUSTED = fixture("exhausted-weekly");
const OUT_OF_RANGE = fixture("out-of-range");
const NON_QUOTA = fixture("non-quota");
const NO_QUOTA = fixture("no-quota");

type DevinTestPayload = {
  userStatus: { planStatus: Record<string, unknown> };
  planInfo: Record<string, unknown>;
};

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Devin request transport", () => {
  it("posts one Connect-JSON read to the allowlisted host and identifies as quota-axi", async () => {
    const request = sequentialFetch([jsonResponse(PRO)]);
    await testAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    const url = new URL(String(input));
    expect({
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      method: init?.method,
      redirect: init?.redirect,
      credentials: init?.credentials,
    }).toEqual({
      protocol: "https:",
      hostname: "server.codeium.com",
      pathname: DEVIN_USER_STATUS_PATH,
      search: "",
      method: "POST",
      redirect: "manual",
      credentials: "omit",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("connect-protocol-version")).toBe("1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
    const body = JSON.parse(String(init?.body)) as {
      metadata: Record<string, string>;
    };
    expect(body.metadata).toMatchObject({
      apiKey: SYNTHETIC_KEY,
      ideName: "quota-axi",
      extensionName: "quota-axi",
      ideVersion: VERSION,
      extensionVersion: VERSION,
    });
    expect(body.metadata.ideVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(new URL(DEVIN_API_ORIGIN).hostname).toBe("server.codeium.com");
  });

  it("declares env before the credentials file", () => {
    expect([...DEVIN_SOURCE_ORDER]).toEqual([
      DEVIN_ENV_SOURCE,
      DEVIN_FILE_SOURCE,
    ]);
  });
});

describe("Devin credential matrix", () => {
  it("primary healthy: reports included daily and weekly quota", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(PRO)]),
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, new Date(NOW).toISOString());

    expect(report.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
    });
    expect(report.plan).toBe("pro");
    expect(report.account).toEqual({
      email: "person@example.invalid",
      accountId: "fixture-user",
    });
    expect(report.windows).toEqual([WEEKLY, DAILY]);
    expect(report.credits).toEqual({ remaining: 2.5, unit: "usd" });
    expect(JSON.stringify(report)).not.toContain("availablePromptCredits");
    expect(JSON.stringify(report)).not.toContain("fixture-team");
    expect(report.attempts).toEqual([
      { source: DEVIN_ENV_SOURCE, status: "success" },
    ]);
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "known",
      effectiveAvailability: [
        {
          scope: "included_quota",
          status: "known",
          effectivePercentRemaining: 60,
          boundedBy: ["weekly", "daily"],
        },
      ],
    });
  });

  it("reuses the session kind for the daily window", () => {
    const normalized = normalizeDevinPayload(PRO, NOW);
    expect(
      normalized.windows.find((window) => window.id === "daily")?.kind,
    ).toBe("session");
  });

  it("omits the daily window when the vendor hides it", () => {
    const normalized = normalizeDevinPayload(MAX, NOW);
    expect(normalized.windows.map((window) => window.id)).toEqual(["weekly"]);
    expect(normalized.windows[0]).toMatchObject({
      percentRemaining: 40,
      percentUsed: 60,
    });
    expect(normalized.credits).toEqual({ remaining: 0, unit: "usd" });
    const interpreted = withQuotaSemantics(
      {
        provider: "devin",
        windows: normalized.windows,
        state: { status: "fresh", stale: false },
      },
      new Date(NOW).toISOString(),
    );
    expect(interpreted.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
      scope: "included_quota",
      status: "known",
      effectivePercentRemaining: 40,
      boundedBy: ["weekly"],
    });
  });

  it("treats a missing percent with a present reset as proto3 zero", () => {
    const normalized = normalizeDevinPayload(EXHAUSTED, NOW);
    expect(normalized.windows).toEqual([
      { ...WEEKLY, percentRemaining: 0, percentUsed: 100 },
      { ...DAILY, percentRemaining: 25, percentUsed: 75 },
    ]);
    const interpreted = withQuotaSemantics(
      {
        provider: "devin",
        windows: normalized.windows,
        state: { status: "fresh", stale: false },
      },
      new Date(NOW).toISOString(),
    );
    expect(
      interpreted.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBe(0);
  });

  it("names a missing daily cap as untrusted instead of letting weekly alone bind", () => {
    const payload = structuredClone(PRO) as {
      userStatus: { planStatus: Record<string, unknown> };
    };
    delete payload.userStatus.planStatus.dailyQuotaRemainingPercent;
    delete payload.userStatus.planStatus.dailyQuotaResetAtUnix;
    const normalized = normalizeDevinPayload(payload, NOW);
    expect(normalized.windows.map((w) => w.id)).toEqual(["weekly"]);
    expect(normalized.untrustedWindowIds).toEqual(["daily"]);
    expect(interpretNormalized(normalized).quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["daily"],
    });
    expect(
      interpretNormalized(normalized).quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBeUndefined();
  });

  it("names a daily cap from a finished cycle as untrusted", () => {
    const payload = structuredClone(PRO) as {
      userStatus: { planStatus: Record<string, unknown> };
    };
    payload.userStatus.planStatus.dailyQuotaResetAtUnix = String(
      Date.parse("2026-09-22T08:00:00.000Z") / 1000,
    );
    const normalized = normalizeDevinPayload(payload, NOW);
    expect(normalized.windows.map((w) => w.id)).toEqual(["weekly"]);
    expect(normalized.untrustedWindowIds).toEqual(["daily"]);
    expect(interpretNormalized(normalized).quotaSemantics?.status).toBe(
      "partial",
    );
  });

  it("names a missing weekly cap as untrusted even when daily is readable", () => {
    const payload = structuredClone(PRO) as {
      userStatus: { planStatus: Record<string, unknown> };
    };
    delete payload.userStatus.planStatus.weeklyQuotaRemainingPercent;
    delete payload.userStatus.planStatus.weeklyQuotaResetAtUnix;
    const normalized = normalizeDevinPayload(payload, NOW);
    expect(normalized.windows.map((w) => w.id)).toEqual(["daily"]);
    expect(normalized.untrustedWindowIds).toEqual(["weekly"]);
    expect(interpretNormalized(normalized).quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["weekly"],
    });
  });

  it("does not bind a daily figure without evidence that the vendor enforces it", () => {
    const payload = structuredClone(MAX) as {
      planInfo: Record<string, unknown>;
    };
    delete payload.planInfo.hideDailyQuota;
    const normalized = normalizeDevinPayload(payload, NOW);
    expect(normalized.windows.map((window) => window.id)).toEqual(["weekly"]);
    expect(normalized.untrustedWindowIds).toEqual(["daily"]);
    expect(interpretNormalized(normalized).quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["daily"],
    });
    expect(
      interpretNormalized(normalized).quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBeUndefined();
  });

  it("rejects a hideDailyQuota that is not a boolean", () => {
    const payload = structuredClone(MAX) as {
      planInfo: Record<string, unknown>;
    };
    payload.planInfo.hideDailyQuota = "true";
    expect(() => normalizeDevinPayload(payload, NOW)).toThrow("schema_invalid");
  });

  it("names an out-of-range percent as untrusted and keeps semantics partial", () => {
    const normalized = normalizeDevinPayload(OUT_OF_RANGE, NOW);
    expect(normalized.untrustedWindowIds).toEqual(["weekly"]);
    expect(
      normalized.windows.find((w) => w.id === "weekly")?.percentRemaining,
    ).toBeUndefined();
    const interpreted = withQuotaSemantics(
      {
        provider: "devin",
        windows: normalized.windows,
        state: {
          status: "fresh",
          stale: false,
          untrustedWindowIds: normalized.untrustedWindowIds,
        },
      },
      new Date(NOW).toISOString(),
    );
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["weekly"],
    });
    expect(
      interpreted.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBeUndefined();
  });

  it("fails closed on a non-quota billing strategy and still reports credits", () => {
    const normalized = normalizeDevinPayload(NON_QUOTA, NOW);
    expect(normalized.windows).toEqual([]);
    expect(normalized.credits).toEqual({ remaining: 5, unit: "usd" });
    expect(JSON.stringify(normalized)).not.toContain("acuConsumed");
    expect(JSON.stringify(normalized)).not.toContain("acuLimit");
  });

  it.each([
    [
      "quota fields without a billing strategy",
      (payload: DevinTestPayload) => {
        delete payload.planInfo.billingStrategy;
      },
    ],
    [
      "every expected cap from a finished cycle",
      (payload: DevinTestPayload) => {
        const elapsed = String(Date.parse("2026-09-22T08:00:00.000Z") / 1000);
        payload.userStatus.planStatus.dailyQuotaResetAtUnix = elapsed;
        payload.userStatus.planStatus.weeklyQuotaResetAtUnix = elapsed;
      },
    ],
  ])("preserves the cache on %s", async (_label, mutate) => {
    const deleted: string[] = [];
    const contextId = devinCacheContextId(
      DEVIN_ENV_SOURCE,
      DEVIN_API_ORIGIN,
      SYNTHETIC_KEY,
    );
    const payload = structuredClone(PRO) as DevinTestPayload;
    mutate(payload);
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(payload)]),
      deleteCachedProvider: (provider) => deleted.push(provider),
      readCachedProvider: (id) =>
        id === contextId ? cachedQuota() : undefined,
    }).fetchQuota(OPTIONS);

    expect(deleted).toEqual([]);
    expect(report.state).toMatchObject({
      status: "stale",
      error: "schema_incomplete",
    });
    expect(report.windows[0]?.percentRemaining).toBe(90);
  });

  it("reports an authenticated body with no quota fields as fresh and empty", async () => {
    const report = await testAdapter({
      fetch: sequentialFetch([jsonResponse(NO_QUOTA)]),
    }).fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
    });
    expect(report.windows).toEqual([]);
    expect(report.credits).toBeUndefined();
  });

  it("does not skip a readable token unprobed, and hands a rejected env token to the file", async () => {
    const request = sequentialFetch([
      new Response(null, { status: 401 }),
      jsonResponse(PRO),
    ]);
    const report = await testAdapter({
      fetch: request,
      sources: [
        createDevinEnvSource({ WINDSURF_API_KEY: SYNTHETIC_KEY }),
        fileSource({
          status: "resolved",
          credential: { token: FILE_KEY, origin: DEVIN_API_ORIGIN },
        }),
      ],
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(apiKey(request.mock.calls[0][1])).toBe(SYNTHETIC_KEY);
    expect(apiKey(request.mock.calls[1][1])).toBe(FILE_KEY);
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      {
        source: DEVIN_ENV_SOURCE,
        status: "failed",
        error: "provider_auth_rejected",
        credentialPresent: true,
      },
      { source: DEVIN_FILE_SOURCE, status: "success" },
    ]);
    const interpreted = withQuotaSemantics(report, new Date(NOW).toISOString());
    expect(interpreted.state.degradedSources).toEqual([
      { source: DEVIN_ENV_SOURCE, error: "provider_auth_rejected" },
    ]);
  });

  it("never sends a structurally invalid env value, and does not fall through to the file", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      fetch: request as unknown as typeof fetch,
      sources: [
        createDevinEnvSource({ WINDSURF_API_KEY: "$WINDSURF_API_KEY" }),
        fileSource({
          status: "resolved",
          credential: { token: FILE_KEY, origin: DEVIN_API_ORIGIN },
        }),
      ],
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "error",
      error: "devin_credential_invalid",
    });
    expect(report.state.authStatus).toBeUndefined();
    expect(report.state.remedyCommand).toBeUndefined();
    expect(report.attempts).toEqual([
      {
        source: DEVIN_ENV_SOURCE,
        status: "failed",
        error: "devin_credential_invalid",
        credentialPresent: true,
      },
    ]);
  });

  it("treats a blank env value as absent and reads the file", async () => {
    const request = sequentialFetch([jsonResponse(MAX)]);
    const report = await testAdapter({
      fetch: request,
      sources: [
        createDevinEnvSource({ WINDSURF_API_KEY: "   " }),
        fileSource({
          status: "resolved",
          credential: { token: FILE_KEY, origin: DEVIN_API_ORIGIN },
        }),
      ],
    }).fetchQuota(OPTIONS);

    expect(apiKey(request.mock.calls[0][1])).toBe(FILE_KEY);
    expect(report.attempts[0]).toEqual({
      source: DEVIN_ENV_SOURCE,
      status: "skipped",
      error: "devin_credential_unavailable",
    });
    expect(report.attempts[0].credentialPresent).toBeUndefined();
    expect(report.windows.map((window) => window.id)).toEqual(["weekly"]);
  });

  it("absent sources make no request and carry no credentialPresent marker", async () => {
    const request = vi.fn();
    const report = await testAdapter({
      fetch: request as unknown as typeof fetch,
      sources: [createDevinEnvSource({}), fileSource({ status: "absent" })],
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "devin_credential_unavailable",
      remedyCommand: "devin auth login",
    });
    for (const attempt of report.attempts ?? []) {
      expect(attempt.status).toBe("skipped");
      expect(attempt.credentialPresent).toBeUndefined();
    }
  });

  it("retires the matching cache when every probed credential is rejected", async () => {
    const deleted: string[] = [];
    const contextId = devinCacheContextId(
      DEVIN_ENV_SOURCE,
      DEVIN_API_ORIGIN,
      SYNTHETIC_KEY,
    );
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 401 })]),
      deleteCachedProvider: (provider) => deleted.push(provider),
      readCachedProvider: (id) =>
        id === contextId ? cachedQuota() : undefined,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
      authStatus: "unusable",
    });
    expect(deleted).toEqual(["devin"]);
  });

  it("has no refresh delegate: refreshCredentials does not change the read", async () => {
    const adapter = testAdapter({
      fetch: sequentialFetch([jsonResponse(PRO)]),
    });
    expect(adapter.discoverAccounts).toBeUndefined();
    const refreshed = await testAdapter({
      fetch: sequentialFetch([jsonResponse(PRO)]),
    }).fetchQuota({ ...OPTIONS, refreshCredentials: true });
    const plain = await adapter.fetchQuota(OPTIONS);
    expect(refreshed.windows).toEqual(plain.windows);
    expect(refreshed.state.status).toBe("fresh");
  });

  it("stops handover on a transient failure and serves the same credential's stale windows", async () => {
    const deleted: string[] = [];
    const contextId = devinCacheContextId(
      DEVIN_ENV_SOURCE,
      DEVIN_API_ORIGIN,
      SYNTHETIC_KEY,
    );
    const request = sequentialFetch([new Response(null, { status: 503 })]);
    const report = await testAdapter({
      fetch: request,
      sources: [
        createDevinEnvSource({ WINDSURF_API_KEY: SYNTHETIC_KEY }),
        fileSource({
          status: "resolved",
          credential: { token: FILE_KEY, origin: DEVIN_API_ORIGIN },
        }),
      ],
      deleteCachedProvider: (provider) => deleted.push(provider),
      readCachedProvider: (id) =>
        id === contextId ? cachedQuota() : undefined,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual([]);
    expect(report.state.status).toBe("stale");
    expect(report.state.stale).toBe(true);
    expect(report.windows[0]?.percentRemaining).toBe(90);
    expect(report.state.sourcesTried).toEqual([DEVIN_ENV_SOURCE, "cache"]);
  });

  it("reports a 401 as a rejection without waiting on its stalled body", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
    });
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(stalled, { status: 401 })]),
      deadlineMs: 50,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
      authStatus: "unusable",
    });
  });

  it("times out a stalled body even when its cancellation never settles", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => new Promise(() => {}),
    });
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(stalled, { status: 200 })]),
      deadlineMs: 20,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "request_timeout",
    });
  });

  it("preserves the cache on HTTP 400", async () => {
    const deleted: string[] = [];
    const contextId = devinCacheContextId(
      DEVIN_ENV_SOURCE,
      DEVIN_API_ORIGIN,
      SYNTHETIC_KEY,
    );
    const report = await testAdapter({
      fetch: sequentialFetch([new Response(null, { status: 400 })]),
      deleteCachedProvider: (provider) => deleted.push(provider),
      readCachedProvider: (id) =>
        id === contextId ? cachedQuota() : undefined,
    }).fetchQuota(OPTIONS);

    expect(deleted).toEqual([]);
    expect(report.state.status).toBe("stale");
    expect(report.state.error).toBe("provider_request_rejected");
  });

  it("does not send a token whose server is outside the allowlist", async () => {
    const request = vi.fn();
    const adapter = testAdapter({
      fetch: request as unknown as typeof fetch,
      sources: [
        createDevinEnvSource({
          WINDSURF_API_KEY: SYNTHETIC_KEY,
          WINDSURF_API_SERVER_URL: "https://enterprise.example",
        }),
        fileSource({
          status: "resolved",
          credential: { token: FILE_KEY, origin: DEVIN_API_ORIGIN },
        }),
      ],
    });
    const report = await adapter.fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("unsupported_server");
    expect(report.state.authStatus).toBeUndefined();
    expect(
      adapter.isUncertainSkip?.(
        report.attempts?.[0] ?? { source: "", status: "skipped" },
      ),
    ).toBe(true);
  });

  it("sends a vendor session token that embeds $", async () => {
    const request = sequentialFetch([jsonResponse(NO_QUOTA)]);
    await testAdapter({
      fetch: request,
      sources: [createDevinEnvSource({ WINDSURF_API_KEY: SESSION_TOKEN })],
    }).fetchQuota(OPTIONS);
    expect(apiKey(request.mock.calls[0][1])).toBe(SESSION_TOKEN);
  });

  it.each([
    ["an environment reference", "$WINDSURF_API_KEY"],
    ["a command reference", "!op read op://vault/key"],
    ["a control byte", "devin-\u0007-fixture"],
  ])("never sends %s", async (_label, value) => {
    const request = vi.fn();
    const report = await testAdapter({
      fetch: request as unknown as typeof fetch,
      sources: [createDevinEnvSource({ WINDSURF_API_KEY: value })],
    }).fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("error");
    expect(report.state.remedyCommand).toBeUndefined();
    expect(report.attempts?.[0].credentialPresent).toBe(true);
  });
});

describe("Devin credentials file", () => {
  it("reads the XDG path and ignores every other key", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-devin-"));
    const directory = join(tempDir, "devin");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "credentials.toml"),
      [
        "# fixture",
        `windsurf_api_key = "${FILE_KEY}"`,
        'api_server_url = "https://server.codeium.com"',
        'devin_webapp_host = "app.devin.ai"',
        "dangerously_skip_plugin_authentication = false",
      ].join("\n"),
    );
    const request = sequentialFetch([jsonResponse(PRO)]);
    const report = await testAdapter({
      fetch: request,
      sources: [createDevinFileSource({ XDG_DATA_HOME: tempDir })],
    }).fetchQuota(OPTIONS);

    expect(apiKey(request.mock.calls[0][1])).toBe(FILE_KEY);
    expect(String(request.mock.calls[0][0])).toBe(
      `${DEVIN_API_ORIGIN}${DEVIN_USER_STATUS_PATH}`,
    );
    expect(report.state.status).toBe("fresh");
  });

  it.each([
    ["array", "metadata = [1, 2, 3]"],
    ["timestamp", "created_at = 2026-09-22T12:00:00Z"],
    ["float", "ratio = 0.75"],
    ["inline table", 'metadata = { version = "1.0" }'],
    ["unknown key", 'devin_webapp_host = "app.devin.ai"'],
    ["table header", "[metadata]\nwindsurf_api_key = [1, 2]"],
  ])(
    "ignores unrelated TOML %s in the credentials file",
    async (_name, metadata) => {
      tempDir = mkdtempSync(join(tmpdir(), "quota-axi-devin-"));
      mkdirSync(join(tempDir, "devin"));
      writeFileSync(
        join(tempDir, "devin", "credentials.toml"),
        `windsurf_api_key = "${FILE_KEY}"\n${metadata}\n`,
      );
      const request = sequentialFetch([jsonResponse(PRO)]);
      const source = createDevinFileSource({ XDG_DATA_HOME: tempDir });
      expect(source.inspect().status).toBe("available");
      const report = await testAdapter({
        fetch: request,
        sources: [source],
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("fresh");
      expect(request).toHaveBeenCalledTimes(1);
      expect(apiKey(request.mock.calls[0][1])).toBe(FILE_KEY);
    },
  );

  it.each([
    'windsurf_api_key = "valid-key"\nwindsurf_api_key = [1, 2]',
    'windsurf_api_key = "unterminated',
    `windsurf_api_key = "${FILE_KEY}"\napi_server_url = { host = 'server.codeium.com' }`,
  ])("does not send a malformed needed credential value: %s", async (line) => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-devin-"));
    mkdirSync(join(tempDir, "devin"));
    writeFileSync(join(tempDir, "devin", "credentials.toml"), `${line}\n`);
    const request = vi.fn();
    const report = await testAdapter({
      fetch: request as unknown as typeof fetch,
      sources: [createDevinFileSource({ XDG_DATA_HOME: tempDir })],
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.error).toBe("devin_credentials_malformed");
    expect(report.attempts?.[0].credentialPresent).toBe(true);
  });

  it("resolves XDG, the Unix default, and the Windows APPDATA path", () => {
    expect(
      devinCredentialsFilePath(
        { XDG_DATA_HOME: "/custom/data" },
        { platform: "linux", home: "/home/fixture" },
      ),
    ).toBe("/custom/data/devin/credentials.toml");
    expect(
      devinCredentialsFilePath(
        {},
        { platform: "linux", home: "/home/fixture" },
      ),
    ).toBe("/home/fixture/.local/share/devin/credentials.toml");
    expect(
      devinCredentialsFilePath(
        { APPDATA: "C:\\Users\\fixture\\AppData\\Roaming" },
        { platform: "win32", home: "C:\\Users\\fixture" },
      ),
    ).toBe(
      join("C:\\Users\\fixture\\AppData\\Roaming", "devin", "credentials.toml"),
    );
    expect(
      devinCredentialsFilePath(
        {},
        { platform: "win32", home: "C:\\Users\\fixture" },
      ),
    ).toBeUndefined();
  });
});

describe("Devin auth inspection", () => {
  it("enumerates both sources by presence and never returns the token", async () => {
    const report = await testAdapter({
      sources: [
        createDevinEnvSource({ WINDSURF_API_KEY: SYNTHETIC_KEY }),
        createDevinFileSource({ XDG_DATA_HOME: "/no/such/devin-data" }),
      ],
    }).inspectAuth(OPTIONS);

    expect(report.sources.map((source) => source.status)).toEqual([
      "available",
      "missing",
    ]);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
  });
});

function testAdapter(
  overrides: Partial<{
    fetch: typeof fetch;
    sources: readonly DevinCredentialSource[];
    readCachedProvider: (contextId: string) => ProviderQuota | undefined;
    deleteCachedProvider: (provider: "devin") => void;
    deadlineMs: number;
  }> = {},
) {
  return createDevinAdapter({
    sources: overrides.sources ?? [
      createDevinEnvSource({ WINDSURF_API_KEY: SYNTHETIC_KEY }),
    ],
    fetch:
      overrides.fetch ??
      (sequentialFetch([jsonResponse(PRO)]) as unknown as typeof fetch),
    now: () => NOW,
    ...(overrides.readCachedProvider
      ? { readCachedProvider: overrides.readCachedProvider }
      : {}),
    ...(overrides.deleteCachedProvider
      ? { deleteCachedProvider: overrides.deleteCachedProvider }
      : {}),
    ...(overrides.deadlineMs ? { deadlineMs: overrides.deadlineMs } : {}),
  });
}

function interpretNormalized(
  normalized: ReturnType<typeof normalizeDevinPayload>,
): ProviderQuota {
  return withQuotaSemantics(
    {
      provider: "devin",
      windows: normalized.windows,
      state: {
        status: "fresh",
        stale: false,
        untrustedWindowIds: normalized.untrustedWindowIds,
      },
    },
    new Date(NOW).toISOString(),
  );
}

function fileSource(resolution: DevinLocalResolution): DevinCredentialSource {
  return {
    name: DEVIN_FILE_SOURCE,
    resolve: () => resolution,
    inspect: () => ({ status: "missing" }),
  };
}

function sequentialFetch(responses: Response[]) {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected Devin request");
    return next;
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function apiKey(init: RequestInit | undefined): string | undefined {
  return (JSON.parse(String(init?.body)) as { metadata?: { apiKey?: string } })
    .metadata?.apiKey;
}

function cachedQuota(): ProviderQuota {
  return {
    provider: "devin",
    label: "Devin",
    source: "api",
    windows: [
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 10,
        percentRemaining: 90,
        windowSeconds: 604_800,
        startsAt: "2026-09-20T08:00:00.000Z",
        resetsAt: "2026-09-27T08:00:00.000Z",
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: "2026-09-22T00:00:00.000Z",
    },
  };
}
