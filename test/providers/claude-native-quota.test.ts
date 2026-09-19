import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchClaudeNativeQuota,
  parseClaudeNativeDebug,
  type ClaudeNativeQuotaDependencies,
} from "../../src/providers/claude-native-quota.js";

const NOW = Date.parse("2026-09-19T06:00:00.000Z");
const SECRET = "SYNTHETIC_SECRET_MUST_NOT_ESCAPE";

function responseLog(
  status: number,
  headers: Record<string, string> = {},
): string {
  return `[log_fixture] response start ${JSON.stringify({
    status,
    headers: { ...headers, authorization: `Bearer ${SECRET}` },
  })}\n`;
}

function validHeaders(): Record<string, string> {
  return {
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": String(NOW / 1000 + 3600),
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-reset": String(NOW / 1000 + 86400),
  };
}

describe("Claude native quota debug parsing", () => {
  it("returns only validated unified quota fields", () => {
    const result = parseClaudeNativeDebug(
      responseLog(200, validHeaders()),
      NOW,
    );

    expect(result).toEqual({
      kind: "success",
      refreshedAt: "2026-09-19T06:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 25,
          percentRemaining: 75,
          resetsAt: "2026-09-19T07:00:00.000Z",
          windowSeconds: 18_000,
        },
        {
          id: "seven_day",
          label: "week",
          kind: "weekly",
          percentUsed: 50,
          percentRemaining: 50,
          resetsAt: "2026-09-20T06:00:00.000Z",
          windowSeconds: 604_800,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    ["missing", responseLog(200)],
    [
      "malformed",
      responseLog(200, {
        ...validHeaders(),
        "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
        "anthropic-ratelimit-unified-7d-utilization": "2",
      }),
    ],
    ["unknown format", `response headers without an SDK log id ${SECRET}`],
  ])("reports %s output as unavailable", (_label, raw) => {
    const result = parseClaudeNativeDebug(raw, NOW);

    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_quota_unavailable",
      status: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    ["numeric seconds", "60", "2026-09-19T06:01:00.000Z"],
    ["HTTP-date", "Sat, 19 Sep 2026 06:05:00 GMT", "2026-09-19T06:05:00.000Z"],
  ])(
    "preserves a bounded %s Retry-After from a native 429",
    (_label, retryAfterHeader, retryAfter) => {
      const result = parseClaudeNativeDebug(
        responseLog(429, { "retry-after": retryAfterHeader }),
        NOW,
      );

      expect(result).toEqual({
        kind: "failure",
        error: "claude_native_rate_limited",
        status: "rate_limited",
        retryAfter,
      });
    },
  );

  it("retains validated unified windows the 429 itself carried", () => {
    const result = parseClaudeNativeDebug(
      responseLog(429, {
        ...validHeaders(),
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "retry-after": "60",
      }),
      NOW,
    );

    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_rate_limited",
      status: "rate_limited",
      retryAfter: "2026-09-19T06:01:00.000Z",
      windows: [
        expect.objectContaining({
          id: "five_hour",
          percentUsed: 100,
          percentRemaining: 0,
          resetsAt: "2026-09-19T07:00:00.000Z",
        }),
        expect.objectContaining({ id: "seven_day", percentUsed: 50 }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("drops malformed 429 window headers without dropping the rate limit", () => {
    const result = parseClaudeNativeDebug(
      responseLog(429, {
        "anthropic-ratelimit-unified-5h-utilization": "1.5",
        "anthropic-ratelimit-unified-5h-reset": "not-a-number",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "retry-after": "60",
      }),
      NOW,
    );

    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_rate_limited",
      status: "rate_limited",
      retryAfter: "2026-09-19T06:01:00.000Z",
    });
  });

  it.each([
    ["out-of-bound seconds", "604801"],
    ["past HTTP-date", "Fri, 18 Sep 2026 06:00:00 GMT"],
  ])("drops an %s Retry-After but keeps the rate limit", (_label, header) => {
    expect(
      parseClaudeNativeDebug(responseLog(429, { "retry-after": header }), NOW),
    ).toEqual({
      kind: "failure",
      error: "claude_native_rate_limited",
      status: "rate_limited",
    });
  });
});

describe("Claude native quota process contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses before spawning when a nonblank ANTHROPIC_API_KEY is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", SECRET);
    let looked = false;
    let spawned = false;
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => {
        looked = true;
        return "/synthetic/claude";
      },
      run: async () => {
        spawned = true;
        throw new Error("must not run");
      },
    });

    expect(looked).toBe(false);
    expect(spawned).toBe(false);
    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_api_key_present",
      status: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(process.env.ANTHROPIC_API_KEY).toBe(SECRET);
  });

  it.each(["", "   "])(
    "treats a blank ANTHROPIC_API_KEY %j as absent",
    async (value) => {
      vi.stubEnv("ANTHROPIC_API_KEY", value);
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout: "OK\n",
          stderr: responseLog(200, validHeaders()),
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimited: false,
        }),
      });

      expect(result.kind).toBe("success");
      expect(process.env.ANTHROPIC_API_KEY).toBe(value);
    },
  );

  it.each([
    [
      "timed out",
      {
        timedOut: true,
        outputLimited: false,
        exitCode: null,
        signal: "SIGTERM" as const,
      },
    ],
    [
      "hit the output limit",
      {
        timedOut: false,
        outputLimited: true,
        exitCode: null,
        signal: "SIGTERM" as const,
      },
    ],
  ])(
    "keeps an observed 429 with Retry-After when the child later %s",
    async (_label, outcome) => {
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout: "",
          stderr: responseLog(429, {
            ...validHeaders(),
            "anthropic-ratelimit-unified-5h-utilization": "1",
            "retry-after": "45",
          }),
          ...outcome,
        }),
      });

      expect(result).toEqual({
        kind: "failure",
        error: "claude_native_rate_limited",
        status: "rate_limited",
        retryAfter: "2026-09-19T06:00:45.000Z",
        windows: [
          expect.objectContaining({ id: "five_hour", percentUsed: 100 }),
          expect.objectContaining({ id: "seven_day", percentUsed: 50 }),
        ],
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it("still reports a timeout when the truncated output holds no rate-limit observation", async () => {
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => "/synthetic/claude",
      now: () => NOW,
      run: async () => ({
        stdout: "",
        stderr: `[log_fixture] response start {"status":429,"hea${SECRET}`,
        exitCode: null,
        signal: "SIGTERM" as const,
        timedOut: true,
        outputLimited: false,
      }),
    });

    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_rate_limited",
      status: "rate_limited",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("reports a timeout when no response was observed at all", async () => {
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => "/synthetic/claude",
      now: () => NOW,
      run: async () => ({
        stdout: "",
        stderr: `request start ${SECRET}`,
        exitCode: null,
        signal: "SIGTERM" as const,
        timedOut: true,
        outputLimited: false,
      }),
    });

    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_timeout",
      status: "unavailable",
    });
  });

  it("reports a scratch directory creation failure as a process failure", async () => {
    let spawned = false;
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => "/synthetic/claude",
      makeScratch: () => {
        throw new Error("EACCES: synthetic tmpdir failure");
      },
      run: async () => {
        spawned = true;
        throw new Error("must not run");
      },
    });

    expect(spawned).toBe(false);
    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_process_failed",
      status: "unavailable",
    });
  });

  it("uses an empty scratch directory and the disclosed bounded command", async () => {
    let cwd = "";
    let args: readonly string[] = [];
    let env: NodeJS.ProcessEnv = {};
    const dependencies: ClaudeNativeQuotaDependencies = {
      findClaude: async () => "/synthetic/claude",
      now: () => NOW,
      run: async (_command, receivedArgs, options) => {
        cwd = options.cwd;
        args = receivedArgs;
        env = options.env;
        expect(existsSync(cwd)).toBe(true);
        return {
          stdout: "OK\n",
          stderr: responseLog(200, validHeaders()),
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimited: false,
        };
      },
    };

    const result = await fetchClaudeNativeQuota(dependencies);

    expect(result.kind).toBe("success");
    expect(existsSync(cwd)).toBe(false);
    expect(args).toEqual(
      expect.arrayContaining([
        "--print",
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--no-chrome",
      ]),
    );
    expect(args.at(-1)).toBe("Reply with exactly OK and nothing else.");
    expect(env).toMatchObject({
      ANTHROPIC_LOG: "debug",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  it.each(["OK.\n", "Ok\n", "", "Sure, OK!\n"])(
    "keeps a validated reading regardless of the model reply %j",
    async (stdout) => {
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout,
          stderr: responseLog(200, validHeaders()),
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimited: false,
        }),
      });

      expect(result.kind).toBe("success");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it.each([
    [
      "timeout",
      {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM" as const,
        timedOut: true,
        outputLimited: false,
      },
      "claude_native_timeout",
    ],
    [
      "output limit",
      {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM" as const,
        timedOut: false,
        outputLimited: true,
      },
      "claude_native_output_limit",
    ],
    [
      "process failure",
      {
        stdout: "",
        stderr: "",
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputLimited: false,
      },
      "claude_native_process_failed",
    ],
  ])("reports a %s without raw process output", async (_label, run, error) => {
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => "/synthetic/claude",
      run: async () => run,
    });

    expect(result).toEqual({ kind: "failure", error, status: "unavailable" });
  });

  it("reports missing Claude as incompatible without spawning", async () => {
    let spawned = false;
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => undefined,
      run: async () => {
        spawned = true;
        throw new Error("must not run");
      },
    });

    expect(spawned).toBe(false);
    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_incompatible",
      status: "unavailable",
    });
  });
});
