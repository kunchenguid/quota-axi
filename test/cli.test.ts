import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFlags, parseModelsFlags } from "../src/args.js";
import { main, normalizeArgv } from "../src/cli.js";
import { authCommand } from "../src/commands.js";
import { PROVIDERS } from "../src/providers/index.js";
import { redactedResponse } from "../src/render.js";
import type {
  ProviderAdapter,
  ProviderQuota,
  QuotaAxiResponse,
} from "../src/types.js";

const originalClaudeProvider = PROVIDERS.claude;
const originalCodexProvider = PROVIDERS.codex;
const originalCursorProvider = PROVIDERS.cursor;
const originalCopilotProvider = PROVIDERS.copilot;
const originalGrokProvider = PROVIDERS.grok;
const originalKimiProvider = PROVIDERS.kimi;
const originalZaiProvider = PROVIDERS.zai;
const originalAgyProvider = PROVIDERS.agy;
const originalKiroProvider = PROVIDERS.kiro;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  PROVIDERS.claude = originalClaudeProvider;
  PROVIDERS.codex = originalCodexProvider;
  PROVIDERS.cursor = originalCursorProvider;
  PROVIDERS.copilot = originalCopilotProvider;
  PROVIDERS.grok = originalGrokProvider;
  PROVIDERS.kimi = originalKimiProvider;
  PROVIDERS.zai = originalZaiProvider;
  PROVIDERS.agy = originalAgyProvider;
  PROVIDERS.kiro = originalKiroProvider;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
  vi.useRealTimers();
});

describe("CLI flag parsing", () => {
  it("defaults to all supported providers", () => {
    expect(parseFlags([]).providers).toEqual([
      "claude",
      "codex",
      "cursor",
      "copilot",
      "grok",
      "kimi",
      "zai",
      "agy",
      "kiro",
    ]);
  });

  it("scopes comma-separated providers", () => {
    expect(parseFlags(["--provider", "claude"]).providers).toEqual(["claude"]);
    expect(
      parseFlags(["--provider=cursor,copilot,grok,kimi"]).providers,
    ).toEqual(["cursor", "copilot", "grok", "kimi"]);
    expect(parseFlags(["--provider=cursor,copilot,grok"]).providers).toEqual([
      "cursor",
      "copilot",
      "grok",
    ]);
    expect(parseFlags(["--provider", "agy"]).providers).toEqual(["agy"]);
  });

  it("ignores a standalone argument separator", () => {
    expect(parseFlags(["--", "--provider", "grok", "--json"])).toMatchObject({
      providers: ["grok"],
      json: true,
    });
  });

  it("collects the boolean flags", () => {
    expect(parseFlags(["--json", "--full", "--allow-keychain-prompt"])).toEqual(
      {
        providers: [
          "claude",
          "codex",
          "cursor",
          "copilot",
          "grok",
          "kimi",
          "zai",
          "agy",
          "kiro",
        ],
        json: true,
        full: true,
        tui: false,
        once: false,
        allowKeychainPrompt: true,
      },
    );
    expect(parseFlags(["--tui"]).tui).toBe(true);
    expect(parseFlags(["--tui", "--once"]).once).toBe(true);
  });

  it("parses whole-unit refresh intervals for the live report", () => {
    expect(parseFlags(["--tui", "--refresh", "45"]).refreshSeconds).toBe(45);
    expect(parseFlags(["--tui", "--refresh", "90s"]).refreshSeconds).toBe(90);
    expect(parseFlags(["--tui", "--refresh=5m"]).refreshSeconds).toBe(300);
    expect(parseFlags(["--tui", "--refresh=2h"]).refreshSeconds).toBe(7200);
    expect(parseFlags(["--tui"]).refreshSeconds).toBeUndefined();
  });

  it("rejects refresh values that are unparseable or out of bounds", () => {
    for (const value of ["", "soon", "5x", "-1m", "1.5m"]) {
      expect(() => parseFlags(["--tui", "--refresh", value])).toThrow(
        "--refresh requires a duration such as 30s, 5m, or 1h",
      );
    }
    for (const value of ["29s", "0", "25h"]) {
      expect(() => parseFlags(["--tui", "--refresh", value])).toThrow(
        "--refresh must be between 30s and 24h",
      );
    }
  });

  it("rejects live-only flags without --tui", () => {
    expect(() => parseFlags(["--refresh", "5m"])).toThrow(
      "--refresh is only supported with --tui",
    );
    expect(() => parseFlags(["--once"])).toThrow(
      "--once is only supported with --tui",
    );
    expect(() => parseModelsFlags(["--once"])).toThrow(
      "--once is only supported with --tui",
    );
  });

  it("rejects --tui combined with --json", () => {
    expect(() => parseFlags(["--tui", "--json"])).toThrow(
      "--tui and --json are mutually exclusive output modes",
    );
  });

  it("rejects --tui outside the quota command", async () => {
    expect(() => parseModelsFlags(["--tui"])).toThrow(
      "--tui is only supported by the quota command",
    );
    await expect(
      authCommand(["--tui"], { binPath: "quota-axi" }),
    ).rejects.toThrow("--tui is only supported by the quota command");
  });

  it("rejects unsupported providers", () => {
    expect(() => parseFlags(["--provider", "gemini"])).toThrow(
      "unsupported provider",
    );
  });

  it("rejects unknown flags", () => {
    expect(() => parseFlags(["--bogus"])).toThrow("unknown argument: --bogus");
  });
});

