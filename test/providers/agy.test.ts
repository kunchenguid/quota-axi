import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn as realSpawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGY_BINARY_ENV,
  fetchQuota,
  inspectAuth,
  normalizeAgyUsage,
  runAgyCommand,
} from "../../src/providers/agy.js";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import type { ProviderQuota } from "../../src/types.js";

const fixtureDir = join(import.meta.dirname, "..", "fixtures", "agy");
const originalAgyBinary = process.env[AGY_BINARY_ENV];
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalDbusSessionBus = process.env.DBUS_SESSION_BUS_ADDRESS;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tempRoot: string | undefined;

afterEach(() => {
  if (originalAgyBinary === undefined) delete process.env[AGY_BINARY_ENV];
  else process.env[AGY_BINARY_ENV] = originalAgyBinary;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalDbusSessionBus === undefined)
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
  else process.env.DBUS_SESSION_BUS_ADDRESS = originalDbusSessionBus;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
}

describe("Antigravity usage parsing", () => {
  it("normalizes groups and buckets while ignoring turn metadata", () => {
    const result = normalizeAgyUsage(fixture("usage-json.json"));

    expect(result?.windows).toMatchObject([
      {
        id: "gemini-weekly",
        label: "Gemini Models: Weekly Limit Remaining",
        kind: "weekly",
        percentRemaining: 99,
        percentUsed: 1,
        resetsAt: "2026-08-11T19:28:33.000Z",
        windowSeconds: 604_800,
      },
      {
        id: "gemini-5h",
        label: "Gemini Models: Five Hour Limit Remaining",
        kind: "session",
        percentRemaining: 100,
        percentUsed: 0,
        resetsAt: "2026-08-09T15:01:48.000Z",
        windowSeconds: 18_000,
      },
      {
        id: "3p-weekly",
        label: "Claude and GPT models: Weekly Limit Remaining",
        kind: "weekly",
        percentRemaining: 97,
        percentUsed: 3,
        resetsAt: "2026-08-12T04:39:05.000Z",
        windowSeconds: 604_800,
      },
      {
        id: "3p-5h",
        label: "Claude and GPT models: Five Hour Limit Remaining",
        kind: "session",
        percentRemaining: 100,
        percentUsed: 0,
        resetsAt: "2026-08-09T15:01:48.000Z",
        windowSeconds: 18_000,
      },
    ]);
    expect(result?.untrustedWindowIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("conversation_id");
    expect(JSON.stringify(result)).not.toContain("num_turns");
    expect(JSON.stringify(result)).not.toContain("tokens");
  });

  it("returns a fresh empty parse for a valid zero-group envelope", () => {
    expect(normalizeAgyUsage(fixture("usage-empty.json"))).toEqual({
      windows: [],
      untrustedWindowIds: [],
    });
  });

  it("fails closed for an incompatible groups envelope", () => {
    expect(normalizeAgyUsage(fixture("usage-malformed.json"))).toBeUndefined();
    expect(normalizeAgyUsage({ command: { data: {} } })).toBeUndefined();
    expect(normalizeAgyUsage("not-json")).toBeUndefined();
  });

  it("fails closed for non-success status and unrelated command envelopes", () => {
    const validData = {
      groups: [],
    };
    expect(
      normalizeAgyUsage({
        status: "ERROR",
        command: { name: "usage", data: validData },
      }),
    ).toBeUndefined();
    expect(
      normalizeAgyUsage({
        status: "SUCCESS",
        command: { name: "login", data: validData },
      }),
    ).toBeUndefined();
  });

  it("omits percentages for out-of-range fractions and marks fields untrusted", () => {
    const result = normalizeAgyUsage({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              id: "consumer",
              name: "Consumer",
              buckets: [
                {
                  id: "over",
                  name: "Over",
                  window: "5h",
                  remaining_fraction: 2,
                  reset_time: "not-a-date",
                },
                {
                  id: "missing",
                  name: "Missing",
                  window: "5h",
                },
              ],
            },
          ],
        },
      },
    });

    expect(result?.windows).toMatchObject([
      { id: "consumer/over" },
      { id: "consumer/missing", kind: "session" },
    ]);
    expect(result?.windows[0]?.percentRemaining).toBeUndefined();
    expect(result?.windows[0]?.percentUsed).toBeUndefined();
    expect(result?.windows[0]?.resetsAt).toBeUndefined();
    expect(result?.untrustedWindowIds).toEqual([
      "consumer/over",
      "consumer/missing",
    ]);
  });

  it("suffixes duplicate bucket identities instead of overwriting them", () => {
    const result = normalizeAgyUsage({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              id: "consumer",
              name: "Consumer",
              buckets: [
                {
                  id: "same",
                  name: "One",
                  window: "5h",
                  remaining_fraction: 0.2,
                  reset_time: "2026-08-09T12:00:00.000Z",
                },
                {
                  id: "same",
                  name: "Two",
                  window: "5h",
                  remaining_fraction: 0.3,
                  reset_time: "2026-08-09T12:00:00.000Z",
                },
              ],
            },
          ],
        },
      },
    });

    expect(result?.windows.map(({ id }) => id)).toEqual([
      "consumer/same",
      "consumer/same_2",
    ]);
    expect(result?.untrustedWindowIds).toEqual(["consumer/same_2"]);
  });

  it("allocates globally unique IDs across raw suffixes and sanitized groups", () => {
    const result = normalizeAgyUsage({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              id: "raw",
              name: "Raw",
              buckets: [
                {
                  id: "same_2",
                  name: "Raw suffix",
                  window: "5h",
                  remaining_fraction: 0.2,
                  reset_time: "2026-08-09T12:00:00.000Z",
                },
                {
                  id: "same",
                  name: "Collision with same_2",
                  window: "5h",
                  remaining_fraction: 0.5,
                  reset_time: "2026-08-09T12:00:00.000Z",
                },
                {
                  id: "same",
                  name: "Second collision with same_2",
                  window: "5h",
                  remaining_fraction: 0.6,
                  reset_time: "2026-08-09T12:00:00.000Z",
                },
              ],
            },
            {
              id: "same/group",
              name: "First sanitized group",
              buckets: [
                {
                  id: "bucket",
                  name: "First",
                  window: "5h",
                  remaining_fraction: 0.3,
                  reset_time: "2026-08-09T12:00:00.000Z",
                },
              ],
            },
            {
              id: "same-group",
              name: "Second sanitized group",
              buckets: [
                {
                  id: "bucket",
                  name: "Second",
                  window: "5h",
                  remaining_fraction: 0.4,
                  reset_time: "2026-08-09T12:00:00.000Z",
                },
              ],
            },
          ],
        },
      },
    });

    expect(result?.windows.map(({ id }) => id)).toEqual([
      "raw/same_2",
      "raw/same",
      "raw/same_3",
      "same-group/bucket",
      "same-group/bucket_2",
    ]);
    expect(new Set(result?.windows.map(({ id }) => id)).size).toBe(5);
    expect(result?.untrustedWindowIds).toEqual([
      "raw/same_3",
      "same-group/bucket",
      "same-group/bucket_2",
    ]);
  });

  it("marks missing and sanitized identities untrusted", () => {
    const cases = [
      {
        name: "separator",
        group: "consumer",
        bucket: "bad/id",
        expected: "consumer/bad-id",
      },
      {
        name: "unicode and control",
        group: "consumer",
        bucket: "bad☃\u0001id",
        expected: "consumer/bad-id",
      },
      {
        name: "truncated",
        group: "consumer",
        bucket: "x".repeat(121),
        expected: `consumer/${"x".repeat(120)}`,
      },
      {
        name: "missing group",
        group: undefined,
        bucket: "bucket",
        expected: "bucket",
      },
      {
        name: "non-colliding sanitized group",
        group: "preview/id",
        bucket: "bucket",
        expected: "preview-id/bucket",
      },
    ];

    for (const testCase of cases) {
      const result = normalizeAgyUsage({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                ...(testCase.group === undefined ? {} : { id: testCase.group }),
                buckets: [
                  {
                    id: testCase.bucket,
                    window: "5h",
                    remaining_fraction: 0.5,
                    reset_time: "2026-08-09T12:00:00.000Z",
                  },
                ],
              },
            ],
          },
        },
      });

      expect(result?.windows[0]?.id, testCase.name).toBe(testCase.expected);
      expect(result?.untrustedWindowIds, testCase.name).toEqual([
        testCase.expected,
      ]);
    }
  });

  it("recognizes only observed Antigravity period strings", () => {
    const periods = [
      ["5h", "session", 18_000],
      ["weekly", "weekly", 604_800],
      ["five_hour", "unknown", undefined],
      ["seven_day", "unknown", undefined],
      ["session", "unknown", undefined],
      ["7d", "unknown", undefined],
      ["week", "unknown", undefined],
      ["monthly", "unknown", undefined],
      ["30d", "unknown", undefined],
      ["model", "unknown", undefined],
      ["credits", "unknown", undefined],
      ["FIVE_HOUR", "unknown", undefined],
    ] as const;

    for (const [rawPeriod, kind, windowSeconds] of periods) {
      const id = `period-${rawPeriod}`;
      const result = normalizeAgyUsage({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                id: "consumer",
                buckets: [
                  {
                    id,
                    window: rawPeriod,
                    remaining_fraction: 0.5,
                    reset_time: "2026-08-09T12:00:00.000Z",
                  },
                ],
              },
            ],
          },
        },
      });

      expect(result?.windows[0]?.kind, rawPeriod).toBe(kind);
      expect(result?.windows[0]?.windowSeconds, rawPeriod).toBe(windowSeconds);
      if (kind === "unknown")
        expect(result?.untrustedWindowIds, rawPeriod).toContain(
          `consumer/${id}`,
        );
    }
  });

  it("preserves real auth context while isolating child cwd and XDG storage", async () => {
    const record = join(tempDir(), "record.json");
    process.env.OPENAI_API_KEY = "parent-secret-must-not-reach-agy";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/quota-axi-test-bus";
    const executable = fakeExecutable(
      `
const fs = await import("node:fs");
fs.writeFileSync(process.env.AGY_RECORD, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME,
  config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME,
  state: process.env.XDG_STATE_HOME,
  dirs: [process.env.HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME, process.env.XDG_STATE_HOME].map((path) => fs.existsSync(path)),
  sessionBus: process.env.DBUS_SESSION_BUS_ADDRESS,
  leaked: { openai: process.env.OPENAI_API_KEY, github: process.env.GITHUB_TOKEN },
}));
process.stdout.write(JSON.stringify(${JSON.stringify(fixture("usage-empty.json"))}));
`,
      { AGY_RECORD: record },
    );
    const observed: {
      command: string;
      args: string[];
      options?: SpawnOptions;
    }[] = [];
    const result = await runAgyCommand({
      executablePath: executable,
      spawnImpl: ((command, args, options) => {
        observed.push({ command, args, options });
        return portableSpawn(command, args, options);
      }) as typeof realSpawn,
    });

    expect(JSON.parse(result.stdout)).toEqual(fixture("usage-empty.json"));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.command).toBe(executable);
    expect(observed[0]?.args).toEqual([
      "-p",
      "/usage",
      "--output-format",
      "json",
    ]);
    expect(observed[0]?.options?.shell).toBe(false);
    expect(observed[0]?.options?.stdio).toEqual(["ignore", "pipe", "pipe"]);
    const seen = JSON.parse(readFileSync(record, "utf8")) as {
      argv: string[];
      cwd: string;
      home: string;
      config: string;
      cache: string;
      state: string;
      dirs: boolean[];
      sessionBus?: string;
      leaked: Record<string, string>;
    };
    expect(seen.argv).toEqual(["-p", "/usage", "--output-format", "json"]);
    expect(seen.cwd).toContain("quota-axi-agy-");
    expect(seen.home).toBe(process.env.HOME);
    for (const key of ["cwd", "config", "cache", "state"] as const) {
      const path = String(seen[key]);
      expect(path).toContain("quota-axi-agy-");
      expect(path).not.toContain(process.cwd());
    }
    expect(seen.dirs).toEqual([true, true, true, true]);
    expect(seen.sessionBus).toBe("unix:path=/tmp/quota-axi-test-bus");
    expect(seen.leaked).toEqual({});
    expect(existsSync(String(seen.cwd))).toBe(false);
    expect(existsSync(String(seen.config))).toBe(false);
    expect(existsSync(String(seen.cache))).toBe(false);
    expect(existsSync(String(seen.state))).toBe(false);
  });

  it("falls back through current-user home sources when HOME is absent or empty", async () => {
    const record = join(tempDir(), "home.json");
    const executable = fakeExecutable(
      `
const fs = await import("node:fs");
fs.writeFileSync(process.env.AGY_RECORD, JSON.stringify(process.env.HOME));
process.stdout.write(JSON.stringify(${JSON.stringify(fixture("usage-empty.json"))}));
`,
      { AGY_RECORD: record },
    );

    process.env.HOME = "";
    process.env.USERPROFILE = join(tempDir(), "profile");
    await runFakeAgyCommand({ executablePath: executable });
    expect(JSON.parse(readFileSync(record, "utf8"))).toBe(
      process.env.USERPROFILE,
    );

    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await runFakeAgyCommand({ executablePath: executable });
    expect(JSON.parse(readFileSync(record, "utf8"))).toBe(homedir());
  });

  it("classifies auth stderr without exposing it and never reads credentials", async () => {
    const sentinel = "AUTH-SECRET-SHOULD-NOT-ESCAPE";
    const executable = fakeExecutable(
      `process.stderr.write(${JSON.stringify(`sign in required ${sentinel}`)}); process.exit(7);`,
    );
    process.env[AGY_BINARY_ENV] = executable;

    const result = await fetchFakeQuota(executable);
    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("agy_auth_required");
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const auth = await inspectAuth(
      { allowKeychainPrompt: false },
      { executablePath: executable },
    );
    expect(auth.sources[0]).toMatchObject({
      source: "cli-print",
      status: "available",
    });
    expect(JSON.stringify(auth)).not.toContain("SECRET");
  });

  it("terminates a hanging child at the deadline and removes its root", async () => {
    const executable = fakeExecutable("setTimeout(() => {}, 1000);");
    await expect(
      runFakeAgyCommand({ executablePath: executable, timeoutMs: 25 }),
    ).rejects.toMatchObject({ message: "agy_process_timeout" });
  });

  it("waits for a stubborn child to exit before cleanup and returning", async () => {
    const record = join(tempDir(), "stubborn.json");
    const executable = fakeExecutable(
      `
const fs = await import("node:fs");
fs.writeFileSync(process.env.AGY_RECORD, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      { AGY_RECORD: record },
    );
    const started = Date.now();
    await expect(
      runFakeAgyCommand({ executablePath: executable, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ message: "agy_process_timeout" });
    const elapsed = Date.now() - started;
    const seen = JSON.parse(readFileSync(record, "utf8")) as {
      cwd: string;
      pid: number;
    };
    expect(elapsed).toBeGreaterThanOrEqual(
      process.platform === "win32" ? 1_000 : 1_500,
    );
    expect(existsSync(seen.cwd)).toBe(false);
    if (process.platform !== "win32")
      expect(() => process.kill(seen.pid, 0)).toThrow();
  });

  it("rejects oversized output without retaining the payload", async () => {
    const executable = fakeExecutable(
      "process.stdout.write('X'.repeat(10000));",
    );
    await expect(
      runFakeAgyCommand({ executablePath: executable, maxOutputBytes: 64 }),
    ).rejects.toMatchObject({ message: "agy_output_too_large" });
  });

  it("counts UTF-8 stdout bytes rather than JavaScript string length", async () => {
    const executable = fakeExecutable("process.stdout.write('€'.repeat(2));");
    await expect(
      runFakeAgyCommand({ executablePath: executable, maxOutputBytes: 4 }),
    ).rejects.toMatchObject({ message: "agy_output_too_large" });
  });

  it("counts UTF-8 stderr bytes rather than JavaScript string length", async () => {
    const executable = fakeExecutable(
      "process.stderr.write('€'.repeat(2)); process.exit(7);",
    );
    await expect(
      runFakeAgyCommand({ executablePath: executable, maxOutputBytes: 4 }),
    ).rejects.toMatchObject({ message: "agy_output_too_large" });
  });

  it("preserves split UTF-8 stdout and enforces raw byte boundaries", async () => {
    const payload = JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              id: "consumer",
              name: "Label é € 𐍈",
              buckets: [],
            },
          ],
        },
      },
    });
    const bytes = Buffer.byteLength(payload, "utf8");
    const executable = fakeExecutable(
      `(async () => { const bytes = Buffer.from(${JSON.stringify(payload)}); for (const byte of bytes) { process.stdout.write(Buffer.from([byte])); await new Promise((resolve) => setImmediate(resolve)); } })();`,
    );

    const result = await runFakeAgyCommand({
      executablePath: executable,
      maxOutputBytes: bytes,
    });
    expect(JSON.parse(result.stdout).command.data.groups[0].name).toBe(
      "Label é € 𐍈",
    );
    await expect(
      runFakeAgyCommand({
        executablePath: executable,
        maxOutputBytes: bytes - 1,
      }),
    ).rejects.toMatchObject({ message: "agy_output_too_large" });
  });

  it("preserves split UTF-8 stderr and enforces raw byte boundaries", async () => {
    const message = "diagnostic é € 𐍈";
    const bytes = Buffer.byteLength(message, "utf8");
    const executable = fakeExecutable(
      `(async () => { const bytes = Buffer.from(${JSON.stringify(message)}); for (const byte of bytes) { process.stderr.write(Buffer.from([byte])); await new Promise((resolve) => setImmediate(resolve)); } process.exit(7); })();`,
    );

    await expect(
      runFakeAgyCommand({ executablePath: executable, maxOutputBytes: bytes }),
    ).rejects.toMatchObject({ message: "agy_process_failed" });
    await expect(
      runFakeAgyCommand({
        executablePath: executable,
        maxOutputBytes: bytes - 1,
      }),
    ).rejects.toMatchObject({ message: "agy_output_too_large" });
  });

  it("maps malformed JSON to a bounded provider error", async () => {
    const executable = fakeExecutable("process.stdout.write('{not-json');");
    process.env[AGY_BINARY_ENV] = executable;
    const result = await fetchFakeQuota(executable);
    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("agy_output_invalid");
    expect(JSON.stringify(result)).not.toContain("not-json");
  });

  it("returns a fresh normalized provider report from the official command output", async () => {
    const executable = fakeExecutable(
      `process.stdout.write(JSON.stringify(${JSON.stringify(fixture("usage-json.json"))}));`,
    );
    const result = await fetchFakeQuota(executable);
    expect(result).toMatchObject({
      provider: "antigravity",
      label: "Antigravity",
      source: "cli-print",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["cli-print"],
      },
    });
    expect(result.windows).toHaveLength(4);
    expect(result.state.untrustedWindowIds).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("conversation_id");
  });

  it("returns a fresh empty provider report for a valid empty envelope", async () => {
    const executable = fakeExecutable(
      `process.stdout.write(JSON.stringify(${JSON.stringify(fixture("usage-empty.json"))}));`,
    );
    const result = await fetchFakeQuota(executable);
    expect(result.state.status).toBe("fresh");
    expect(result.windows).toEqual([]);
  });

  it("uses a normalized cached snapshot only for transient child failures", async () => {
    const cacheRoot = tempDir();
    process.env.XDG_CACHE_HOME = cacheRoot;
    writeCachedProviders([cachedAgy()]);
    const executable = fakeExecutable(
      "process.stderr.write('temporary failure'); process.exit(7);",
    );

    const result = await fetchFakeQuota(executable);
    expect(result.state.status).toBe("stale");
    expect(result.source).toBe("cache");
    expect(result.windows[0]?.percentRemaining).toBe(75);
  });

  it("retires a cached snapshot for definitive malformed output", async () => {
    const cacheRoot = tempDir();
    process.env.XDG_CACHE_HOME = cacheRoot;
    writeCachedProviders([cachedAgy()]);
    const executable = fakeExecutable("process.stdout.write('{bad');");

    const result = await fetchFakeQuota(executable);
    expect(result.state.status).toBe("error");
    expect(readCachedProvider("antigravity")).toBeUndefined();
  });

  it("retires a cached snapshot for oversized untrusted output", async () => {
    const cacheRoot = tempDir();
    process.env.XDG_CACHE_HOME = cacheRoot;
    writeCachedProviders([cachedAgy()]);
    const executable = fakeExecutable(
      "process.stdout.write('X'.repeat(1_100_000));",
    );

    const result = await fetchFakeQuota(executable);
    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("agy_output_too_large");
    expect(readCachedProvider("antigravity")).toBeUndefined();
  });
});

function tempDir(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "quota-axi-agy-test-"));
  return tempRoot;
}

function fakeExecutable(
  body: string,
  env: Record<string, string> = {},
): string {
  const root = tempRoot ?? tempDir();
  const file = join(
    root,
    `fake-agy-${Math.random().toString(16).slice(2)}.mjs`,
  );
  writeFileSync(
    file,
    `${Object.entries(env)
      .map(([key, value]) => `process.env.${key} = ${JSON.stringify(value)};`)
      .join("\n")}\n${body}\n`,
  );
  return file;
}

function fetchFakeQuota(executablePath: string) {
  return fetchQuota(
    { allowKeychainPrompt: false },
    { executablePath, spawnImpl: portableSpawn },
  );
}

function runFakeAgyCommand(options: Parameters<typeof runAgyCommand>[0]) {
  return runAgyCommand({ ...options, spawnImpl: portableSpawn });
}

function portableSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) {
  if (command.endsWith(".mjs"))
    return realSpawn(process.execPath, [command, ...args], options);
  return realSpawn(command, args, options);
}

function cachedAgy(): ProviderQuota {
  return {
    provider: "antigravity",
    label: "Antigravity",
    source: "cli-print",
    windows: [
      {
        id: "consumer/session",
        label: "Consumer: Session",
        kind: "session",
        percentRemaining: 75,
        percentUsed: 25,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-08-09T08:00:00.000Z",
      sourcesTried: ["cli-print"],
    },
  };
}
