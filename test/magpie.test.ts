import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "../src/lib/http.js";
import { quotaCommand } from "../src/commands.js";
import { PROVIDERS } from "../src/providers/index.js";
import type { QuotaAxiResponse } from "../src/types.js";

const accounts = [
  "claude",
  "claude",
  "claude",
  "codex",
  "codex",
  "agy-cli",
].map((provider, index) => ({
  id: String(index),
  provider,
  pin: `${provider}/${index}`,
  user: `user${index}@example.invalid`,
  kind: "account",
  on: true,
}));
const bindings = accounts.map(({ provider, pin, id }) => ({
  provider: provider === "agy-cli" ? "agy" : provider,
  magpieAccountId: pin,
  accountKey: `magpie-${id}`,
}));
const now = new Date("2026-01-12T00:00:00Z");
const readAt = "2026-01-11T23:59:00.000Z";
const weekly = {
  name: "7 days",
  used: 25,
  remaining: 75,
  resetsAt: "2026-01-14T00:00:00Z",
};
const quotas = accounts.map(({ provider, user }) => ({
  provider,
  user,
  kind: "subscription",
  readAt,
  windows:
    provider === "agy-cli"
      ? [
          { ...weekly, name: "Gemini · 7 days", pool: "Gemini" },
          {
            ...weekly,
            name: "Gemini · 5 hours",
            pool: "Gemini",
            resetsAt: "2026-01-12T02:00:00Z",
          },
          {
            ...weekly,
            name: "Claude & GPT · 7 days",
            pool: "Claude & GPT",
            used: 100,
            remaining: 0,
          },
        ]
      : provider === "claude"
        ? [
            weekly,
            { ...weekly, name: "7 days · Fable", used: 90, remaining: 10 },
          ]
        : [
            weekly,
            {
              name: "Image generation",
              lane: "images",
              text: true,
              display: "Unknown",
              used: 0,
              remaining: 100,
            },
          ],
}));
let dir: string;
let config: { endpoint: string; tokenFile: string; accounts: typeof bindings };
function saveConfig() {
  writeFileSync(join(dir, "config"), JSON.stringify(config));
}
function gateway(usage: unknown[] = quotas, inventory: unknown[] = accounts) {
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fixture-gateway-key",
    );
    const path = new URL(input).pathname;
    if (!["/v1/magpie/accounts", "/v1/magpie/quotas"].includes(path))
      throw Error("unexpected path");
    return Response.json({
      object: "list",
      data: path.endsWith("/accounts") ? inventory : usage,
    });
  });
  vi.spyOn(http, "providerFetch").mockImplementation((input, init, options) => {
    expect(options?.direct).toBe(true);
    return fetch(String(input), init ?? {});
  });
  return fetch;
}
async function read(providers = "claude,codex,agy", flags: string[] = []) {
  return JSON.parse(
    await quotaCommand(
      ["--provider", providers, "--json", ...flags],
      undefined,
    ),
  ) as QuotaAxiResponse;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  dir = mkdtempSync(join(tmpdir(), "quota-magpie-"));
  config = {
    endpoint: "http://127.0.0.1:3425/v1",
    tokenFile: join(dir, "key"),
    accounts: bindings,
  };
  writeFileSync(config.tokenFile, "fixture-gateway-key\n");
  saveConfig();
  vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", join(dir, "config"));
  vi.stubEnv("XDG_CACHE_HOME", dir);
  for (const id of ["claude", "codex", "agy"] as const) {
    vi.spyOn(PROVIDERS[id], "fetchQuota").mockRejectedValue(
      Error("unexpected native read"),
    );
    if (PROVIDERS[id].discoverAccounts)
      vi.spyOn(PROVIDERS[id], "discoverAccounts").mockRejectedValue(
        Error("unexpected native discovery"),
      );
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
describe("Magpie subscription quota", () => {
  it("joins six subscriptions by exact identity, preserves bounds and bypasses native caches", async () => {
    // Native multi-account selectors must not add lanes to managed families.
    vi.stubEnv("QUOTA_AXI_CODEX_HOMES", join(dir, "native-codex"));
    vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", join(dir, "native-claude"));
    vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", "1");
    const http = gateway([...quotas].reverse(), [...accounts].reverse());
    const report = await read(undefined, ["--max-age", "10m", "--full"]);
    expect(report.schemaVersion).toBe(6);
    expect(report.providers.map((r) => r.accountKey)).toEqual(
      bindings.map((a) => a.accountKey),
    );
    expect(
      report.providers.every(
        (r) => r.source === "magpie" && r.state.refreshedAt === readAt,
      ),
    ).toBe(true);
    const [claude, , , codex, , agy] = report.providers;
    expect(claude.quotaSemantics?.effectiveAvailability).toContainEqual(
      expect.objectContaining({
        scope: "model:fable",
        effectivePercentRemaining: 10,
      }),
    );
    expect(codex.windows.map((w) => w.id)).toEqual(["weekly"]);
    expect(agy.quotaSemantics?.effectiveAvailability).toEqual([
      expect.objectContaining({
        scope: "gemini",
        effectivePercentRemaining: 75,
        boundedBy: ["gemini_weekly", "gemini_5h"],
        selection: expect.objectContaining({ status: "known" }),
      }),
      expect.objectContaining({
        scope: "claude_gpt",
        effectivePercentRemaining: 0,
      }),
    ]);
    expect(http).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, "quota-axi"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("fixture-gateway-key");
    const compact = await read("agy");
    expect(compact.providers[0].state.refreshedAt).toBe(readAt);
  });
  it("rejects ambiguous joins, disabled accounts, and unreported subscriptions independently", async () => {
    const inventory = accounts.map((a, i) =>
      i === 1
        ? { ...a, user: accounts[0].user }
        : i === 2
          ? { ...a, on: false }
          : a,
    );
    gateway(
      quotas.filter((q) => q.user !== accounts[3].user),
      inventory,
    );
    const report = await read();
    expect(report.providers.map((r) => r.state.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "fresh",
      "fresh",
    ]);
  });
  it("keeps deferred, old and expired observations out of selection, and suppresses provider error text", async () => {
    gateway(
      quotas.map((q, i) =>
        i === 0
          ? { ...q, readDeferred: true }
          : i === 1
            ? { ...q, readAt: "2026-01-11T21:00:00Z" }
            : i === 2
              ? { ...q, error: "fixture-gateway-key" }
              : i === 3
                ? {
                    ...q,
                    windows: [{ ...weekly, resetsAt: "2026-01-11T21:00:00Z" }],
                  }
                : i === 4
                  ? { ...q, asOf: readAt, readError: "fixture-gateway-key" }
                  : q,
      ),
    );
    const report = await read(undefined, ["--full"]);
    for (const r of report.providers.slice(0, 5)) {
      expect(r.state.status).not.toBe("fresh");
      expect(
        r.quotaSemantics?.effectiveAvailability.some(
          (a) => a.selection?.status === "known",
        ),
      ).toBe(false);
    }
    expect(report.providers[3].windows).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("fixture-gateway-key");
  });
  it("keeps native reads for unconfigured providers and profile-only requests", async () => {
    const http = gateway();
    config.accounts = bindings.filter((binding) => binding.provider === "agy");
    saveConfig();
    const native = {
      provider: "claude",
      source: "oauth",
      windows: [],
      state: { status: "fresh", stale: false },
    } as const;
    vi.mocked(PROVIDERS.claude.discoverAccounts!).mockResolvedValue(undefined);
    vi.mocked(PROVIDERS.claude.fetchQuota).mockResolvedValue({
      ...native,
      windows: [],
    });
    expect(
      (await read("claude,agy", ["--full"])).providers.map((row) => row.source),
    ).toEqual(["oauth", "magpie"]);
    expect(http).toHaveBeenCalledTimes(2);
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", join(dir, "missing-config"));
    expect(
      (await read("claude", ["--profile-only", "--full"])).providers[0].source,
    ).toBe("oauth");
    expect(http).toHaveBeenCalledTimes(2);
    expect(PROVIDERS.claude.fetchQuota).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credentialMode: "profile-only",
        refreshCredentials: false,
      }),
    );
  });
  it("uses snapshot mode even if Magpie has an invalid config", async () => {
    const http = gateway();
    vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", join(dir, "missing-config"));
    const snapshot = join(dir, "snapshot");
    writeFileSync(
      snapshot,
      JSON.stringify({ schemaVersion: 3, providers: [] }),
    );
    vi.stubEnv("QUOTA_AXI_SNAPSHOT", snapshot);
    const report = await read("agy", ["--full"]);
    expect(report.providers[0].state.error).toBe("not_in_snapshot");
    expect(http).not.toHaveBeenCalled();
  });
  it("withholds a scope when a meter or its observation time is invalid", async () => {
    const badRows = [
      {
        ...quotas[0],
        windows: [weekly, { ...weekly, name: "Unrecognized limit" }],
      },
      { ...quotas[1], windows: [{ ...weekly, text: true }] },
      { ...quotas[2], readAt: undefined, lastServedAt: readAt },
      { ...quotas[3], windows: [{ ...weekly, remaining: 100 }] },
      { ...quotas[4], readAt: "2026-01-15T00:00:00Z" },
      {
        ...quotas[5],
        windows: [
          { ...weekly, name: "Gemini · 5 hours", pool: "Claude & GPT" },
        ],
      },
    ];
    gateway(badRows);
    const report = await read();
    expect(
      report.providers.every(
        (row) => row.state.status === "unavailable" && !row.windows.length,
      ),
    ).toBe(true);
  });
  it("returns per-account failures on rejected or oversized responses without reading native credentials", async () => {
    for (const [status, length, code] of [
      [403, 18, "magpie_http_403"],
      [200, 300_000, "response_too_large"],
    ] as const) {
      vi.spyOn(http, "providerFetch").mockImplementation(
        async () =>
          new Response("fixture-gateway-key", {
            status,
            headers: { "content-length": String(length) },
          }),
      );
      const report = await read("claude", ["--full"]);
      expect(report.providers.map((row) => row.state.error)).toEqual([
        code,
        code,
        code,
      ]);
      expect(JSON.stringify(report)).not.toContain("fixture-gateway-key");
    }
  });
  it("uses the user's explicit Magpie config file and honors an empty environment override", async () => {
    const http = gateway();
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", undefined);
    mkdirSync(join(dir, "quota-axi"), { recursive: true });
    writeFileSync(
      join(dir, "quota-axi", "magpie.json"),
      JSON.stringify(config),
    );
    expect((await read("agy", ["--full"])).providers[0].source).toBe("magpie");
    vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", "");
    vi.mocked(PROVIDERS.agy.fetchQuota).mockResolvedValue({
      provider: "agy",
      source: "cli",
      windows: [],
      state: { status: "fresh", stale: false },
    });
    expect((await read("agy", ["--full"])).providers[0].source).toBe("cli");
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("rejects a relative explicit config path without gateway requests", async () => {
    const http = gateway();
    vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", "config");
    await expect(read()).rejects.toThrow("configuration path must be absolute");
    expect(http).not.toHaveBeenCalled();
  });
  it("keeps native readings when XDG_CONFIG_HOME is relative and no Magpie config is set", async () => {
    const http = gateway();
    vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", undefined);
    vi.stubEnv("XDG_CONFIG_HOME", "relative-config");
    vi.mocked(PROVIDERS.agy.fetchQuota).mockResolvedValue({
      provider: "agy",
      source: "cli",
      windows: [],
      state: { status: "fresh", stale: false },
    });
    const report = await read("agy", ["--full"]);
    expect(report.providers.map((row) => row.source)).toEqual(["cli"]);
    expect(http).not.toHaveBeenCalled();
  });
  it("distinguishes token file failures without leaking file contents or making requests", async () => {
    const http = gateway();
    for (const [path, code] of [
      [join(dir, "missing"), "magpie_token_missing"],
      [dir, "magpie_token_unreadable"],
      [join(dir, "empty"), "magpie_token_invalid"],
      [join(dir, "oversized"), "magpie_token_invalid"],
    ]) {
      writeFileSync(join(dir, "empty"), "");
      writeFileSync(join(dir, "oversized"), "fixture-secret".repeat(1000));
      config.tokenFile = path;
      saveConfig();
      const report = await read("agy", ["--full"]);
      expect(report.providers[0].state.error).toBe(code);
      expect(JSON.stringify(report)).not.toContain("fixture-secret");
      expect(JSON.stringify(report)).not.toContain(dir);
    }
    expect(http).not.toHaveBeenCalled();
  });
  it("sends the gateway key directly to loopback when Node starts with an environment proxy", async () => {
    vi.useRealTimers();
    const received: string[] = [];
    const target = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer fixture-gateway-key") {
        response.writeHead(401).end();
        return;
      }
      const pathname = request.url;
      const data =
        pathname === "/v1/magpie/accounts"
          ? accounts
          : [
              {
                ...quotas[5],
                readAt: new Date().toISOString(),
                windows: [
                  {
                    ...weekly,
                    name: "Gemini · 7 days",
                    pool: "Gemini",
                    resetsAt: new Date(Date.now() + 86400000).toISOString(),
                  },
                ],
              },
            ];
      received.push(pathname ?? "");
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ object: "list", data }));
    });
    let proxyConnections = 0;
    const proxy = createServer((_request, response) =>
      response.writeHead(403).end(),
    );
    proxy.on("connection", () => proxyConnections++);
    proxy.on("connect", (_request, client) =>
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"),
    );
    async function start(server: Server) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("missing port");
      return "http://127.0.0.1:" + address.port;
    }
    try {
      config.endpoint = (await start(target)) + "/v1";
      const proxyUrl = await start(proxy);
      saveConfig();
      const result = await promisify(execFile)(
        process.execPath,
        ["dist/bin/quota-axi.js", "--provider", "agy", "--json"],
        {
          env: {
            HOME: dir,
            XDG_CACHE_HOME: dir,
            QUOTA_AXI_MAGPIE_CONFIG: join(dir, "config"),
            NODE_USE_ENV_PROXY: "1",
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            NO_PROXY: "",
          },
          timeout: 10000,
        },
      ).catch(() => undefined);
      expect(proxyConnections).toBe(0);
      expect(received.sort()).toEqual([
        "/v1/magpie/accounts",
        "/v1/magpie/quotas",
      ]);
      expect(JSON.parse(result!.stdout).providers[0].accountKey).toBe(
        "magpie-5",
      );
    } finally {
      for (const server of [target, proxy]) {
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
  it("reports disjoint Codex account keys when switching between gateway and native quotas", async () => {
    const requests = gateway();
    config.accounts = [bindings[3]];
    saveConfig();
    const managed = await read("codex", ["--max-age", "90s"]);
    expect(managed.providers.map((row) => row.accountKeys)).toEqual([
      ["magpie-3"],
    ]);
    vi.stubEnv("QUOTA_AXI_MAGPIE_CONFIG", "");
    vi.mocked(PROVIDERS.codex.discoverAccounts!).mockResolvedValue(undefined);
    vi.mocked(PROVIDERS.codex.fetchQuota).mockResolvedValue({
      provider: "codex",
      accountKeys: ["codex-home"],
      windows: [],
      state: { status: "fresh", stale: false },
    });
    const native = await read("codex", ["--max-age", "90s"]);
    expect(native.providers.map((row) => row.accountKeys)).toEqual([
      ["codex-home"],
    ]);
    expect(requests).toHaveBeenCalledTimes(2);
    expect(PROVIDERS.codex.fetchQuota).toHaveBeenCalledOnce();
  });
  it.each([
    "default",
    "codex-home",
    "openai-codex",
    "openai-codex-work",
    "magpie-",
  ])(
    "rejects the unscoped account key %s before reading a gateway or native account",
    async (accountKey) => {
      const requests = gateway();
      config.accounts = [{ ...bindings[3], accountKey }];
      saveConfig();
      await expect(read("codex", ["--max-age", "90s"])).rejects.toThrow(
        /accountKey/,
      );
      expect(requests).not.toHaveBeenCalled();
      expect(PROVIDERS.codex.fetchQuota).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate account keys across provider families", async () => {
    const http = gateway();
    config.accounts = [
      bindings[0],
      { ...bindings[3], accountKey: bindings[0].accountKey },
    ];
    saveConfig();
    await expect(read("claude,codex")).rejects.toThrow(
      /duplicate account binding/,
    );
    expect(http).not.toHaveBeenCalled();
  });
  it("rejects unsafe endpoints and duplicate bindings before sending credentials", async () => {
    const http = gateway();
    for (const endpoint of [
      "http://remote.example/v1",
      "https://user:pass@remote.example/v1",
      "file:///v1",
    ]) {
      config.endpoint = endpoint;
      saveConfig();
      await expect(read()).rejects.toThrow(/MAGPIE_CONFIG/);
    }
    config.endpoint = "http://127.0.0.1/v1";
    config.accounts = [...bindings, bindings[0]];
    saveConfig();
    await expect(read()).rejects.toThrow(/MAGPIE_CONFIG/);
    expect(http).not.toHaveBeenCalled();
  });
});