describe("argv normalization", () => {
  it("prefixes the implicit quota command onto a bare invocation", () => {
    expect(normalizeArgv([])).toEqual(["quota"]);
  });

  it("routes leading flags to the quota command", () => {
    expect(normalizeArgv(["--json"])).toEqual(["quota", "--json"]);
    expect(normalizeArgv(["--provider", "claude"])).toEqual([
      "quota",
      "--provider",
      "claude",
    ]);
  });

  it("leaves explicit commands and SDK built-ins untouched", () => {
    expect(normalizeArgv(["auth", "--json"])).toEqual(["auth", "--json"]);
    expect(normalizeArgv(["update", "--check"])).toEqual(["update", "--check"]);
    expect(normalizeArgv(["quota", "--full"])).toEqual(["quota", "--full"]);
  });

  it("preserves the single-token help and version flags for the SDK", () => {
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["-h"])).toEqual(["--help"]);
    expect(normalizeArgv(["-v"])).toEqual(["-v"]);
    expect(normalizeArgv(["--version"])).toEqual(["--version"]);
  });

  it("routes legacy help aliases to top-level help with commands", () => {
    expect(normalizeArgv(["auth", "-h"])).toEqual(["--help"]);
    expect(normalizeArgv(["-h", "quota"])).toEqual(["--help"]);
  });

  it("routes flag-first explicit commands to the command token", () => {
    expect(normalizeArgv(["--allow-keychain-prompt", "auth"])).toEqual([
      "auth",
      "--allow-keychain-prompt",
    ]);
    expect(normalizeArgv(["--json", "quota"])).toEqual(["quota", "--json"]);
    expect(normalizeArgv(["--check", "update"])).toEqual(["update", "--check"]);
  });

  it("leaves an unknown command for the SDK to reject", () => {
    expect(normalizeArgv(["boguscmd"])).toEqual(["boguscmd"]);
  });
});

