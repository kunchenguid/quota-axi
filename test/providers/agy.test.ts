import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import {
  fetchQuotaWithRuntime,
  inspectAuthWithRuntime,
  normalizeAgyQuotaSummary,
  normalizeAgyUserStatus,
  portsFromLsof,
  processInfosFromPs,
  requestLoopbackJson,
  type AgyConnectionEndpoint,
  type AgyProbeRuntime,
} from "../../src/providers/agy.js";
import type { ProviderQuota } from "../../src/types.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;
const servers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
  useTempCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Antigravity quota parsing", () => {
  it("normalizes quota summary groups into session and weekly windows", () => {
    const result = normalizeAgyQuotaSummary(fixture("quota-summary.json"));

    expect(result?.windows).toMatchObject([
      {
        id: "gemini_5h",
        label: "Gemini 5-hour",
        kind: "session",
        percentUsed: 9,
        percentRemaining: 91,
        resetsAt: "2026-06-15T11:39:34.000Z",
      },
      {
        id: "gemini_weekly",
        label: "Gemini weekly",
        kind: "weekly",
        percentUsed: 18,
        percentRemaining: 82,
        resetsAt: "2026-06-19T08:45:39.000Z",
      },
      {
        id: "claude_gpt_5h",
        label: "Claude/GPT 5-hour",
        kind: "session",
        percentUsed: 27,
        percentRemaining: 73,
        resetsAt: "2026-06-15T12:52:10.000Z",
      },
      {
        id: "claude_gpt_weekly",
        label: "Claude/GPT weekly",
        kind: "weekly",
        percentUsed: 36,
        percentRemaining: 64,
        resetsAt: "2026-06-20T00:39:54.000Z",
      },
    ]);
    expect(result?.windows.every((window) => !window.windowSeconds)).toBe(true);
  });

  it("normalizes oneof remaining values", () => {
    const result = normalizeAgyQuotaSummary({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit",
              remaining: { case: "remainingFraction", value: 0.5 },
            },
          ],
        },
      ],
    });

    expect(result?.windows[0]).toMatchObject({
      id: "gemini_weekly",
      percentUsed: 50,
      percentRemaining: 50,
    });
    expect(result?.windows[0]?.windowSeconds).toBeUndefined();
  });

  it("falls back to model windows from user status payloads", () => {
    const result = normalizeAgyUserStatus(fixture("user-status.json"));

    expect(result?.plan).toBe("Google AI Pro");
    expect(result?.account?.email).toBe("person@example.invalid");
    expect(result?.windows).toMatchObject([
      {
        id: "model:model_fixture_gemini_flash",
        label: "Gemini 3.5 Flash (Medium)",
        kind: "model",
        percentRemaining: 100,
      },
      {
        id: "model:model_fixture_claude_sonnet",
        label: "Claude Sonnet Fixture",
        kind: "model",
        percentRemaining: 50,
      },
    ]);
  });

  it("parses Antigravity processes and listening ports without matching prompt text", () => {
    const processes = processInfosFromPs(`
      101 /Users/test/.local/bin/agy
      102 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token token --extension_server_port 64123
      103 /usr/bin/node /opt/antigravity-cli/mcp-server.cjs --port 64124
      104 codex --prompt "antigravity-cli mcp-server.cjs language_server"
      105 /usr/bin/node /opt/runner.cjs --prompt "/opt/antigravity-cli/mcp-server.cjs"
      106 /usr/bin/codex --prompt "/Applications/Antigravity.app/Contents/bin/language_server --csrf_token fake"
    `);

    expect(processes).toMatchObject([
      { pid: 101, source: "agy" },
      {
        pid: 102,
        source: "app",
        csrfToken: "token",
        extensionPort: 64123,
      },
      { pid: 103, source: "agy" },
    ]);
    expect(
      portsFromLsof(`
COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
agy 101 test 8u IPv4 0x1 0t0 TCP 127.0.0.1:64440 (LISTEN)
agy 101 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64441 (LISTEN)
`),
    ).toEqual([64440, 64441]);
  });
});

