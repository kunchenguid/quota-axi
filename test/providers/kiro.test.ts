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
  createKiroAdapter,
  normalizeKiroUsage,
} from "../../src/providers/kiro.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const originalPath = process.env.PATH;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-kiro-"));
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Kiro kiro-cli usage provider", () => {
  it("runs the vendor usage view and normalizes its monthly window", async () => {
    const argsFile = join(tempDir, "args");
    installMockKiroCli(argsFile, readFixture("usage-exhausted.txt"));
    process.env.PATH = tempDir;

    const report = await createKiroAdapter().fetchQuota(OPTIONS);

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "chat",
      "--no-interactive",
      "/usage",
    ]);
    expect(report).toMatchObject({
      provider: "kiro",
      label: "Kiro",
      source: "cli",
      plan: "KIRO PRO+",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["kiro-cli"],
      },
      attempts: [{ source: "kiro-cli", status: "success" }],
    });
    expect(report.windows).toEqual([
      {
        id: "monthly",
        label: "month",
        kind: "monthly",
        percentUsed: 100,
        percentRemaining: 0,
        resetsAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
  });

  it("executes the resolved command path", async () => {
    const commandPath = join(tempDir, "kiro-cli");
    const execFileText = async (
      command: string,
      args: string[],
      _timeoutMs: number,
    ): Promise<string> => {
      expect(command).toBe(commandPath);
      expect(args).toEqual(["chat", "--no-interactive", "/usage"]);
      return readFixture("usage-partial.txt");
    };
    const report = await createKiroAdapter({
      findCommandPath: async () => commandPath,
      execFileText,
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report).toMatchObject({ plan: "KIRO PRO" });
    expect(report.windows).toEqual([
      {
        id: "monthly",
        label: "month",
        kind: "monthly",
        percentUsed: 12.5,
        percentRemaining: 87.5,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });

  it("fails closed when the percentage disagrees with the used/total ratio", () => {
    expect(
      normalizeKiroUsage(
        "Estimated Usage | resets on 2026-10-01 | KIRO PRO+\n" +
          "Credits (100.00 of 2000 covered in plan), 99.9%\n",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for malformed usage views", () => {
    expect(normalizeKiroUsage("")).toBeUndefined();
    expect(normalizeKiroUsage(undefined)).toBeUndefined();
    expect(
      normalizeKiroUsage("Estimated Usage | resets on soon | KIRO PRO+\n"),
    ).toBeUndefined();
    expect(
      normalizeKiroUsage(
        "Estimated Usage | resets on 2026-10-01 | KIRO PRO+\n" +
          "Credits (2000.00 of 0 covered in plan), 100.0%\n",
      ),
    ).toBeUndefined();
    expect(
      normalizeKiroUsage(
        "Estimated Usage | resets on 2026-10-01 | KIRO PRO+\n" +
          "Credits (2000.00 of 2000 covered in plan), 100.0%\n".replace(
            "covered in plan",
            "remaining",
          ),
      ),
    ).toBeUndefined();
  });

  it("reports malformed CLI data instead of returning stale quota", async () => {
    const argsFile = join(tempDir, "args");
    installMockKiroCli(argsFile, "unexpected output\n");
    process.env.PATH = tempDir;

    const report = await createKiroAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "kiro",
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "kiro_usage_malformed" },
      attempts: [
        { source: "kiro-cli", status: "failed", error: "kiro_usage_malformed" },
      ],
    });
  });

  it("reports unavailable when kiro-cli is not on PATH", async () => {
    process.env.PATH = tempDir;

    const report = await createKiroAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "kiro",
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", error: "kiro_cli_unavailable" },
      attempts: [
        {
          source: "kiro-cli",
          status: "skipped",
          error: "kiro_cli_unavailable",
        },
      ],
    });
  });

  it("reports a failed CLI without throwing", async () => {
    const argsFile = join(tempDir, "args");
    installMockKiroCli(argsFile, "not used", true);
    process.env.PATH = tempDir;

    const report = await createKiroAdapter().fetchQuota(OPTIONS);

    expect(report.windows).toEqual([]);
    expect(report.state.status).toBe("error");
    expect(report.attempts?.[0]?.status).toBe("failed");
  });

  it("reports CLI presence through auth inspection", async () => {
    const argsFile = join(tempDir, "args");
    installMockKiroCli(argsFile, readFixture("usage-exhausted.txt"));
    process.env.PATH = tempDir;

    const present = await createKiroAdapter().inspectAuth(OPTIONS);
    expect(present).toEqual({
      provider: "kiro",
      sources: [{ source: "kiro-cli", status: "available" }],
    });

    process.env.PATH = join(tempDir, "empty");
    const missing = await createKiroAdapter().inspectAuth(OPTIONS);
    expect(missing).toEqual({
      provider: "kiro",
      sources: [{ source: "kiro-cli", status: "missing" }],
    });
  });
});

function installMockKiroCli(
  argsFile: string,
  output: string,
  fail = false,
): void {
  const script = join(tempDir, "kiro-cli");
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

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "test/fixtures/kiro", name), "utf8");
}