describe("CLI quota rendering", () => {
  it("renders live quota when cache persistence fails", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cli-cache-"));
    const blockedCacheRoot = join(tempDir, "cache-root");
    writeFileSync(blockedCacheRoot, "blocker");
    process.env.XDG_CACHE_HOME = blockedCacheRoot;
    PROVIDERS.claude = {
      id: "claude",
      label: "Claude",
      async fetchQuota() {
        return {
          provider: "claude",
          label: "Claude",
          source: "oauth",
          windows: [
            {
              id: "five_hour",
              label: "session",
              kind: "session",
              percentUsed: 10,
              percentRemaining: 90,
            },
          ],
          state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
        };
      },
      async inspectAuth() {
        return { provider: "claude", sources: [] };
      },
    };
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = chunks.join("");
    expect(output).toContain("quota[1]{");
    expect(output).toContain("claude,all_models,90,");
    expect(output).not.toContain("error:");
    expect(process.exitCode).toBeUndefined();
  });

  it("surfaces keychain access advice in TOON when stale quota is blocked by a skipped keychain prompt", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(staleClaudeQuota());
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude,codex"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = chunks.join("");
    // The remedy rides the stale provider's `attention[]` row, and the stale
    // scope gets no `quota[]` row at all.
    expect(output).toContain(
      "attention[3]{provider,scope,kind,detail,remedy}:",
    );
    expect(output).toContain(
      'claude,all,stale,"last refreshed 2026-07-06T18:10:00Z · reason keychain_access_required",quota-axi --allow-keychain-prompt',
    );
    expect(output).toContain(
      "claude,all_models,headroom_unknown,five_hour,none",
    );
    expect(output).not.toMatch(/^ {2}claude,all_models,\d/m);
    expect(output).toContain(
      'Tell your user: run `quota-axi --allow-keychain-prompt` once and approve Keychain access ("Always Allow") so quota-axi can read claude\'s live quota.',
    );
    // Codex still reports headroom; only its selection scalar is blocked.
    expect(output).toContain(
      "codex,all_models,unmeasurable,five_hour blocks spendPriority,none",
    );
    expect(output).not.toContain("codex,all,");
  });

  it("surfaces keychain access advice in JSON when stale quota is blocked by a skipped keychain prompt", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(staleClaudeQuota());
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude,codex", "--json"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = JSON.parse(chunks.join("")) as QuotaAxiResponse;
    const claude = output.providers.find(
      (provider) => provider.provider === "claude",
    );
    const codex = output.providers.find(
      (provider) => provider.provider === "codex",
    );
    expect(output.schemaVersion).toBe(5);
    expect(claude?.state.reason).toBe("keychain_access_required");
    expect(claude?.state.remedyCommand).toBe(
      "quota-axi --allow-keychain-prompt",
    );
    expect(claude?.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "unknown",
          boundedBy: ["five_hour"],
          pace: {
            status: "unknown",
            unknownWindowIds: ["five_hour"],
          },
        },
      ],
    });
    expect(claude?.windows[0]?.pace).toEqual({
      status: "unknown",
      reason: "stale",
    });
    expect(
      claude?.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBeUndefined();
    expect(output.help).toContain(
      'Tell your user: run `quota-axi --allow-keychain-prompt` once and approve Keychain access ("Always Allow") so quota-axi can read claude\'s live quota.',
    );
    expect(codex?.state.reason).toBeUndefined();
    expect(codex?.state.remedyCommand).toBeUndefined();
  });

  it("does not surface keychain access advice when a provider is fresh", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota({
      ...freshClaudeQuota(),
      attempts: [
        {
          source: "keychain",
          status: "skipped",
          error: "keychain_prompt_required",
        },
        { source: "oauth", status: "success" },
      ],
    });
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude,codex", "--json"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = JSON.parse(chunks.join("")) as QuotaAxiResponse;
    expect(output.help).toBeUndefined();
    expect(
      output.providers.find((provider) => provider.provider === "claude")?.state
        .reason,
    ).toBeUndefined();
  });

  it("does not surface keychain access advice when keychain auth is missing", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota({
      ...staleClaudeQuota(),
      attempts: [
        {
          source: "oauth-file",
          status: "skipped",
          error: "credentials_missing",
        },
        { source: "keychain", status: "skipped", error: "credentials_missing" },
      ],
    });
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude,codex", "--json"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = JSON.parse(chunks.join("")) as QuotaAxiResponse;
    expect(output.help).toBeUndefined();
    expect(
      output.providers.find((provider) => provider.provider === "claude")?.state
        .reason,
    ).toBeUndefined();
  });

  it("does not surface keychain access advice without confirmed keychain item presence", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota({
      ...staleClaudeQuota(),
      attempts: [
        {
          source: "oauth-file",
          status: "skipped",
          error: "credentials_missing",
        },
        {
          source: "keychain",
          status: "skipped",
          error: "keychain_prompt_required",
        },
      ],
    });
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude,codex", "--json"],
      binPath: "quota-axi",
      stdout: {
        write(chunk) {
          chunks.push(String(chunk));
          return true;
        },
      },
    });

    const output = JSON.parse(chunks.join("")) as QuotaAxiResponse;
    expect(output.help).toBeUndefined();
    expect(
      output.providers.find((provider) => provider.provider === "claude")?.state
        .reason,
    ).toBeUndefined();
  });

  it("reports effective Fable headroom when its account window is nearly exhausted", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota({
      ...freshClaudeQuota(),
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 9,
          percentRemaining: 91,
        },
        {
          id: "seven_day",
          label: "week",
          kind: "weekly",
          percentUsed: 97,
          percentRemaining: 3,
        },
        {
          id: "model:fable",
          label: "Fable week",
          kind: "model",
          percentUsed: 81,
          percentRemaining: 19,
        },
      ],
    });

    const output = JSON.parse(
      await capture(["--provider", "claude", "--json"]),
    ) as QuotaAxiResponse;
    expect(
      output.providers[0].quotaSemantics?.effectiveAvailability.find(
        ({ scope }) => scope === "model:fable",
      ),
    ).toEqual({
      scope: "model:fable",
      status: "known",
      effectivePercentRemaining: 3,
      boundedBy: ["five_hour", "seven_day", "model:fable"],
      limitingWindowIds: ["seven_day"],
      pace: {
        status: "unknown",
        unknownWindowIds: ["five_hour", "seven_day", "model:fable"],
      },
      runway: {
        status: "unknown",
        unmeasurableWindowIds: ["five_hour", "seven_day", "model:fable"],
      },
      selection: {
        status: "unknown",
        unmeasurableWindowIds: ["five_hour", "seven_day", "model:fable"],
      },
    });
  });

  it("makes effective usable runway primary without hiding reserve diagnostics", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    PROVIDERS.claude = providerWithQuota({
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 99,
          percentRemaining: 1,
          windowSeconds: 18_000,
          resetsAt: "2026-07-15T12:06:00.000Z",
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });
    PROVIDERS.codex = providerWithQuota({
      provider: "codex",
      label: "Codex",
      source: "oauth",
      windows: [
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed: 45,
          percentRemaining: 55,
          windowSeconds: 604_800,
          resetsAt: "2026-07-20T01:12:00.000Z",
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });

    const compact = await capture(["--provider", "claude,codex"]);
    expect(compact).toContain(
      "quota[2]{provider,scope,effectivePercentRemaining,spendPriority,runway,confidence,limitedBy,resetsAt}:",
    );
    expect(compact).toContain(
      'claude,all_models,1,-0.5102,projected_exhaustion,established,five_hour,"2026-07-15T12:06:00.000Z"',
    );
    expect(compact).toContain(
      'codex,all_models,55,-0.4395,projected_exhaustion,established,weekly,"2026-07-20T01:12:00.000Z"',
    );
    // Every finite-runway quota row joins one exhaustion row on provider+scope.
    expect(compact).toContain(
      "exhaustion[2]{provider,scope,usableRunwaySeconds,projectedExhaustedAt,limitingWindowId}:",
    );
    expect(compact).toContain(
      'claude,all_models,178,"2026-07-15T12:02:58.181Z",five_hour',
    );
    expect(compact).toContain(
      'codex,all_models,258720,"2026-07-18T11:52:00.000Z",weekly',
    );
    expect(compact).toContain("attention[0]:");
    expect(compact).not.toContain("windows[");
    expect(compact).not.toContain("worstReserve");

    const full = await capture(["--provider", "claude,codex", "--full"]);
    expect(full).toContain(
      "windows[2]{provider,id,label,percentRemaining,resetsAt,pace,reserve,burnMultiple,timeRemainingPercent,elapsedPercent,cycleSeconds,projectedExhaustedAt,confidence}:",
    );
    expect(full).toContain("scopeAudit[2]{");
    expect(full).toContain("worstReserve");
    expect(full).toMatch(
      /claude,five_hour,session,1,[^\n]*,on_pace,-1,1\.0102,2,98,18000,/,
    );

    const json = JSON.parse(
      await capture(["--provider", "claude,codex", "--json"]),
    ) as QuotaAxiResponse;
    expect(json.providers[0]?.windows[0]?.pace?.reservePercentPoints).toBe(-1);
  });

  it("renders Kimi remaining quota in compact TOON and normalized JSON", async () => {
    useTempCache();
    PROVIDERS.kimi = providerWithQuota(freshKimiQuota());

    const toon = await capture(["--provider", "kimi"]);
    expect(toon).toContain(
      "quota[1]{provider,scope,effectivePercentRemaining,spendPriority,runway,confidence,limitedBy,resetsAt}:",
    );
    expect(toon).toContain(
      'kimi,all_models,67.5,unknown,unknown,unknown,weekly,"2027-02-08T04:05:06.000Z"',
    );
    expect(toon).not.toContain("synthetic-kimi-key");
    expect(toon).not.toMatch(/recommend|prefer provider|switch to/i);

    const fullToon = await capture(["--provider", "kimi", "--full"]);
    expect(fullToon).toContain("kimi,unknown,api,fresh");
    expect(fullToon).toMatch(
      /kimi,five_hour,session,81\.25,"2027-02-03T09:05:06\.000Z",/,
    );
    expect(fullToon).toMatch(
      /kimi,weekly,week,67\.5,"2027-02-08T04:05:06\.000Z",/,
    );

    const json = JSON.parse(
      await capture(["--provider", "kimi", "--json"]),
    ) as QuotaAxiResponse;
    expect(json.schemaVersion).toBe(5);
    expect(json.providers).toEqual([
      expect.objectContaining({
        provider: "kimi",
        windows: [
          expect.objectContaining({
            id: "weekly",
            percentRemaining: 67.5,
            pace: expect.objectContaining({
              status: expect.stringMatching(/^(ahead|on_pace|behind|unknown)$/),
            }),
          }),
          expect.objectContaining({
            id: "five_hour",
            percentRemaining: 81.25,
            pace: expect.objectContaining({
              status: expect.stringMatching(/^(ahead|on_pace|behind|unknown)$/),
            }),
          }),
        ],
        quotaSemantics: expect.objectContaining({
          effectiveAvailability: [
            expect.objectContaining({
              scope: "all_models",
              pace: expect.objectContaining({
                status: expect.stringMatching(
                  /^(ahead|on_pace|behind|mixed|unknown)$/,
                ),
              }),
            }),
          ],
        }),
        state: expect.objectContaining({ status: "fresh", stale: false }),
      }),
    ]);
    expect(json.providers[0].account).toBeUndefined();
    expect(json.providers[0].attempts).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(
      /recommend|prefer provider|switch to|route to/i,
    );
  });

  it("renders the card-grid report for --tui and composes with --provider", async () => {
    useTempCache();
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    const output = await capture(["--tui", "--provider", "codex"]);

    expect(output).toContain("╭─ ● codex ");
    expect(output).toContain("1 live");
    // `--json` demotion happens at the serialiser, so the human report still
    // draws provenance and per-window detail from the full in-memory model.
    expect(output).toContain("cli-rpc");
    expect(output).toContain("session");
    expect(output).not.toContain("claude");
    expect(output).not.toContain("providers[");
    expect(output).not.toContain("\x1b[");
    expect(output).not.toContain("Press q to quit");
    expect(process.exitCode).toBeUndefined();
  });

  it("renders one --tui frame for --once without live control sequences", async () => {
    useTempCache();
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    const output = await capture([
      "--tui",
      "--once",
      "--refresh",
      "1m",
      "--provider",
      "codex",
    ]);

    expect(output).toContain("╭─ ● codex ");
    expect(output).not.toContain("Press q to quit");
    expect(output).not.toContain("\x1b[?1049h");
    expect(process.exitCode).toBeUndefined();
  });
});