describe("Antigravity provider", () => {
  it("fetches quota from an already-running loopback endpoint and merges identity", async () => {
    const runtime = runtimeWith({
      ps: "123 /Users/test/.local/bin/agy\n",
      lsof: lsofFor(123, 64440),
      responses: {
        "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
          fixture("quota-summary.json"),
        "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
          fixture("user-status.json"),
      },
    });

    const result = await fetchQuotaWithRuntime(runtime);

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("cli-rpc");
    expect(result.plan).toBe("Google AI Pro");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(result.windows.map((window) => window.id)).toEqual([
      "gemini_5h",
      "gemini_weekly",
      "claude_gpt_5h",
      "claude_gpt_weekly",
    ]);
  });

  it("probes app language-server endpoints with CSRF before quota requests", async () => {
    const calls: Array<{ endpoint: AgyConnectionEndpoint; path: string }> = [];
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token token --extension_server_port 64123 --extension_server_csrf_token extension-token\n",
        lsof: lsofFor(123, 64440),
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUnleashData":
            {},
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            fixture("quota-summary.json"),
        },
        onRequest(endpoint, path) {
          calls.push({ endpoint, path });
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(calls[0]?.path).toBe(
      "/exa.language_server_pb.LanguageServerService/GetUnleashData",
    );
    expect(calls[0]?.endpoint).toMatchObject({
      csrfToken: "token",
      requiresCsrfToken: true,
      requiresUnleashProbe: true,
    });
    expect(calls.every((call) => call.endpoint.port !== 64123)).toBe(true);
  });

  it("uses an extension port only when the app process owns its listener", async () => {
    const calls: AgyConnectionEndpoint[] = [];
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token main-token --extension_server_port 64123 --extension_server_csrf_token extension-token\n",
        lsof: `${lsofFor(123, 64440)}agy 123 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64123 (LISTEN)\n`,
        requestJson: async (endpoint, path) => {
          calls.push(endpoint);
          if (
            endpoint.port === 64123 &&
            endpoint.csrfToken === "extension-token"
          ) {
            if (path.endsWith("GetUnleashData")) return {};
            if (path.endsWith("RetrieveUserQuotaSummary"))
              return fixture("quota-summary.json");
          }
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(calls).toContainEqual(
      expect.objectContaining({
        port: 64123,
        csrfToken: "extension-token",
      }),
    );
  });

  it("reports unavailable without trying HTTP when Antigravity is not running", async () => {
    const requestJson = vi.fn();
    const result = await fetchQuotaWithRuntime(
      runtimeWith({ ps: "", lsof: "", requestJson }),
    );

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("Antigravity/agy is not running");
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("reports unavailable when discovered loopback endpoints are absent", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, 64440),
        requestJson: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:64440");
        },
      }),
    );

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("connect ECONNREFUSED 127.0.0.1:64440");
  });

  it("preserves sanitized process and port discovery failures", async () => {
    const processResult = await fetchQuotaWithRuntime(
      runtimeWith({ psError: new Error("ps failed at /Users/private") }),
    );
    const portResult = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsofError: new Error("lsof denied for private-host"),
      }),
    );

    expect(processResult.state).toMatchObject({
      status: "error",
      error: "Antigravity process discovery failed",
    });
    expect(portResult.state).toMatchObject({
      status: "error",
      error: "Antigravity port discovery failed",
    });
  });

  it("preserves sanitized discovery failures during auth inspection", async () => {
    const processResult = await inspectAuthWithRuntime(
      runtimeWith({ psError: new Error("ps failed at /Users/private") }),
    );
    const portResult = await inspectAuthWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsofError: new Error("lsof denied for private-host"),
      }),
    );

    expect(processResult.sources).toEqual([
      {
        source: "loopback",
        status: "error",
        error: "Antigravity process discovery failed",
      },
    ]);
    expect(portResult.sources).toEqual([
      {
        source: "loopback",
        status: "error",
        error: "Antigravity port discovery failed",
      },
    ]);
  });

  it("continues discovery when another verified process has listening ports", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n124 /Users/test/.local/bin/agy\n",
        lsofByPid: {
          123: new Error("permission denied"),
          124: lsofFor(124, 64441),
        },
        responses: {
          "https:64441:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            fixture("quota-summary.json"),
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
  });

  it("falls back to model quotas when quota summary has no usable buckets", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, 64440),
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            fixture("user-status.json"),
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(result.windows.map((window) => window.id)).toEqual([
      "model:model_fixture_gemini_flash",
      "model:model_fixture_claude_sonnet",
    ]);
  });

  it("continues past a malformed endpoint to a later valid port", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: `${lsofFor(123, 64440)}agy 123 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64441 (LISTEN)\n`,
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs":
            { response: { groups: [] } },
          "https:64441:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            fixture("quota-summary.json"),
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(result.windows[0]?.id).toBe("gemini_5h");
  });

  it("bounds probing across all discovered endpoints", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const resultPromise = fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: `${lsofFor(123, 64440)}agy 123 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64441 (LISTEN)\n`,
        requestJson: async (endpoint, path) => {
          calls.push(`${endpoint.scheme}:${endpoint.port}:${path}`);
          return new Promise<never>(() => undefined);
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("Antigravity probe timed out");
    expect(calls).toHaveLength(4);
    vi.useRealTimers();
  });

  it("reports malformed loopback responses as errors", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, 64440),
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs":
            { response: { groups: [] } },
          "http:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "http:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            { response: { groups: [] } },
          "http:64440:/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs":
            { response: { groups: [] } },
        },
      }),
    );

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("Antigravity quota summary malformed");
  });

  it("uses stale cache when the live loopback source is unavailable", async () => {
    writeCachedProviders([cachedAgyQuota()]);

    const result = await fetchQuotaWithRuntime(runtimeWith({ ps: "" }));

    expect(result.state.status).toBe("stale");
    expect(result.source).toBe("cache");
    expect(result.windows[0]).toMatchObject({
      id: "gemini_5h",
      percentRemaining: 88,
    });
  });

  it("preserves authentication failures and retires stale cache", async () => {
    writeCachedProviders([cachedAgyQuota()]);
    const port = await startServer((_response) => {
      _response.writeHead(401, { "content-type": "application/json" });
      _response.end(JSON.stringify({ error: "secret-account@example.test" }));
    });

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, port),
        requestJson: requestLoopbackJson,
      }),
    );

    expect(result.state).toMatchObject({
      status: "auth_required",
      error: "Antigravity sign-in required",
    });
    expect(JSON.stringify(result)).not.toContain("secret-account");
    expect(readCachedProvider("agy")).toBeUndefined();
  });

  it("preserves rate limits over protocol failures", async () => {
    const port = await startServer((response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "private diagnostic" }));
    });

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, port),
        requestJson: requestLoopbackJson,
      }),
    );

    expect(result.state).toMatchObject({
      status: "rate_limited",
      error: "Antigravity quota endpoint rate limited",
    });
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });

  it("terminates trickling and oversized loopback responses", async () => {
    const tricklePort = await startServer((response) => {
      const interval = setInterval(() => response.write(" "), 5);
      response.on("close", () => clearInterval(interval));
    });
    const trickleRequest = requestLoopbackJson(
      endpointAt(tricklePort),
      "/quota",
      50,
    );

    await expect(trickleRequest).rejects.toThrow(
      "Antigravity loopback timed out",
    );

    const oversizedPort = await startServer((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`"${"x".repeat(1024 * 1024)}"`);
    });

    await expect(
      requestLoopbackJson(endpointAt(oversizedPort), "/quota", 1_000),
    ).rejects.toThrow("Antigravity loopback response too large");
  });

  it("does not launch agy or any provider process", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runtime = runtimeWith({
      ps: "123 /Users/test/.local/bin/agy\n",
      lsof: lsofFor(123, 64440),
      responses: {
        "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
          fixture("quota-summary.json"),
      },
      onExec(command, args) {
        commands.push({ command, args });
      },
    });

    const result = await fetchQuotaWithRuntime(runtime);

    expect(result.state.status).toBe("fresh");
    expect(commands).toEqual([
      {
        command: "ps",
        args: ["-x", "-u", String(process.geteuid()), "-o", "pid=,command="],
      },
      {
        command: "lsof",
        args: ["-nP", "-a", "-p", "123", "-iTCP", "-sTCP:LISTEN"],
      },
    ]);
    expect(commands.map((call) => call.command)).not.toContain("agy");
  });
});

