import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cpaEnvFilePath, reuseContextId } from "../src/lib/reuse-context.js";
import {
  fetchAccountQuotas,
  inspectAccountAuth,
} from "../src/providers/accounts.js";
import { createCpaAdapter, readCpaConfig } from "../src/providers/cpa.js";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderOptions,
} from "../src/types.js";

const options: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};
const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
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
type Upstream = (call: UpstreamCall) => { status_code: number; body: unknown };

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
        const { status_code, body: payload } = upstream(parsed);
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

  it("reports a CPA account status with a fixed code in quota and auth", async () => {
    const message = "upstream said: refresh_token=leaked";
    const fake = await fakeServer([
      {
        auth_index: "broken",
        provider: "claude",
        status: "error",
        status_message: message,
      },
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
      error: "cpa_account_status_error",
    });
    expect(auth[0]?.sources).toEqual([
      { source: "cpa", status: "error", error: "cpa_account_status_error" },
    ]);
    expect(JSON.stringify([quota, auth])).not.toContain(message);
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
});