describe("default TOON decision blocks", () => {
  it("names every requested provider in quota[] or attention[]", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(freshClaudeQuota());
    PROVIDERS.codex = providerWithQuota({
      ...freshCodexQuota(),
      windows: [],
    });
    PROVIDERS.cursor = providerWithQuota(cursorWithUnfamiliarWindow());
    PROVIDERS.copilot = providerWithQuota(signedOutCopilotQuota());
    PROVIDERS.grok = providerWithQuota(grokModelAuthOnlyQuota());
    PROVIDERS.kimi = providerWithQuota(rateLimitedKimiQuota());
    PROVIDERS.zai = providerWithQuota(freshZaiQuota());
    PROVIDERS.agy = providerWithQuota(unavailableAgyQuota());
    PROVIDERS.kiro = providerWithQuota({
      provider: "kiro",
      label: "Kiro",
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", stale: false, sourcesTried: [] },
    });

    const output = await capture([]);
    const named = new Set([
      ...toonRows(output, "quota").map((row) => row[0]),
      ...toonRows(output, "attention").map((row) => row[0]),
    ]);

    expect([...named].sort()).toEqual([
      "agy",
      "claude",
      "codex",
      "copilot",
      "cursor",
      "grok",
      "kimi",
      "kiro",
      "zai",
    ]);
  });

  it("keeps quota[] rows in provider-declaration order, never metric order", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    PROVIDERS.claude = providerWithQuota(pacedProvider("claude", 90, 10));
    PROVIDERS.codex = providerWithQuota(pacedProvider("codex", 20, 80));

    const declared = await capture(["--provider", "claude,codex"]);
    const reversed = await capture(["--provider", "codex,claude"]);
    const priority = (output: string): number[] =>
      toonRows(output, "quota").map((row) => Number(row[3]));

    expect(toonRows(declared, "quota").map((row) => row[0])).toEqual([
      "claude",
      "codex",
    ]);
    expect(toonRows(reversed, "quota").map((row) => row[0])).toEqual([
      "codex",
      "claude",
    ]);
    // Proves the order is declaration order rather than a coincidental sort:
    // one of the two orderings has to disagree with the metric ordering.
    const declaredPriority = priority(declared);
    expect(declaredPriority).toEqual([...priority(reversed)].reverse());
    expect(declaredPriority).not.toEqual(
      [...declaredPriority].sort((a, b) => b - a),
    );
  });

  it("renders an unmeasurable spendPriority as `unknown`, never as 0", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    // `five_hour` has no cycle evidence, so the scope's scalar is suppressed
    // while its headroom stays known.
    PROVIDERS.claude = providerWithQuota({
      ...freshClaudeQuota(),
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 10,
          percentRemaining: 90,
        },
      ],
    });
    // Exactly linear burn: the scalar is a real 0, a different claim entirely.
    PROVIDERS.codex = providerWithQuota(pacedProvider("codex", 50, 50));

    const output = await capture(["--provider", "claude,codex"]);
    const rows = toonRows(output, "quota");

    expect(rows[0]?.[3]).toBe("unknown");
    expect(rows[1]?.[3]).toBe("0");
    expect(output).toContain(
      "claude,all_models,unmeasurable,five_hour blocks runway + spendPriority,none",
    );
  });

  it("gives a stale scope no quota[] row and names it in attention[]", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(staleClaudeQuota());

    const output = await capture(["--provider", "claude"]);

    expect(output).toContain("quota[0]:");
    expect(toonRows(output, "attention")).toEqual([
      [
        "claude",
        "all",
        "stale",
        "last refreshed 2026-07-06T18:10:00Z · reason keychain_access_required",
        "quota-axi --allow-keychain-prompt",
      ],
      ["claude", "all_models", "headroom_unknown", "five_hour", "none"],
    ]);
  });

  it("keeps exhaustion[] rows only for finite runway scopes", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    PROVIDERS.codex = providerWithQuota(pacedProvider("codex", 50, 50));

    const output = await capture(["--provider", "codex"]);

    expect(toonRows(output, "quota")[0]?.[4]).toBe("through_reset");
    expect(output).toContain("exhaustion[0]:");
  });

  it("keeps unknown-scope exhaustion in attention without an orphan row", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    PROVIDERS.claude = providerWithQuota({
      ...freshClaudeQuota(),
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 100,
          percentRemaining: 0,
          startsAt: "2026-07-15T07:00:00.000Z",
          resetsAt: "2026-07-15T17:00:00.000Z",
        },
        {
          id: "seven_day",
          label: "week",
          kind: "weekly",
          startsAt: "2026-07-12T00:00:00.000Z",
          resetsAt: "2026-07-19T00:00:00.000Z",
        },
      ],
    });

    const output = await capture(["--provider", "claude"]);

    expect(toonRows(output, "quota")).toEqual([]);
    expect(toonRows(output, "exhaustion")).toEqual([]);
    expect(toonRows(output, "attention")).toContainEqual([
      "claude",
      "all_models",
      "headroom_unknown",
      "seven_day · exhausted_now limited by five_hour",
      "none",
    ]);
  });

  it("states a positive auth fact for a provider with no quota[] row", async () => {
    useTempCache();
    PROVIDERS.grok = providerWithQuota(grokModelAuthOnlyQuota());

    const output = await capture(["--provider", "grok"]);

    expect(toonRows(output, "attention")).toEqual([
      [
        "grok",
        "all",
        "unavailable",
        "Grok consumer quota unavailable (auth usable)",
        "none",
      ],
    ]);
  });

  it("surfaces rate-limit, unresolved, and untrusted facts in attention[]", async () => {
    useTempCache();
    PROVIDERS.cursor = providerWithQuota(cursorWithUnfamiliarWindow());
    PROVIDERS.kimi = providerWithQuota(rateLimitedKimiQuota());

    const output = await capture(["--provider", "cursor,kimi"]);
    const kinds = toonRows(output, "attention").map((row) => [row[2], row[3]]);

    expect(kinds).toContainEqual(["unresolved_windows", "new_pool"]);
    expect(kinds).toContainEqual([
      "rate_limited",
      "Kimi rate limited retry after 2026-07-06T19:10:00Z",
    ]);
    expect(kinds).toContainEqual(["untrusted_windows", "unparsed_limit_2"]);
  });

  it("drops the audit blocks and the duplicate selection block", async () => {
    useTempCache();
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());

    const compact = await capture(["--provider", "codex"]);
    const full = await capture(["--provider", "codex", "--full"]);

    expect(compact).not.toContain("providers[");
    expect(compact).not.toContain("windows[");
    expect(compact).not.toContain("scopeAudit[");
    expect(compact).not.toContain("advice[");
    expect(full).toContain("scopeAudit[");
    // The scalar is already the quota row's column.
    expect(full).not.toContain("selection[");
    expect(full).not.toContain("effectivePace[");
    expect(full).not.toContain("windowPace[");
    for (const output of [compact, full]) {
      expect(output).not.toContain("projectionBasis");
    }
  });
});

