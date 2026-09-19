import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it.each([200, 429])(
    "reads colored SDK status and quota headers from a %s response",
    (status) => {
      const headers = {
        ...validHeaders(),
        "retry-after": "60",
      };
      const raw = `[log_fixture] response start ${inspect(
        {
          status,
          headers: { ...headers, authorization: `Bearer ${SECRET}` },
        },
        { colors: true, depth: null },
      )}\n`;

      const result = parseClaudeNativeDebug(raw, NOW);

      expect(result).toEqual(
        parseClaudeNativeDebug(responseLog(status, headers), NOW),
      );
      expect(result).toMatchObject({
        windows: [
          expect.objectContaining({ id: "five_hour", percentUsed: 25 }),
          expect.objectContaining({ id: "seven_day", percentUsed: 50 }),
        ],
        ...(status === 429
          ? { status: "rate_limited", retryAfter: "2026-09-19T06:01:00.000Z" }
          : { kind: "success" }),
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

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

  it.each([200, 429])("withholds incomplete %s window pairs", (status) => {
    for (const slug of ["5h", "7d"]) {
      for (const invalid of ["malformed", undefined]) {
        const headers = validHeaders();
        const key = `anthropic-ratelimit-unified-${slug}-reset`;
        if (invalid === undefined) delete headers[key];
        else headers[key] = invalid;
        const result = parseClaudeNativeDebug(
          responseLog(status, headers),
          NOW,
        );
        expect(result).toEqual({
          kind: "failure",
          error:
            status === 429
              ? "claude_native_rate_limited"
              : "claude_native_quota_unavailable",
          status: status === 429 ? "rate_limited" : "unavailable",
        });
      }
    }
  });

  it("uses a later 429 instead of earlier successful headers", () => {
    const latest = responseLog(429, {
      ...validHeaders(),
      "anthropic-ratelimit-unified-7d-utilization": "1",
      "retry-after": "60",
    });
    expect(
      parseClaudeNativeDebug(responseLog(200, validHeaders()) + latest, NOW),
    ).toEqual(parseClaudeNativeDebug(latest, NOW));
  });

  it.each([200, 500])(
    "does not revive old headers after an incomplete %s response",
    (status) => {
      expect(
        parseClaudeNativeDebug(
          responseLog(200, validHeaders()) + responseLog(status),
          NOW,
        ),
      ).toEqual({
        kind: "failure",
        error: "claude_native_quota_unavailable",
        status: "unavailable",
      });
    },
  );

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
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["stdout", "stderr"] as const)(
    "accepts a complete validated observation from %s",
    async (stream) => {
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout:
            stream === "stdout"
              ? `${responseLog(200, validHeaders())}${SECRET}`
              : `model output ${SECRET}`,
          stderr:
            stream === "stderr"
              ? `${responseLog(200, validHeaders())}${SECRET}`
              : `application log ${SECRET}`,
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimited: false,
        }),
      });

      expect(result).toMatchObject({ kind: "success" });
      expect(result.kind === "success" && result.windows).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it.each([200, 429])(
    "rejects conflicting complete %s observations across streams",
    async (status) => {
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout: responseLog(status, validHeaders()),
          stderr: responseLog(status, {
            ...validHeaders(),
            "anthropic-ratelimit-unified-5h-utilization": "0.75",
          }),
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimited: false,
        }),
      });

      expect(result).toEqual({
        kind: "failure",
        error: "claude_native_quota_unavailable",
        status: "unavailable",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it.each([200, 429])(
    "accepts the same complete %s observation from both streams",
    async (status) => {
      const raw = responseLog(status, validHeaders());
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout: raw,
          stderr: raw,
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimited: false,
        }),
      });

      expect(result).toEqual(parseClaudeNativeDebug(raw, NOW));
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it("ignores an incomplete sibling stream", async () => {
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => "/synthetic/claude",
      now: () => NOW,
      run: async () => ({
        stdout: responseLog(200, validHeaders()),
        stderr: `[log_fixture] response start {"status":200,"secret":"${SECRET}"}`,
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimited: false,
      }),
    });

    expect(result).toMatchObject({ kind: "success" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    ["stdout", "timeout"],
    ["stderr", "timeout"],
    ["stdout", "output limit"],
    ["stderr", "output limit"],
  ])(
    "keeps a complete %s 429 over a truncated sibling and %s",
    async (stream, bound) => {
      const complete = responseLog(429, {
        ...validHeaders(),
        "retry-after": "45",
      });
      const truncated = `[log_fixture] response start {"status":429,"hea${SECRET}`;
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout: stream === "stdout" ? complete : truncated,
          stderr: stream === "stderr" ? complete : truncated,
          exitCode: null,
          signal: "SIGTERM",
          timedOut: bound === "timeout",
          outputLimited: bound === "output limit",
        }),
      });

      expect(result).toEqual({
        kind: "failure",
        error: "claude_native_rate_limited",
        status: "rate_limited",
        retryAfter: "2026-09-19T06:00:45.000Z",
        windows: [
          expect.objectContaining({ id: "five_hour", percentUsed: 25 }),
          expect.objectContaining({ id: "seven_day", percentUsed: 50 }),
        ],
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it.each([
    ["ANTHROPIC_API_KEY", "claude_native_api_key_present"],
    ["ANTHROPIC_AUTH_TOKEN", "claude_native_auth_token_present"],
  ])(
    "refuses before spawning when a nonblank %s is present",
    async (name, error) => {
      vi.stubEnv(name, SECRET);
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
        error,
        status: "unavailable",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(process.env[name]).toBe(SECRET);
    },
  );

  it.each([
    ["ANTHROPIC_API_KEY", ""],
    ["ANTHROPIC_API_KEY", "   "],
    ["ANTHROPIC_AUTH_TOKEN", ""],
    ["ANTHROPIC_AUTH_TOKEN", "   "],
  ])("treats a blank %s %j as absent", async (name, value) => {
    vi.stubEnv(name, value);
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
    expect(process.env[name]).toBe(value);
  });

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

  it.each([
    [
      "timeout",
      { timedOut: true, outputLimited: false },
      "claude_native_timeout",
    ],
    [
      "output limit",
      { timedOut: false, outputLimited: true },
      "claude_native_output_limit",
    ],
  ])(
    "keeps the %s when a truncated 429 carries no Retry-After or windows",
    async (_label, outcome, error) => {
      const result = await fetchClaudeNativeQuota({
        findClaude: async () => "/synthetic/claude",
        now: () => NOW,
        run: async () => ({
          stdout: "",
          stderr: `[log_fixture] response start {"status":429,"hea${SECRET}`,
          exitCode: null,
          signal: "SIGTERM" as const,
          ...outcome,
        }),
      });

      expect(result).toEqual({ kind: "failure", error, status: "unavailable" });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it("still reports a bare 429 as rate limited when no bound was hit", async () => {
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => "/synthetic/claude",
      now: () => NOW,
      run: async () => ({
        stdout: "",
        stderr: responseLog(429),
        exitCode: 1,
        signal: null,
        timedOut: false,
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

  it.each(["relative", "absolute"])(
    "launches the first Claude on a %s PATH from an empty scratch directory",
    async (pathKind) => {
      const directory = mkdtempSync(join(process.cwd(), ".native-path-"));
      const fallback = mkdtempSync(join(directory, "fallback-"));
      const scratch = mkdtempSync(join(directory, "scratch-"));
      const raw = responseLog(200, validHeaders());
      writeFileSync(
        join(directory, "claude"),
        `#!${process.execPath}
import { readdirSync, realpathSync } from "node:fs";
if (process.cwd() !== realpathSync(${JSON.stringify(scratch)})) process.exit(1);
if (readdirSync(process.cwd()).length !== 0) process.exit(2);
if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== ${JSON.stringify(SECRET)}) process.exit(3);
if (process.env.ANTHROPIC_BASE_URL !== "https://fixture.invalid") process.exit(4);
process.stdout.write(${JSON.stringify(raw)});
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(fallback, "claude"),
        `#!${process.execPath}\nprocess.exit(5);\n`,
        { mode: 0o700 },
      );
      vi.stubEnv(
        "PATH",
        [
          pathKind === "relative"
            ? `./${relative(process.cwd(), directory)}`
            : directory,
          fallback,
        ].join(delimiter),
      );
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", SECRET);
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://fixture.invalid");
      try {
        const result = await fetchClaudeNativeQuota({
          makeScratch: () => scratch,
          now: () => NOW,
        });

        expect(result).toEqual(parseClaudeNativeDebug(raw, NOW));
        expect(existsSync(scratch)).toBe(false);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("uses an empty scratch directory and the disclosed bounded command", async () => {
    vi.stubEnv("CLAUDE_CODE_MAX_RETRIES", "9");
    vi.stubEnv("CLAUDE_CODE_RETRY_WATCHDOG", "1");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", SECRET);
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://fixture.invalid");
    let cwd = "";
    let args: readonly string[] = [];
    let env: NodeJS.ProcessEnv = {};
    const dependencies: ClaudeNativeQuotaDependencies = {
      findClaude: async () => "/synthetic/claude",
      now: () => NOW,
      run: async (command, receivedArgs, options) => {
        expect(command).toBe("/synthetic/claude");
        cwd = options.cwd;
        args = receivedArgs;
        env = options.env;
        expect(readdirSync(cwd)).toEqual([]);
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
      CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_RETRY_WATCHDOG: "0",
      CLAUDE_CODE_OAUTH_TOKEN: SECRET,
      ANTHROPIC_BASE_URL: "https://fixture.invalid",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(process.env.CLAUDE_CODE_MAX_RETRIES).toBe("9");
    expect(process.env.CLAUDE_CODE_RETRY_WATCHDOG).toBe("1");
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

  it("cleans signal listeners when native process creation fails", async () => {
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    const result = await fetchClaudeNativeQuota({
      findClaude: async () => "/synthetic/missing-claude",
    });
    expect(result).toEqual({
      kind: "failure",
      error: "claude_native_process_failed",
      status: "unavailable",
    });
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
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

describe("Claude native subprocess cancellation", () => {
  it.each([
    ["SIGINT", false],
    ["SIGTERM", false],
    ["SIGINT", true],
    ["SIGTERM", true],
  ] as const)(
    "cleans the process group on %s with caller handler %s",
    async (signal, hasHandler) => {
      const directory = mkdtempSync(join(tmpdir(), "quota-axi-native-cancel-"));
      const ready = join(directory, "ready.json");
      const executable = join(directory, "native.cjs");
      writeFileSync(
        executable,
        `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => writeFileSync(process.env.FIXTURE_READY, JSON.stringify({ pid: process.pid, descendant: child.pid, cwd: process.cwd() })));
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      const moduleUrl = new URL(
        "../../src/providers/claude-native-quota.ts",
        import.meta.url,
      ).href;
      const runner = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
import { fetchClaudeNativeQuota } from ${JSON.stringify(moduleUrl)};
let calls = 0;
const handler = () => { calls++; };
if (${hasHandler}) process.on(${JSON.stringify(signal)}, handler);
const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const result = await fetchClaudeNativeQuota({ findClaude: async () => process.env.FIXTURE_EXECUTABLE });
process.send({ calls, before, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], result });
process.disconnect();
`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            FIXTURE_READY: ready,
            FIXTURE_EXECUTABLE: executable,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      const closed = once(runner, "close");
      const messages: unknown[] = [];
      runner.on("message", (message) => messages.push(message));
      let child: { pid: number; descendant: number; cwd: string } | undefined;
      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {
          timeout: 4000,
          interval: 20,
        });
        child = JSON.parse(readFileSync(ready, "utf8")) as typeof child;
        runner.kill(signal);
        const [code, exitSignal] = await closed;
        expect(hasHandler ? code : exitSignal).toBe(hasHandler ? 0 : signal);
        expect(messages).toEqual([
          {
            calls: hasHandler ? 1 : 0,
            before:
              signal === "SIGINT"
                ? [Number(hasHandler), 0]
                : [0, Number(hasHandler)],
            after:
              signal === "SIGINT"
                ? [Number(hasHandler), 0]
                : [0, Number(hasHandler)],
            result: {
              kind: "failure",
              error: "claude_native_process_failed",
              status: "unavailable",
            },
          },
        ]);
        expect(existsSync(child!.cwd)).toBe(false);
        await vi.waitFor(
          () => {
            expect(() => process.kill(child!.pid, 0)).toThrow();
            expect(() => process.kill(child!.descendant, 0)).toThrow();
          },
          { timeout: 2000, interval: 20 },
        );
      } finally {
        runner.kill("SIGKILL");
        if (child) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child = undefined;
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    10000,
  );
});
