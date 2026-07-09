import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchQuotaWithRuntime,
  normalizeAgyQuotaSummary,
  normalizeAgyUserStatus,
  portsFromLsof,
  processInfosFromPs,
  type AgyConnectionEndpoint,
  type AgyProbeRuntime,
} from "../../src/providers/agy.js";
afterEach(() => {
  vi.restoreAllMocks();
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
        windowSeconds: 18000,
      },
      {
        id: "gemini_weekly",
        label: "Gemini weekly",
        kind: "weekly",
        percentUsed: 18,
        percentRemaining: 82,
        resetsAt: "2026-06-19T08:45:39.000Z",
        windowSeconds: 604800,
      },
      {
        id: "claude_gpt_5h",
        label: "Claude/GPT 5-hour",
        kind: "session",
        percentUsed: 27,
        percentRemaining: 73,
        resetsAt: "2026-06-15T12:52:10.000Z",
        windowSeconds: 18000,
      },
      {
        id: "claude_gpt_weekly",
        label: "Claude/GPT weekly",
        kind: "weekly",
        percentUsed: 36,
        percentRemaining: 64,
        resetsAt: "2026-06-20T00:39:54.000Z",
        windowSeconds: 604800,
      },
    ]);
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
      103 codex --prompt "run quota-axi --provider agy"
    `);

    expect(processes).toMatchObject([
      { pid: 101, source: "agy" },
      {
        pid: 102,
        source: "app",
        csrfToken: "token",
        extensionPort: 64123,
      },
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
        ps: "123 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token token\n",
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

  it("does not launch agy or any provider process", async () => {
    const commands: string[] = [];
    const runtime = runtimeWith({
      ps: "123 /Users/test/.local/bin/agy\n",
      lsof: lsofFor(123, 64440),
      responses: {
        "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
          fixture("quota-summary.json"),
      },
      onExec(command) {
        commands.push(command);
      },
    });

    const result = await fetchQuotaWithRuntime(runtime);

    expect(result.state.status).toBe("fresh");
    expect(commands).toEqual(["ps", "lsof"]);
    expect(commands).not.toContain("agy");
  });
});

function runtimeWith(options: {
  ps?: string;
  lsof?: string;
  requestJson?: AgyProbeRuntime["requestJson"];
  responses?: Record<string, unknown>;
  onExec?: (command: string) => void;
  onRequest?: (endpoint: AgyConnectionEndpoint, path: string) => void;
}): AgyProbeRuntime {
  return {
    async execFileText(command) {
      options.onExec?.(command);
      if (command === "ps") return options.ps ?? "";
      if (command === "lsof") return options.lsof ?? "";
      throw new Error(`unexpected command: ${command}`);
    },
    async requestJson(endpoint: AgyConnectionEndpoint, path: string) {
      options.onRequest?.(endpoint, path);
      if (options.requestJson) return options.requestJson(endpoint, path, 0);
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