describe("--json tiering", () => {
  it("demotes derivation inputs without renaming or re-nesting anything", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    PROVIDERS.codex = providerWithQuota(pacedProvider("codex", 40, 60));

    const lean = JSON.parse(
      await capture(["--provider", "codex", "--json"]),
    ) as QuotaAxiResponse;
    const full = JSON.parse(
      await capture(["--provider", "codex", "--json", "--full"]),
    ) as QuotaAxiResponse;

    const leanPaths = fieldPaths(lean);
    const fullPaths = fieldPaths(full);
    // Every retained path keeps its exact name and position.
    expect([...leanPaths].filter((path) => !fullPaths.has(path))).toEqual([]);
    expect(
      [...fullPaths].filter((path) => !leanPaths.has(path)).sort(),
    ).toEqual([
      "providers[].attempts",
      "providers[].attempts[].source",
      "providers[].attempts[].status",
      "providers[].label",
      "providers[].quotaSemantics.description",
      "providers[].quotaSemantics.effectiveAvailability[].pace.behindWindowIds",
      "providers[].source",
      "providers[].state.refreshedAt",
      "providers[].state.sourcesTried",
      "providers[].windows[].pace.cycleBasis",
      "providers[].windows[].pace.cycleSeconds",
      "providers[].windows[].pace.elapsedPercent",
      "providers[].windows[].pace.projectedExhaustedAt",
      "providers[].windows[].pace.projectionConfidence",
      "providers[].windows[].pace.timeRemainingPercent",
      "providers[].windows[].percentUsed",
      "providers[].windows[].startsAt",
      "providers[].windows[].windowSeconds",
    ]);
    expect(full.providers[0]?.quotaSemantics?.description).toContain("Codex");
  });

  it("keeps every eligibility and uncertainty field in the lean tier", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T18:10:00.000Z"));
    PROVIDERS.claude = providerWithQuota(staleClaudeQuota());
    PROVIDERS.cursor = providerWithQuota(cursorWithUnfamiliarWindow());
    PROVIDERS.grok = providerWithQuota(grokModelAuthOnlyQuota());
    PROVIDERS.kimi = providerWithQuota(rateLimitedKimiQuota());

    const json = JSON.parse(
      await capture(["--provider", "claude,cursor,grok,kimi", "--json"]),
    ) as QuotaAxiResponse;
    const [claude, cursor, grok, kimi] = json.providers;

    expect(json.schemaVersion).toBe(5);
    expect(claude?.state).toMatchObject({
      status: "stale",
      stale: true,
      error: "keychain_prompt_required",
      reason: "keychain_access_required",
      remedyCommand: "quota-axi --allow-keychain-prompt",
    });
    const staleScope = claude?.quotaSemantics?.effectiveAvailability[0];
    expect(staleScope?.effectivePercentRemaining).toBeUndefined();
    expect(staleScope?.runway).toEqual({
      status: "unknown",
      unmeasurableWindowIds: ["five_hour"],
    });
    expect(staleScope?.selection).toEqual({
      status: "unknown",
      unmeasurableWindowIds: ["five_hour"],
    });
    expect(claude?.windows[0]?.pace).toEqual({
      status: "unknown",
      reason: "stale",
      reservePercentPoints: undefined,
      burnMultiple: undefined,
    });

    expect(cursor?.quotaSemantics).toMatchObject({
      status: "partial",
      unresolvedWindowIds: ["new_pool"],
    });
    expect(
      cursor?.quotaSemantics?.effectiveAvailability[0]?.pace,
    ).toMatchObject({ aheadWindowIds: ["included_usage"] });

    expect(grok?.state.authStatus).toBe("usable");
    expect(grok?.credits).toEqual({ remaining: 0, unit: "credits" });

    expect(kimi?.state).toMatchObject({
      status: "rate_limited",
      retryAfter: "2026-07-06T19:10:00Z",
      untrustedWindowIds: ["unparsed_limit_2"],
    });
  });
});

