import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAlibabaAdapter,
  normalizeAlibabaUsage,
} from "../../src/providers/alibaba.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const originalPath = process.env.PATH;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-alibaba-"));
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Alibaba bl usage provider", () => {
  it("runs the official Token Plan command and normalizes its weekly window", async () => {
    const argsFile = join(tempDir, "args");
    installMockBl(argsFile, readFixture());
    process.env.PATH = tempDir;

    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "usage",
      "token-plan",
      "--output",
      "json",
    ]);
    expect(report).toMatchObject({
      provider: "alibaba",
      label: "Alibaba Coding Plan",
      source: "cli",
      plan: "Alibaba Coding Plan",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["bl-cli"],
      },
      attempts: [{ source: "bl-cli", status: "success" }],
    });
    expect(report.windows).toEqual([
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 0.23405264824,
        percentRemaining: 99.76594735176,
        resetsAt: "2026-09-03T15:00:00.000Z",
      },
    ]);
  });

  it("executes the resolved command path", async () => {
    const commandPath = join(tempDir, "bl.cmd");
    const execFileText = async (
      command: string,
      args: string[],
      _timeoutMs: number,
    ): Promise<string> => {
      expect(command).toBe(commandPath);
      expect(args).toEqual(["usage", "token-plan", "--output", "json"]);
      return readFixture();
    };
    const report = await createAlibabaAdapter({
      findCommandPath: async () => commandPath,
      execFileText,
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
  });

  it("accepts used percentages already expressed from zero to one hundred", () => {
    expect(
      normalizeAlibabaUsage({
        plan: "Coding Plan",
        per1WeekPercentage: 25,
        per1WeekResetTime: 1_800_000_000,
      }),
    ).toEqual({
      plan: "Coding Plan",
      windows: [
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed: 25,
          percentRemaining: 75,
          resetsAt: "2027-01-15T08:00:00.000Z",
        },
      ],
    });
  });

  it("returns no windows for malformed Token Plan data", () => {
    expect(normalizeAlibabaUsage({ per1WeekResetTime: 1 })).toEqual({
      plan: "Alibaba Coding Plan",
      windows: [],
    });
  });

  it("keeps a valid empty usage response fresh", async () => {
    const argsFile = join(tempDir, "args");
    installMockBl(argsFile, JSON.stringify({ planName: "Coding Plan" }));
    process.env.PATH = tempDir;

    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "alibaba",
      source: "cli",
      windows: [],
      state: { status: "fresh", stale: false },
      attempts: [{ source: "bl-cli", status: "success" }],
    });
  });

  it("reports malformed CLI data instead of returning stale quota", async () => {
    const argsFile = join(tempDir, "args");
    installMockBl(argsFile, JSON.stringify({ unexpected: true }));
    process.env.PATH = tempDir;
    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "bl_usage_malformed_json" },
    });
  });

  it.each([
    ["an invalid limits field", { limits: "bad" }],
    ["an incomplete model limit", { limits: [{ model: "qwen-plus" }] }],
    ["an invalid weekly percentage", { per1WeekPercentage: "bad" }],
    ["an invalid weekly reset", { per1WeekResetTime: {} }],
    ["a reset without usage evidence", { per1WeekResetTime: 1 }],
  ])("reports invalid CLI data for %s", async (_description, payload) => {
    const argsFile = join(tempDir, "args");
    installMockBl(argsFile, JSON.stringify(payload));
    process.env.PATH = tempDir;
    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "bl_usage_malformed_json" },
    });
  });

  it("keeps duplicate model limits as separate windows", () => {
    const normalized = normalizeAlibabaUsage({
      limits: [
        { model: "qwen-plus", percentage: 25 },
        { model: "qwen-plus", percentage: 50 },
        { model: "qwen-plus:2", percentage: 75 },
      ],
    });

    expect(normalized.windows).toEqual([
      expect.objectContaining({
        id: "model:qwen-plus",
        percentRemaining: 75,
      }),
      expect.objectContaining({
        id: "model:qwen-plus:2",
        percentRemaining: 50,
      }),
      expect.objectContaining({
        id: "model:qwen-plus:2:1",
        percentRemaining: 25,
      }),
    ]);
  });

  it("omits malformed model resets without discarding valid windows", () => {
    const normalized = normalizeAlibabaUsage({
      per1WeekPercentage: 0.25,
      limits: [
        { model: "bad-model", percentage: 50, resetAt: 1e20 },
        { model: "invalid-date", percentage: 25, resetAt: "not-a-date" },
        { model: "good-model", percentage: 25 },
      ],
    });

    expect(normalized.windows).toEqual([
      expect.objectContaining({
        id: "weekly",
        percentRemaining: 75,
      }),
      expect.objectContaining({
        id: "model:bad-model",
        percentRemaining: 50,
      }),
      expect.objectContaining({
        id: "model:invalid-date",
        percentRemaining: 75,
      }),
      expect.objectContaining({
        id: "model:good-model",
        percentRemaining: 75,
      }),
    ]);
    expect(normalized.windows[0]).not.toHaveProperty("resetsAt");
    expect(normalized.windows[2]).not.toHaveProperty("resetsAt");
  });

  it("preserves nested model-limit data as a model-scoped window", () => {
    const normalized = normalizeAlibabaUsage({
      per1WeekPercentage: 0.25,
      per1WeekResetTime: "2026-09-03T15:00:00Z",
      limits: [
        {
          model: "qwen3-max",
          model_limit: { usage_limit_period: 604800, percentage: 1 },
        },
      ],
    });

    expect(normalized.windows).toHaveLength(2);
    expect(normalized.windows[0]?.id).toBe("weekly");
    expect(normalized.windows[0]?.kind).toBe("weekly");
    expect(normalized.windows[1]).toMatchObject({
      id: "model:qwen3-max",
      kind: "model",
      percentRemaining: 99,
    });
  });

  it("preserves named model limits as model-scoped windows when present", () => {
    const normalized = normalizeAlibabaUsage(
      JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "test/fixtures/alibaba/usage-with-model-limits.json",
          ),
          "utf8",
        ),
      ),
    );

    expect(normalized.windows).toEqual([
      expect.objectContaining({
        id: "weekly",
        kind: "weekly",
        percentRemaining: 99.76594735176,
      }),
      expect.objectContaining({
        id: "model:qwen3-max",
        label: "qwen3-max",
        kind: "model",
        percentUsed: 25,
        percentRemaining: 75,
      }),
      expect.objectContaining({
        id: "model:qwen-plus",
        label: "qwen-plus",
        kind: "model",
        percentUsed: 40,
        percentRemaining: 60,
      }),
    ]);
  });

  it("reports unavailable when bl is not on PATH", async () => {
    process.env.PATH = tempDir;

    const report = await createAlibabaAdapter({
      readCachedProvider: () => undefined,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "alibaba",
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", error: "bl_cli_unavailable" },
      attempts: [
        { source: "bl-cli", status: "skipped", error: "bl_cli_unavailable" },
      ],
    });
  });

  it("reports a failed CLI without throwing", async () => {
    const argsFile = join(tempDir, "args");
    installMockBl(argsFile, "not used", true);
    process.env.PATH = tempDir;

    const report = await createAlibabaAdapter({
      readCachedProvider: () => undefined,
    }).fetchQuota(OPTIONS);

    expect(report.windows).toEqual([]);
    expect(report.state.status).toBe("error");
    expect(report.attempts?.[0]?.status).toBe("failed");
  });

  it("reports unavailable when the CLI becomes unavailable", async () => {
    process.env.PATH = tempDir;
    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", error: "bl_cli_unavailable" },
      attempts: [
        { source: "bl-cli", status: "skipped", error: "bl_cli_unavailable" },
      ],
    });
  });
});

function readFixture(): string {
  return readFileSync(
    join(process.cwd(), "test/fixtures/alibaba/usage-summary.json"),
    "utf8",
  );
}

function installMockBl(argsFile: string, output: string, fail = false): void {
  const script = join(tempDir, "bl");
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${shellQuote(argsFile)}`,
      fail ? "exit 7" : `printf '%s' ${shellQuote(output)}`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
}
