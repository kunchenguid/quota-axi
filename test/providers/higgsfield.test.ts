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
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createHiggsfieldAdapter,
  normalizeHiggsfieldQuota,
} from "../../src/providers/higgsfield.js";
import { renderQuotaToon } from "../../src/render.js";
import type { ProviderQuota } from "../../src/types.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const GENERATED_AT = "2026-09-21T12:00:00.000Z";
const originalPath = process.env.PATH;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-higgsfield-"));
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Higgsfield CLI quota provider", () => {
  it("runs the read-only status, transactions, and list commands", async () => {
    const argsFile = join(tempDir, "args");
    installMockHiggsfield(argsFile);
    process.env.PATH = tempDir;

    const report = await createHiggsfieldAdapter().fetchQuota(OPTIONS);

    expect(recordedArgs(argsFile)).toEqual([
      ["account", "status", "--json"],
      ["account", "transactions", "--json", "--size", "100"],
      ["generate", "list", "--json", "--size", "20"],
    ]);
    expect(report).toMatchObject({
      provider: "higgsfield",
      label: "Higgsfield",
      source: "cli",
      plan: "ultra",
      credits: { remaining: 5992, unit: "credits" },
      jobs: { sampled: 4, completed: 2, failed: 1, other: 1 },
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        sourcesTried: ["higgsfield-cli", "higgsfield-transactions"],
      },
      attempts: [
        { source: "higgsfield-cli", status: "success" },
        { source: "higgsfield-transactions", status: "success" },
      ],
    });
    expect(report.windows).toEqual([
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: (8 / 6000) * 100,
        percentRemaining: (5992 / 6000) * 100,
        startsAt: "2026-08-25T12:23:04.620Z",
      },
    ]);
    expect(report.account).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/@|auth token|prompt|http/i);
  });

  it("never invokes higgsfield auth", async () => {
    const commands: string[][] = [];
    const report = await createHiggsfieldAdapter({
      findCommandPath: async () => "/mock/higgsfield",
      execFileText: async (_command, args) => {
        commands.push([...args]);
        if (args.includes("auth")) {
          throw new Error("auth must not run");
        }
        if (args[0] === "account" && args[1] === "status") {
          return readFixture("status.json");
        }
        if (args[0] === "account" && args[1] === "transactions") {
          return readFixture("transactions.json");
        }
        return readFixture("jobs.json");
      },
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(commands.some((args) => args.includes("auth"))).toBe(false);
  });

  it("ignores status email and does not publish it", () => {
    const normalized = normalizeHiggsfieldQuota({
      status: {
        credits: 10,
        subscription_plan_type: "ultra",
        email: "user@example.test",
      },
    });
    expect(normalized).toEqual({
      plan: "ultra",
      credits: { remaining: 10, unit: "credits" },
      windows: [],
    });
    expect(JSON.stringify(normalized)).not.toContain("@");
  });

  it("omits the credits window when no subscription grant is present", () => {
    expect(
      normalizeHiggsfieldQuota({
        status: { credits: 5992, subscription_plan_type: "ultra" },
        transactions: { items: [{ action: "spend", credits: -2 }] },
      }),
    ).toEqual({
      plan: "ultra",
      credits: { remaining: 5992, unit: "credits" },
      windows: [],
    });
  });

  it("omits a grant that is smaller than remaining instead of inventing a percentage", () => {
    expect(
      normalizeHiggsfieldQuota({
        status: { credits: 500, subscription_plan_type: "ultra" },
        transactions: {
          items: [
            {
              action: "grant",
              credits: 100,
              display_name: "Subscription Credits",
            },
          ],
        },
      }).windows,
    ).toEqual([]);
  });

  it("does not hardcode an Ultra 6000 cap from the plan name", () => {
    expect(
      normalizeHiggsfieldQuota({
        status: { credits: 5992, subscription_plan_type: "ultra" },
      }).windows,
    ).toEqual([]);
  });

  it("keeps remaining credits when auxiliary CLI commands fail", async () => {
    const report = await createHiggsfieldAdapter({
      findCommandPath: async () => "/mock/higgsfield",
      execFileText: async (_command, args) => {
        if (args[0] === "account" && args[1] === "status") {
          return readFixture("status.json");
        }
        throw new Error("auxiliary unavailable");
      },
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "cli",
      plan: "ultra",
      credits: { remaining: 5992, unit: "credits" },
      windows: [],
      state: { status: "fresh", authStatus: "usable" },
      attempts: [
        { source: "higgsfield-cli", status: "success" },
        {
          source: "higgsfield-transactions",
          status: "failed",
          error: "higgsfield_transactions_failed: auxiliary unavailable",
        },
      ],
    });
    expect(report.jobs).toBeUndefined();
  });

  it("names a failed transactions read in default TOON attention", async () => {
    const report = await createHiggsfieldAdapter({
      findCommandPath: async () => "/mock/higgsfield",
      execFileText: async (_command, args) => {
        if (args[0] === "account" && args[1] === "status") {
          return readFixture("status.json");
        }
        if (args[0] === "account" && args[1] === "transactions") {
          throw new Error("auxiliary unavailable");
        }
        return readFixture("jobs.json");
      },
    }).fetchQuota(OPTIONS);

    const withSemantics = withQuotaSemantics(report, GENERATED_AT);
    expect(withSemantics.state.degradedSources).toEqual([
      {
        source: "higgsfield-transactions",
        error: "higgsfield_transactions_failed: auxiliary unavailable",
      },
    ]);
    const toon = renderQuotaToon(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 5,
        providers: [withSemantics],
      },
      "quota-axi",
      false,
    );
    expect(toon).toContain(
      'higgsfield,all,degraded_source,"higgsfield-transactions · ' +
        'higgsfield_transactions_failed: auxiliary unavailable",none',
    );
  });

  it("names malformed transactions JSON instead of omitting it silently", async () => {
    const report = await createHiggsfieldAdapter({
      findCommandPath: async () => "/mock/higgsfield",
      execFileText: async (_command, args) => {
        if (args[0] === "account" && args[1] === "status") {
          return readFixture("status.json");
        }
        if (args[0] === "account" && args[1] === "transactions") {
          return "<html>gateway error</html>";
        }
        return readFixture("jobs.json");
      },
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([]);
    expect(report.attempts).toEqual([
      { source: "higgsfield-cli", status: "success" },
      {
        source: "higgsfield-transactions",
        status: "failed",
        error: "higgsfield_transactions_malformed_json",
      },
    ]);
  });

  it("does not read auth or rate-limit keywords out of wrapped CLI stderr", async () => {
    const fetchWithError = async (message: string) =>
      createHiggsfieldAdapter({
        findCommandPath: async () => "/mock/higgsfield",
        execFileText: async () => {
          throw new Error(message);
        },
      }).fetchQuota(OPTIONS);

    const missingArg = await fetchWithError(
      "Error: required argument '--output' missing",
    );
    expect(missingArg.state.status).toBe("error");
    expect(missingArg.state.error).toBe(
      "higgsfield_status_failed: Error: required argument '--output' missing",
    );

    const vendorRateLimit = await fetchWithError(
      "rate limit reached, retry later",
    );
    expect(vendorRateLimit.state.status).toBe("error");
    expect(vendorRateLimit.state.error).toBe(
      "higgsfield_status_failed: rate limit reached, retry later",
    );
  });

  it("rolls up job statuses including unknown values as other", () => {
    expect(
      normalizeHiggsfieldQuota({
        status: { credits: 1, subscription_plan_type: "ultra" },
        jobs: [
          { status: "completed" },
          { status: "FAILED" },
          { status: "queued" },
        ],
      }).jobs,
    ).toEqual({ sampled: 3, completed: 1, failed: 1, other: 1 });
  });

  it("reports malformed status JSON instead of inventing quota", async () => {
    const argsFile = join(tempDir, "args");
    installMockHiggsfield(argsFile, {
      status: JSON.stringify({ unexpected: true }),
    });
    process.env.PATH = tempDir;
    const report = await createHiggsfieldAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "error", error: "higgsfield_status_malformed_json" },
    });
  });

  it("classifies a sign-in CLI failure as auth_required", async () => {
    const report = await createHiggsfieldAdapter({
      findCommandPath: async () => "/mock/higgsfield",
      execFileText: async () => {
        throw new Error("not logged in");
      },
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: {
        status: "auth_required",
        error: "higgsfield_sign_in_required",
      },
      attempts: [
        {
          source: "higgsfield-cli",
          status: "failed",
          error: "higgsfield_sign_in_required",
        },
      ],
    });
  });

  it("reports unavailable when the CLI is missing", async () => {
    process.env.PATH = tempDir;
    const report = await createHiggsfieldAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", error: "higgsfield_cli_unavailable" },
      attempts: [
        {
          source: "higgsfield-cli",
          status: "skipped",
          error: "higgsfield_cli_unavailable",
        },
      ],
    });
  });

  it("inspects auth as the CLI path without running quota commands", async () => {
    const execFileText = async (): Promise<string> => {
      throw new Error("inspectAuth must not probe quota");
    };
    const present = await createHiggsfieldAdapter({
      findCommandPath: async () => "/mock/higgsfield",
      execFileText,
    }).inspectAuth(OPTIONS);
    const missing = await createHiggsfieldAdapter({
      findCommandPath: async () => undefined,
      execFileText,
    }).inspectAuth(OPTIONS);

    expect(present).toEqual({
      provider: "higgsfield",
      sources: [{ source: "higgsfield-cli", status: "available" }],
    });
    expect(missing).toEqual({
      provider: "higgsfield",
      sources: [{ source: "higgsfield-cli", status: "missing" }],
    });
  });

  it("bounds included_credits and names jobs in default TOON", () => {
    const report = withQuotaSemantics(
      {
        provider: "higgsfield",
        label: "Higgsfield",
        source: "cli",
        plan: "ultra",
        windows: [
          {
            id: "credits",
            label: "credits",
            kind: "credits",
            percentUsed: (8 / 6000) * 100,
            percentRemaining: (5992 / 6000) * 100,
          },
        ],
        credits: { remaining: 5992, unit: "credits" },
        jobs: { sampled: 20, completed: 20, failed: 0, other: 0 },
        state: {
          status: "fresh",
          stale: false,
          authStatus: "usable",
          sourcesTried: ["higgsfield-cli"],
        },
      } satisfies ProviderQuota,
      GENERATED_AT,
    );

    expect(report.quotaSemantics?.effectiveAvailability).toEqual([
      expect.objectContaining({
        scope: "included_credits",
        status: "known",
        effectivePercentRemaining: (5992 / 6000) * 100,
        boundedBy: ["credits"],
      }),
    ]);
    const toon = renderQuotaToon(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 5,
        providers: [report],
      },
      "quota-axi",
      false,
    );
    expect(toon).toContain("higgsfield,included_credits,");
    expect(toon).toContain(
      "higgsfield,all,jobs,sampled 20 · completed 20 · failed 0 · other 0,none",
    );
  });
});