describe("CLI plumbing via the axi SDK", () => {
  it("prints the version for -v/--version", async () => {
    for (const flag of ["-v", "--version"]) {
      const chunks = await capture([flag]);
      expect(chunks.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(process.exitCode).toBeUndefined();
    }
  });

  it("prints the top-level help for --help", async () => {
    const output = await capture(["--help"]);
    expect(output).toContain("usage: quota-axi [quota|auth|models] [flags]");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the top-level help for legacy -h", async () => {
    const output = await capture(["auth", "-h"]);
    expect(output).toContain("usage: quota-axi [quota|auth|models] [flags]");
    expect(process.exitCode).toBeUndefined();
  });

  it("routes flag-before-auth invocations to auth", async () => {
    PROVIDERS.claude = providerWithAuth("claude", "Claude");
    PROVIDERS.codex = providerWithAuth("codex", "Codex");
    PROVIDERS.cursor = providerWithAuth("cursor", "Cursor");
    PROVIDERS.copilot = providerWithAuth("copilot", "GitHub Copilot");
    PROVIDERS.grok = providerWithAuth("grok", "Grok");
    PROVIDERS.kimi = providerWithAuth("kimi", "Kimi");
    PROVIDERS.zai = providerWithAuth("zai", "Z.AI");
    PROVIDERS.agy = providerWithAuth("agy", "Antigravity");

    const output = await capture(["--allow-keychain-prompt", "auth"]);
    expect(output).toContain(
      "Inspect local quota auth sources without printing secret values",
    );
    expect(output).not.toContain("unknown argument");
    expect(process.exitCode).toBeUndefined();
  });

  it("frames unknown flags as a validation error with exit code 2", async () => {
    const output = await capture(["--bogus"]);
    expect(output).toContain("unknown argument: --bogus");
    expect(output).toContain("code: VALIDATION_ERROR");
    expect(process.exitCode).toBe(2);
  });

  it("frames unknown commands as a validation error with exit code 2", async () => {
    const output = await capture(["boguscmd"]);
    expect(output).toContain("Unknown command: boguscmd");
    expect(process.exitCode).toBe(2);
  });
});

describe("response redaction", () => {
  it("hides account identity and attempts unless --full is set", () => {
    const response: QuotaAxiResponse = {
      generatedAt: "2026-07-06T18:10:00Z",
      schemaVersion: 5,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          source: "oauth",
          account: { email: "person@example.invalid" },
          windows: [],
          state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
          attempts: [{ source: "oauth", status: "success" }],
        },
      ],
    };

    expect(
      redactedResponse(response, false).providers[0].account,
    ).toBeUndefined();
    expect(
      redactedResponse(response, false).providers[0].attempts,
    ).toBeUndefined();
    expect(redactedResponse(response, true).providers[0].account?.email).toBe(
      "person@example.invalid",
    );
  });
});

