import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpaEnvFilePath, reuseContextId } from "../src/lib/reuse-context.js";
import {
  fetchAccountQuotas,
  inspectAccountAuth,
} from "../src/providers/accounts.js";
import { createCpaAdapter, readCpaConfig } from "../src/providers/cpa.js";
import {
  readCachedClaudeProvider,
  readCachedProvider,
  writeCachedProviders,
} from "../src/cache.js";
import { quotaCommand } from "../src/commands.js";
import { claudeCredentialContextId } from "../src/lib/fs.js";
import { PROVIDERS } from "../src/providers/index.js";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderOptions,
  QuotaAxiResponse,
} from "../src/types.js";

const options: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};
const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];
const originalClaude = PROVIDERS.claude;
const originalCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  const cacheHome = mkdtempSync(join(tmpdir(), "quota-axi-cpa-cache-"));
  roots.push(cacheHome);
  process.env.XDG_CACHE_HOME = cacheHome;
});

afterEach(async () => {
  PROVIDERS.claude = originalClaude;
  process.env.XDG_CACHE_HOME = originalCacheHome;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

type UpstreamCall = {
  url: string;
  auth_index: string;
  header: Record<string, string>;
};
type ManagementRequest = { path: string; authorization?: string; body: string };
type Upstream = (
  call: UpstreamCall,
) => { status_code: number; body: unknown } | undefined;

const CLAUDE_USAGE = {
  five_hour: { utilization: 25, resets_at: "2030-01-01T01:00:00Z" },
  seven_day: { utilization: 10, resets_at: "2030-01-02T01:00:00Z" },
};

const healthyClaude: Upstream = (call) => ({
  status_code: 200,
  body: call.url.includes("/usage")
    ? CLAUDE_USAGE
    : { account: { uuid: `uuid-${call.auth_index}` } },
});

function fakeServer(
  files: Record<string, unknown>[],
  upstream: Upstream = healthyClaude,
  authFilesStatus = 200,
): Promise<{
  baseUrl: string;
  calls: UpstreamCall[];
  requests: ManagementRequest[];
}> {
  const calls: UpstreamCall[] = [];
  const requests: ManagementRequest[] = [];
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/management/auth-files") {
        response.statusCode = authFilesStatus;
        response.end(JSON.stringify({ files }));
        return;
      }
      if (request.url === "/v0/management/api-call") {
        const parsed = JSON.parse(body) as UpstreamCall;
        calls.push(parsed);
        const answer = upstream(parsed);
        if (!answer) {
          response.statusCode = 502;
          response.end();
          return;
        }
        const { status_code, body: payload } = answer;
        response.end(
          JSON.stringify({ status_code, body: JSON.stringify(payload) }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    },
  );
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fake server did not bind");
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        calls,
        requests,
      });
    }),
  );
}

function fallbackAdapter(provider: ProviderId): ProviderAdapter {
  return {
    id: provider,
    label: provider === "claude" ? "Claude" : "Codex",
    fetchQuota: async () => ({
      provider,
      source: "oauth",
      windows: [],
      state: { status: "unavailable", stale: false, error: "native_read" },
    }),
    inspectAuth: async () => ({ provider, sources: [] }),
  };
}