function runtimeWith(options: {
  ps?: string;
  lsof?: string;
  psError?: Error;
  lsofError?: Error;
  lsofByPid?: Record<number, string | Error>;
  requestJson?: AgyProbeRuntime["requestJson"];
  responses?: Record<string, unknown>;
  onExec?: (command: string, args: string[]) => void;
  onRequest?: (endpoint: AgyConnectionEndpoint, path: string) => void;
}): AgyProbeRuntime {
  return {
    async execFileText(command, args) {
      options.onExec?.(command, args);
      if (command === "ps") {
        if (options.psError) throw options.psError;
        return options.ps ?? "";
      }
      if (command === "lsof") {
        if (options.lsofError) throw options.lsofError;
        const pid = Number(args[args.indexOf("-p") + 1]);
        const output = options.lsofByPid?.[pid];
        if (output instanceof Error) throw output;
        return output ?? options.lsof ?? "";
      }
      throw new Error(`unexpected command: ${command}`);
    },
    async requestJson(
      endpoint: AgyConnectionEndpoint,
      path: string,
      timeoutMs: number,
    ) {
      options.onRequest?.(endpoint, path);
      if (options.requestJson)
        return options.requestJson(endpoint, path, timeoutMs);
      const key = `${endpoint.scheme}:${endpoint.port}:${path}`;
      if (options.responses && key in options.responses)
        return options.responses[key];
      throw new Error(`unexpected request: ${key}`);
    },
  };
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join("test", "fixtures", "agy", name), "utf8"),
  ) as unknown;
}

function lsofFor(pid: number, port: number): string {
  return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
agy ${pid} test 8u IPv4 0x1 0t0 TCP 127.0.0.1:${port} (LISTEN)
`;
}

async function startServer(
  handler: (response: ServerResponse) => void,
): Promise<number> {
  const server = createServer((_request, response) => handler(response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function endpointAt(port: number): AgyConnectionEndpoint {
  return {
    scheme: "http",
    port,
    source: "agy",
    pid: process.pid,
    requiresCsrfToken: false,
    requiresUnleashProbe: false,
  };
}

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-agy-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

function cachedAgyQuota(): ProviderQuota {
  return {
    provider: "agy",
    label: "Antigravity",
    source: "cli-rpc",
    windows: [
      {
        id: "gemini_5h",
        label: "Gemini 5-hour",
        kind: "session",
        percentUsed: 12,
        percentRemaining: 88,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-06-15T11:39:34.000Z",
      sourcesTried: ["loopback"],
    },
  };
}