async function capture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath: "quota-axi",
    stdout: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  });
  return chunks.join("");
}

function providerWithQuota(quota: ProviderQuota): ProviderAdapter {
  return {
    id: quota.provider,
    label: quota.label,
    async fetchQuota() {
      return quota;
    },
    async inspectAuth() {
      return { provider: quota.provider, sources: [] };
    },
  };
}

function providerWithAuth(
  provider: ProviderQuota["provider"],
  label: string,
): ProviderAdapter {
  return {
    id: provider,
    label,
    async fetchQuota() {
      throw new Error("unexpected quota fetch");
    },
    async inspectAuth() {
      return {
        provider,
        sources: [{ source: "test", status: "available" }],
      };
    },
  };
}

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-cli-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

function freshClaudeQuota(): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source: "oauth",
    plan: "pro",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 10,
        percentRemaining: 90,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["oauth"],
    },
    attempts: [{ source: "oauth", status: "success" }],
  };
}

function staleClaudeQuota(): ProviderQuota {
  return {
    ...freshClaudeQuota(),
    source: "cache",
    state: {
      status: "stale",
      stale: true,
      refreshedAt: "2026-07-06T18:10:00Z",
      error: "keychain_prompt_required",
      sourcesTried: ["oauth-file", "keychain", "cache"],
    },
    attempts: [
      {
        source: "oauth-file",
        status: "skipped",
        error: "credentials_missing",
      },
      {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
    ],
  };
}

function freshKimiQuota(): ProviderQuota {
  return {
    provider: "kimi",
    label: "Kimi",
    source: "api",
    windows: [
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 32.5,
        percentRemaining: 67.5,
        resetsAt: "2027-02-08T04:05:06.000Z",
        windowSeconds: 604_800,
      },
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 18.75,
        percentRemaining: 81.25,
        resetsAt: "2027-02-03T09:05:06.000Z",
        windowSeconds: 18_000,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2027-02-03T04:05:06.000Z",
      sourcesTried: ["pi:kimi-coding"],
    },
    attempts: [{ source: "pi:kimi-coding", status: "success" }],
  };
}