describe("CLIProxyAPI provider", () => {
  it("reports each pooled account as its own row with only vendor figures", async () => {
    const fake = await fakeServer([
      { auth_index: "claude-1", provider: "claude", email: "a@example.test" },
      { auth_index: "claude-2", provider: "Claude", email: "b@example.test" },
      { auth_index: "anthropic-1", provider: "anthropic" },
      { auth_index: "codex-1", provider: "codex" },
    ]);
    const key = randomUUID();
    const adapter = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({
        baseUrl: fake.baseUrl,
        key,
      }),
    );

    const rows = await fetchAccountQuotas(adapter, options);

    expect(rows.map((row) => row.accountKey)).toEqual([
      "cpa-claude-1",
      "cpa-claude-2",
    ]);
    for (const row of rows) {
      expect(row.source).toBe("cpa");
      expect(row.state.status).toBe("fresh");
      expect(
        row.windows.map((window) => [window.id, window.percentRemaining]),
      ).toEqual([
        ["five_hour", 75],
        ["seven_day", 90],
      ]);
    }
    expect(new Set(fake.calls.map((call) => call.auth_index))).toEqual(
      new Set(["claude-1", "claude-2"]),
    );
    expect(
      fake.calls.every(
        (call) => call.header.authorization === "Bearer $TOKEN$",
      ),
    ).toBe(true);
    expect(
      fake.requests.every(
        (request) =>
          request.authorization === `Bearer ${key}` &&
          !request.body.includes(key),
      ),
    ).toBe(true);
  });

  it("does not claim a vendor identity from the CPA auth file alone", async () => {
    const fake = await fakeServer(
      [{ auth_index: "claude-1", provider: "claude", email: "a@example.test" }],
      (call) => ({
        status_code: 200,
        body: call.url.includes("/usage") ? CLAUDE_USAGE : {},
      }),
    );
    const adapter = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({
        baseUrl: fake.baseUrl,
        key: randomUUID(),
      }),
    );

    const [row] = await fetchAccountQuotas(adapter, options);

    expect(row?.account).toEqual({
      email: "a@example.test",
      identityStatus: "unverified",
    });
  });

  it("reports a Claude 401 as sign-out and a 403 as unavailable", async () => {
    const fake = await fakeServer(
      [
        { auth_index: "rejected", provider: "claude" },
        { auth_index: "forbidden", provider: "claude" },
      ],
      (call) => ({
        status_code: call.auth_index === "rejected" ? 401 : 403,
        body: { error: "denied" },
      }),
    );
    const adapter = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({
        baseUrl: fake.baseUrl,
        key: randomUUID(),
      }),
    );

    const rows = await fetchAccountQuotas(adapter, options);

    expect(
      rows.map((row) => [row.accountKey, row.state.status, row.windows]),
    ).toEqual([
      ["cpa-rejected", "auth_required", []],
      ["cpa-forbidden", "unavailable", []],
    ]);
  });

  it("keeps the provider visible when the management API rejects the key", async () => {
    const fake = await fakeServer([], healthyClaude, 401);
    const adapter = createCpaAdapter("codex", fallbackAdapter("codex"), () => ({
      baseUrl: fake.baseUrl,
      key: randomUUID(),
    }));

    const rows = await fetchAccountQuotas(adapter, options);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "codex",
      source: "cpa",
      accountKey: "cpa",
      state: { status: "error", error: "cpa_auth_files_unavailable" },
    });
  });

  it("still reads a cooled-down account and falls back to its own stale row", async () => {
    const message = "upstream said: refresh_token=leaked";
    let reachable = true;
    const fake = await fakeServer(
      [
        {
          auth_index: "cooling",
          provider: "claude",
          status: "error",
          unavailable: true,
          status_message: message,
        },
      ],
      (call) =>
        !reachable
          ? undefined
          : {
              status_code: 200,
              body: call.url.includes("/usage")
                ? {
                    five_hour: {
                      utilization: 100,
                      resets_at: "2030-01-01T01:00:00Z",
                    },
                  }
                : {},
            },
    );
    const adapter = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({
        baseUrl: fake.baseUrl,
        key: randomUUID(),
      }),
    );

    const quota = await fetchAccountQuotas(adapter, options);
    const auth = await inspectAccountAuth(adapter, options);
    writeCachedProviders(quota);
    reachable = false;
    const [stale] = await fetchAccountQuotas(adapter, options);

    expect(quota[0]).toMatchObject({
      accountKey: "cpa-cooling",
      source: "cpa",
      state: { status: "fresh" },
    });
    expect(
      quota[0]?.windows.map((window) => [window.id, window.percentRemaining]),
    ).toEqual([["five_hour", 0]]);
    expect(auth[0]?.sources).toEqual([{ source: "cpa", status: "available" }]);
    expect(stale).toMatchObject({
      accountKey: "cpa-cooling",
      source: "cache",
      state: { status: "stale", error: "cpa_request_failed" },
    });
    expect(stale?.windows.map((window) => window.id)).toEqual(["five_hour"]);
    expect(JSON.stringify([quota, auth, stale])).not.toContain(message);
  });

  it("reports a disabled CPA account with a fixed code in quota and auth", async () => {
    const fake = await fakeServer([
      { auth_index: "off", provider: "claude", disabled: true },
    ]);
    const adapter = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({
        baseUrl: fake.baseUrl,
        key: randomUUID(),
      }),
    );

    const quota = await fetchAccountQuotas(adapter, options);
    const auth = await inspectAccountAuth(adapter, options);

    expect(quota[0]?.state).toMatchObject({
      status: "error",
      error: "cpa_account_disabled",
    });
    expect(auth[0]?.sources).toEqual([
      { source: "cpa", status: "error", error: "cpa_account_disabled" },
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps native discovery when CPA is not configured", async () => {
    const rows = await fetchAccountQuotas(
      createCpaAdapter("claude", fallbackAdapter("claude"), () => undefined),
      options,
    );

    expect(rows).toMatchObject([
      { source: "oauth", state: { error: "native_read" } },
    ]);
  });

  it("reads the env file under XDG_CONFIG_HOME and keys fresh reuse on it", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-axi-cpa-"));
    roots.push(root);
    const environment = { XDG_CONFIG_HOME: root };
    const file = cpaEnvFilePath(environment);
    expect(file).toBe(join(root, "cpa-management.env"));

    const absentContext = reuseContextId(environment);
    expect(readCpaConfig(environment)).toBeUndefined();

    writeFileSync(
      file,
      "CPA_BASE_URL='http://127.0.0.1:8317/'\nCPA_MANAGEMENT_KEY=file-key\n",
      { mode: 0o600 },
    );
    expect(readCpaConfig(environment)).toEqual({
      baseUrl: "http://127.0.0.1:8317",
      key: "file-key",
    });
    const presentContext = reuseContextId(environment);
    expect(presentContext).not.toBe(absentContext);
    expect(presentContext).not.toContain("file-key");

    writeFileSync(file, "CPA_BASE_URL=http://127.0.0.1:9000\n");
    expect(reuseContextId(environment)).not.toBe(presentContext);
    expect(
      readCpaConfig({ ...environment, CPA_MANAGEMENT_KEY: "env-key" }),
    ).toEqual({ baseUrl: "http://127.0.0.1:9000", key: "env-key" });
  });

  it("hands a Codex account over to the second usage endpoint after a 401", async () => {
    const fake = await fakeServer(
      [
        { auth_index: "codex-1", provider: "codex", email: "c@example.test" },
        { auth_index: "codex-2", provider: "codex" },
      ],
      (call) =>
        call.auth_index === "codex-1" && call.url.endsWith("/codex/usage")
          ? {
              status_code: 200,
              body: {
                plan_type: "plus",
                account_id: "acct-1",
                rate_limit: { primary_window: { used_percent: 20 } },
              },
            }
          : { status_code: 401, body: {} },
    );
    const adapter = createCpaAdapter("codex", fallbackAdapter("codex"), () => ({
      baseUrl: fake.baseUrl,
      key: randomUUID(),
    }));

    const rows = await fetchAccountQuotas(adapter, options);

    expect(
      rows.map((row) => [row.accountKey, row.state.status, row.plan]),
    ).toEqual([
      ["cpa-codex-1", "fresh", "plus"],
      ["cpa-codex-2", "auth_required", undefined],
    ]);
    expect(rows[0]?.windows[0]).toMatchObject({
      id: "five_hour",
      percentRemaining: 80,
    });
    expect(
      fake.calls
        .filter((call) => call.auth_index === "codex-1")
        .map((call) => new URL(call.url).pathname),
    ).toEqual(["/backend-api/wham/usage", "/backend-api/codex/usage"]);
  });

  it("keeps a Codex account's snapshot when one endpoint fails and the other rejects", async () => {
    let mode: "healthy" | "mixed" = "healthy";
    const fake = await fakeServer(
      [{ auth_index: "codex-1", provider: "codex" }],
      (call) => {
        if (mode === "healthy")
          return {
            status_code: 200,
            body: {
              plan_type: "plus",
              rate_limit: { primary_window: { used_percent: 20 } },
            },
          };
        return call.url.endsWith("/wham/usage")
          ? { status_code: 500, body: {} }
          : { status_code: 403, body: {} };
      },
    );
    const adapter = createCpaAdapter("codex", fallbackAdapter("codex"), () => ({
      baseUrl: fake.baseUrl,
      key: randomUUID(),
    }));
    writeCachedProviders(await fetchAccountQuotas(adapter, options));

    mode = "mixed";
    const [row] = await fetchAccountQuotas(adapter, options);

    expect(row).toMatchObject({
      accountKey: "cpa-codex-1",
      source: "cache",
      state: { status: "stale", error: "cpa_quota_unavailable" },
    });
    expect(readCachedProvider("codex", "cpa-codex-1")?.source).toBe("cpa");
  });

  it("keeps native discovery when CPA lists no auth file for the provider", async () => {
    const fake = await fakeServer([
      { auth_index: "claude-1", provider: "claude" },
    ]);
    const native: ProviderAdapter = {
      ...fallbackAdapter("codex"),
      discoverAccounts: async () =>
        ["codex-home", "pi"].map((accountKey) => ({
          accountKey,
          fetchQuota: async () => ({
            provider: "codex",
            source: "oauth",
            accountKey,
            windows: [],
            state: { status: "unavailable", stale: false },
          }),
          inspectAuth: async () => ({ provider: "codex", sources: [] }),
        })),
    };
    const adapter = createCpaAdapter("codex", native, () => ({
      baseUrl: fake.baseUrl,
      key: randomUUID(),
    }));

    const rows = await fetchAccountQuotas(adapter, options);

    expect(rows.map((row) => row.accountKey)).toEqual(["codex-home", "pi"]);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps a measured Claude reading when only the profile request fails", async () => {
    const fake = await fakeServer(
      [{ auth_index: "claude-1", provider: "claude", email: "a@example.test" }],
      (call) =>
        call.url.includes("/usage")
          ? { status_code: 200, body: CLAUDE_USAGE }
          : undefined,
    );
    const adapter = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({
        baseUrl: fake.baseUrl,
        key: randomUUID(),
      }),
    );

    const [row] = await fetchAccountQuotas(adapter, options);

    expect(row?.state.status).toBe("fresh");
    expect(row?.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(row?.account).toEqual({
      email: "a@example.test",
      identityStatus: "unverified",
    });
  });

  it("caches a CPA Claude row under its own account context, never the local login's", async () => {
    const fake = await fakeServer([
      { auth_index: "claude-1", provider: "claude" },
    ]);
    const adapter = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({
        baseUrl: fake.baseUrl,
        key: randomUUID(),
      }),
    );
    const rows = await fetchAccountQuotas(adapter, options);
    expect(rows[0]?.state.status).toBe("fresh");

    writeCachedProviders(rows);

    expect(readCachedProvider("claude", "cpa-claude-1")?.source).toBe("cpa");
    expect(
      readCachedClaudeProvider(claudeCredentialContextId()),
    ).toBeUndefined();
  });

  it("serves a CPA account's own stale snapshot only for that proxy account", async () => {
    let status = 200;
    const upstream: Upstream = (call) =>
      status === 200 ? healthyClaude(call) : { status_code: status, body: {} };
    const files = [{ auth_index: "claude-1", provider: "claude" }];
    const fake = await fakeServer(files, upstream);
    const other = await fakeServer(files, () => ({
      status_code: 429,
      body: {},
    }));
    const adapterFor = (baseUrl: string) =>
      createCpaAdapter("claude", fallbackAdapter("claude"), () => ({
        baseUrl,
        key: randomUUID(),
      }));
    writeCachedProviders(
      await fetchAccountQuotas(adapterFor(fake.baseUrl), options),
    );

    status = 429;
    const [stale] = await fetchAccountQuotas(adapterFor(fake.baseUrl), options);
    const [elsewhere] = await fetchAccountQuotas(
      adapterFor(other.baseUrl),
      options,
    );

    expect(stale).toMatchObject({
      accountKey: "cpa-claude-1",
      source: "cache",
      state: { status: "stale", error: "cpa_rate_limited" },
    });
    expect(stale?.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(elsewhere).toMatchObject({
      source: "cpa",
      windows: [],
      state: { status: "rate_limited" },
    });

    status = 401;
    const [rejected] = await fetchAccountQuotas(
      adapterFor(fake.baseUrl),
      options,
    );
    expect(rejected?.state.status).toBe("auth_required");
    expect(readCachedProvider("claude", "cpa-claude-1")).toBeUndefined();
  });

  it("reuses a CPA reading within --max-age without asking the proxy again", async () => {
    const fake = await fakeServer([
      { auth_index: "claude-1", provider: "claude" },
      { auth_index: "claude-2", provider: "claude" },
    ]);
    PROVIDERS.claude = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({ baseUrl: fake.baseUrl, key: randomUUID() }),
    );
    const read = async () =>
      (
        JSON.parse(
          await quotaCommand(
            ["--provider", "claude", "--json", "--max-age", "90s"],
            undefined,
          ),
        ) as QuotaAxiResponse
      ).providers;

    const first = await read();
    const calls = fake.calls.length;
    const second = await read();

    expect(first.map((row) => row.state.reused)).toEqual([
      undefined,
      undefined,
    ]);
    expect(second.map((row) => [row.accountKey, row.state.reused])).toEqual([
      ["cpa-claude-1", true],
      ["cpa-claude-2", true],
    ]);
    expect(fake.calls).toHaveLength(calls);
  });
  it("reuses each healthy CPA account within --max-age while a failed one stays failed", async () => {
    const fake = await fakeServer([
      { auth_index: "claude-1", provider: "claude" },
      { auth_index: "claude-off", provider: "claude", disabled: true },
    ]);
    PROVIDERS.claude = createCpaAdapter(
      "claude",
      fallbackAdapter("claude"),
      () => ({ baseUrl: fake.baseUrl, key: randomUUID() }),
    );
    const read = async () =>
      (
        JSON.parse(
          await quotaCommand(
            ["--provider", "claude", "--json", "--max-age", "90s"],
            undefined,
          ),
        ) as QuotaAxiResponse
      ).providers;

    const first = await read();
    const calls = fake.calls.length;
    const second = await read();

    expect(
      first.map((row) => [row.accountKey, row.state.status, row.state.reused]),
    ).toEqual([
      ["cpa-claude-1", "fresh", undefined],
      ["cpa-claude-off", "error", undefined],
    ]);
    expect(calls).toBeGreaterThan(0);
    expect(
      second.map((row) => [
        row.accountKey,
        row.state.status,
        row.state.reused,
        row.state.error,
      ]),
    ).toEqual([
      ["cpa-claude-1", "fresh", true, undefined],
      ["cpa-claude-off", "error", undefined, "cpa_account_disabled"],
    ]);
    expect(second[0]?.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(fake.calls).toHaveLength(calls);
  });
});
