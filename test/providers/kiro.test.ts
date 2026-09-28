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
import { withInputTrace } from "../../src/lib/input-trace.js";
import {
  createKiroAdapter,
  normalizeKiroUsage,
  parseKiroWhoami,
} from "../../src/providers/kiro.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const WHOAMI_SIGNED_IN =
  '{"accountType":"SocialGoogle","email":"kiro@example.com"}';
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
      "whoami -f json",
      "chat --no-interactive /usage",
    ]);
    expect(report).toMatchObject({
      provider: "kiro",
      label: "Kiro",
      source: "cli",
      plan: "KIRO PRO+",
      account: { email: "kiro@example.com" },
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

  it("traces the vendor credential store so a sign-in switch invalidates reuse", async () => {
    const storePath = join(tempDir, "data.sqlite3");
    writeFileSync(storePath, "store");
    const commandPath = join(tempDir, "kiro-cli");
    const report = await withInputTrace(() =>
      createKiroAdapter({
        findCommandPath: async () => commandPath,
        execFileText: async (_command, args) =>
          args[0] === "whoami"
            ? WHOAMI_SIGNED_IN
            : readFixture("usage-partial.txt"),
        credentialStorePath: () => storePath,
      }).fetchQuota(OPTIONS),
    );

    expect(report.value.state.status).toBe("fresh");
    expect(report.inputs.paths).toEqual([storePath]);
  });

  it("executes the resolved command path", async () => {
    const commandPath = join(tempDir, "kiro-cli");
    const execFileText = async (
      command: string,
      args: string[],
      _timeoutMs: number,
    ): Promise<string> => {
      expect(command).toBe(commandPath);
      return args[0] === "whoami"
        ? WHOAMI_SIGNED_IN
        : readFixture("usage-partial.txt");
    };
    const report = await createKiroAdapter({
      findCommandPath: async () => commandPath,
      execFileText,
      credentialStorePath: () => undefined,
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

  it("never invokes the usage view on a signed-out CLI", async () => {
    const argsFile = join(tempDir, "args");
    installMockKiroCli(argsFile, readFixture("usage-exhausted.txt"), {
      signedOut: true,
    });
    process.env.PATH = tempDir;

    const report = await createKiroAdapter().fetchQuota(OPTIONS);

    expect(readFileSync(argsFile, "utf8").trim()).toBe("whoami -f json");
    expect(report.account).toBeUndefined();
    expect(report).toMatchObject({
      provider: "kiro",
      windows: [],
      state: {
        status: "auth_required",
        error: "kiro_sign_in_required",
        remedyCommand: "kiro-cli login",
      },
      attempts: [
        {
          source: "kiro-cli",
          status: "failed",
          error: "kiro_sign_in_required",
        },
      ],
    });
  });

  it("fails closed when the percentage disagrees with the used/total ratio", () => {
    expect(
      normalizeKiroUsage(
        "Estimated Usage | resets on 2026-10-01 | KIRO PRO+\n" +
          "Credits (100.00 of 2000 covered in plan), 99.9%\n",
      ),
    ).toBeUndefined();
  });

  it("rejects reset dates that cannot exist on a calendar", () => {
    for (const date of [
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "0099-01-01",
    ]) {
      expect(
        normalizeKiroUsage(
          `Estimated Usage | resets on ${date} | KIRO PRO+\n` +
            "Credits (250.50 of 2000 covered in plan), 12.5%\n",
        ),
      ).toBeUndefined();
    }
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
    installMockKiroCli(argsFile, "not used", { failUsage: true });
    process.env.PATH = tempDir;

    const report = await createKiroAdapter().fetchQuota(OPTIONS);

    expect(report.windows).toEqual([]);
    expect(report.state.status).toBe("error");
    expect(report.attempts?.[0]?.status).toBe("failed");
  });

  it("parses the vendor whoami identity", () => {
    expect(parseKiroWhoami(WHOAMI_SIGNED_IN)).toEqual({
      status: "signed_in",
      email: "kiro@example.com",
      accountType: "SocialGoogle",
    });
    expect(parseKiroWhoami('{"account":null}')).toEqual({
      status: "signed_out",
    });
    expect(parseKiroWhoami("Not logged in")).toEqual({ status: "malformed" });
    expect(parseKiroWhoami("{}")).toEqual({ status: "signed_out" });
  });

  it("reports sign-in state through auth inspection", async () => {
    const argsFile = join(tempDir, "args");
    installMockKiroCli(argsFile, readFixture("usage-exhausted.txt"));
    process.env.PATH = tempDir;

    const present = await createKiroAdapter().inspectAuth(OPTIONS);
    expect(present).toEqual({
      provider: "kiro",
      sources: [{ source: "kiro-cli", status: "available" }],
    });

    installMockKiroCli(argsFile, readFixture("usage-exhausted.txt"), {
      signedOut: true,
    });
    const signedOut = await createKiroAdapter().inspectAuth(OPTIONS);
    expect(signedOut).toEqual({
      provider: "kiro",
      sources: [
        {
          source: "kiro-cli",
          status: "missing",
          error: "kiro_sign_in_required",
        },
      ],
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
  options: { failUsage?: boolean; signedOut?: boolean } = {},
): void {
  const script = join(tempDir, "kiro-cli");
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const whoami = options.signedOut
    ? "echo '{\"account\":null}'; exit 1"
    : `printf '%s' ${shellQuote(WHOAMI_SIGNED_IN)}`;
  const usage = options.failUsage
    ? "exit 7"
    : `printf '%s' ${shellQuote(output)}`;
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(argsFile)}`,
      'if [ "$1" = "whoami" ]; then',
      `  ${whoami}`,
      "else",
      `  ${usage}`,
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
}

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "test/fixtures/kiro", name), "utf8");
}