/** Parse the rows of one published TOON block, honoring quoted cells. */
function toonRows(output: string, block: string): string[][] {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${block}[`));
  if (start === -1) throw new Error(`missing TOON block: ${block}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    rows.push(splitToonRow(line.trim()));
  }
  return rows;
}

function splitToonRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of row) {
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      cells.push(current);
      current = "";
    } else current += character;
  }
  cells.push(current);
  return cells;
}

/** Every populated field path, with array indices collapsed to `[]`. */
function fieldPaths(value: unknown, prefix = ""): Set<string> {
  const paths = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const path of fieldPaths(item, `${prefix}[]`)) paths.add(path);
    }
    return paths;
  }
  if (value === null || typeof value !== "object") return paths;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    paths.add(path);
    for (const nested of fieldPaths(item, path)) paths.add(nested);
  }
  return paths;
}

/**
 * A single weekly window at a chosen usage split, halfway through its cycle,
 * so pace, runway, and the selection scalar are all well defined.
 */
function pacedProvider(
  provider: "claude" | "codex",
  percentUsed: number,
  percentRemaining: number,
): ProviderQuota {
  return {
    provider,
    label: provider === "claude" ? "Claude" : "Codex",
    source: "oauth",
    plan: "pro",
    windows: [
      {
        id: provider === "claude" ? "seven_day" : "weekly",
        label: "week",
        kind: "weekly",
        percentUsed,
        percentRemaining,
        windowSeconds: 604_800,
        startsAt: "2026-07-12T00:00:00.000Z",
        resetsAt: "2026-07-19T00:00:00.000Z",
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-15T12:00:00.000Z",
      sourcesTried: ["oauth"],
    },
    attempts: [{ source: "oauth", status: "success" }],
  };
}

function cursorWithUnfamiliarWindow(): ProviderQuota {
  return {
    provider: "cursor",
    label: "Cursor",
    source: "api",
    plan: "pro",
    windows: [
      {
        id: "included_usage",
        label: "included usage",
        kind: "monthly",
        percentUsed: 80,
        percentRemaining: 20,
        startsAt: "2026-06-15T12:00:00.000Z",
        resetsAt: "2026-07-15T12:00:00.000Z",
      },
      {
        id: "new_pool",
        label: "new pool",
        kind: "unknown",
        percentUsed: 5,
        percentRemaining: 95,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["state-vscdb"],
    },
  };
}

function signedOutCopilotQuota(): ProviderQuota {
  return {
    provider: "copilot",
    label: "GitHub Copilot",
    source: "unavailable",
    windows: [],
    state: {
      status: "auth_required",
      stale: false,
      error: "GitHub Copilot sign-in required",
      authStatus: "unusable",
      sourcesTried: ["apps-json"],
    },
  };
}

/** Pi xAI establishes model auth while consumer credit windows stay unreadable. */
function grokModelAuthOnlyQuota(): ProviderQuota {
  return {
    provider: "grok",
    label: "Grok",
    source: "unavailable",
    windows: [],
    credits: { remaining: 0, unit: "credits" },
    state: {
      status: "unavailable",
      stale: false,
      error: "Grok consumer quota unavailable",
      authStatus: "usable",
      sourcesTried: ["web", "pi:xai"],
    },
  };
}

function rateLimitedKimiQuota(): ProviderQuota {
  return {
    provider: "kimi",
    label: "Kimi",
    source: "unavailable",
    windows: [],
    state: {
      status: "rate_limited",
      stale: false,
      error: "Kimi rate limited",
      retryAfter: "2026-07-06T19:10:00Z",
      untrustedWindowIds: ["unparsed_limit_2"],
      sourcesTried: ["pi:kimi-coding"],
    },
  };
}

function freshCodexQuota(): ProviderQuota {
  return {
    provider: "codex",
    label: "Codex",
    source: "cli-rpc",
    plan: "pro",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 0,
        percentRemaining: 100,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["cli-rpc"],
    },
    attempts: [{ source: "cli-rpc", status: "success" }],
  };
}

function freshZaiQuota(): ProviderQuota {
  return {
    provider: "zai",
    label: "Z.AI",
    source: "api",
    plan: "GLM Coding Max",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 10,
        percentRemaining: 90,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 20,
        percentRemaining: 80,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["opencode:auth.json"],
    },
    attempts: [{ source: "opencode:auth.json", status: "success" }],
  };
}

function unavailableAgyQuota(): ProviderQuota {
  return {
    provider: "agy",
    label: "Antigravity",
    source: "unavailable",
    windows: [],
    state: {
      status: "unavailable",
      stale: false,
      error: "Antigravity/agy is not running",
      sourcesTried: ["loopback"],
    },
  };
}