function readFixture(name: string): string {
  return readFileSync(
    join(process.cwd(), "test/fixtures/higgsfield", name),
    "utf8",
  );
}

function recordedArgs(argsFile: string): string[][] {
  return readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
}

function installMockHiggsfield(
  argsFile: string,
  outputs: {
    status?: string;
    transactions?: string;
    jobs?: string;
  } = {},
): void {
  const script = join(tempDir, "higgsfield");
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const status = outputs.status ?? readFixture("status.json");
  const transactions = outputs.transactions ?? readFixture("transactions.json");
  const jobs = outputs.jobs ?? readFixture("jobs.json");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(argsFile)}`,
      'case " $* " in',
      '  *" auth "*) echo "auth must not run" >&2; exit 9 ;;',
      "esac",
      'if [ "$1" = "account" ] && [ "$2" = "status" ]; then printf "%s" ' +
        shellQuote(status) +
        "; exit 0; fi",
      'if [ "$1" = "account" ] && [ "$2" = "transactions" ]; then printf "%s" ' +
        shellQuote(transactions) +
        "; exit 0; fi",
      'if [ "$1" = "generate" ] && [ "$2" = "list" ]; then printf "%s" ' +
        shellQuote(jobs) +
        "; exit 0; fi",
      "exit 8",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
}
