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
    ]);
  });

  it("scopes comma-separated providers", () => {
    expect(parseFlags(["--provider", "claude"]).providers).toEqual(["claude"]);
    expect(
      parseFlags(["--provider=cursor,copilot,grok,kimi"]).providers,
    ).toEqual(["cursor", "copilot", "grok", "kimi"]);
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
    expect(output).toContain("providers[1]");
    expect(output).toContain("claude,unknown,oauth,fresh");
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
    expect(output).toContain("advice[1]{provider,reason,remedyCommand}:");
    expect(output).toContain(
      "claude,keychain_access_required,quota-axi --allow-keychain-prompt",
    );
    expect(output).toContain(
      'Tell your user: run `quota-axi --allow-keychain-prompt` once and approve Keychain access ("Always Allow") so quota-axi can read claude\'s live quota.',
    );
    expect(output).not.toContain("codex,keychain_access_required");
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
    expect(output.schemaVersion).toBe(3);
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
      "windows[2]{provider,id,label,percentRemaining,resetsAt,pace,state}:",
    );
    expect(compact).toContain(
      "effective[2]{provider,scope,effectivePercentRemaining,boundedBy,limitingWindowIds,runway,usableRunwaySeconds,projectedExhaustedAt,limitingWindowId,projectionConfidence,projectionBasis,unmeasurableWindowIds,unresolvedWindowIds,relationshipStatus}:",
    );
    expect(compact).toContain(
      'claude,all_models,1,five_hour,five_hour,projected_exhaustion,178,"2026-07-15T12:02:58.181Z",five_hour,established,cycle_average,none,none,known',
    );
    expect(compact).toContain(
      'codex,all_models,55,weekly,weekly,projected_exhaustion,258720,"2026-07-18T11:52:00.000Z",weekly,established,cycle_average,none,none,known',
    );
    expect(compact).not.toContain("windowPace[");
    expect(compact).not.toContain("worstReserve");

    const full = await capture(["--provider", "claude,codex", "--full"]);
    expect(full).toContain(
      "windowPace[2]{provider,id,reserve,burnMultiple,projectedExhaustedAt,projectionConfidence,projectionBasis}:",
    );
    expect(full).toContain("claude,five_hour,-1,1.0102");

    const json = JSON.parse(
      await capture(["--provider", "claude,codex", "--json"]),
    ) as QuotaAxiResponse;
    expect(json.providers[0]?.windows[0]?.pace?.reservePercentPoints).toBe(-1);
  });

  it("renders Kimi remaining quota in compact TOON and normalized JSON", async () => {
    useTempCache();
    PROVIDERS.kimi = providerWithQuota(freshKimiQuota());

    const toon = await capture(["--provider", "kimi"]);
    expect(toon).toContain("kimi,unknown,api,fresh");
    expect(toon).toContain(
      "windows[2]{provider,id,label,percentRemaining,resetsAt,pace,state}:",
    );
    expect(toon).toMatch(
      /kimi,five_hour,session,81\.25,"2027-02-03T09:05:06\.000Z",[^,]+,fresh/,
    );
    expect(toon).toMatch(
      /kimi,weekly,week,67\.5,"2027-02-08T04:05:06\.000Z",[^,]+,fresh/,
    );
    expect(toon).toContain(
      "effective[1]{provider,scope,effectivePercentRemaining,boundedBy,limitingWindowIds,runway,usableRunwaySeconds,projectedExhaustedAt,limitingWindowId,projectionConfidence,projectionBasis,unmeasurableWindowIds,unresolvedWindowIds,relationshipStatus}:",
    );
    expect(toon).not.toContain("synthetic-kimi-key");
    expect(toon).not.toMatch(/recommend|prefer provider|switch to/i);

    const json = JSON.parse(
      await capture(["--provider", "kimi", "--json"]),
    ) as QuotaAxiResponse;
    expect(json.schemaVersion).toBe(3);
    expect(json.providers).toEqual([
      expect.objectContaining({
        provider: "kimi",
        label: "Kimi",
        source: "api",
        windows: [
          expect.objectContaining({
            id: "weekly",
            percentRemaining: 67.5,
            windowSeconds: 604_800,
            pace: expect.objectContaining({
              status: expect.stringMatching(/^(ahead|on_pace|behind|unknown)$/),
            }),
          }),
          expect.objectContaining({
            id: "five_hour",
            percentRemaining: 81.25,
            windowSeconds: 18_000,
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

  it("renders Z.AI model and MCP tool scopes in compact TOON and normalized JSON", async () => {
    useTempCache();
    PROVIDERS.zai = providerWithQuota(freshZaiQuota());

    const toon = await capture(["--provider", "zai"]);
    expect(toon).toContain("zai,pro,api,fresh");
    expect(toon).toMatch(
      /zai,five_hour,session,47,"2026-08-17T09:05:06\.000Z",[^,]+,fresh/,
    );
    expect(toon).toMatch(
      /zai,weekly,week,89,"2026-08-20T02:03:28\.999Z",[^,]+,fresh/,
    );
    expect(toon).toMatch(/zai,mcp_monthly,mcp tools,100,/);
    expect(toon).not.toContain("synthetic-zai-key");

    const json = JSON.parse(
      await capture(["--provider", "zai", "--json"]),
    ) as QuotaAxiResponse;
    expect(json.providers[0].quotaSemantics).toMatchObject({
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: 47,
          boundedBy: ["five_hour", "weekly"],
          limitingWindowIds: ["five_hour"],
        },
        {
          scope: "mcp_tools",
          status: "known",
          effectivePercentRemaining: 100,
          boundedBy: ["mcp_monthly"],
        },
      ],
    });
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
      schemaVersion: 3,
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

function freshZaiQuota(): ProviderQuota {
  return {
    provider: "zai",
    label: "Z.AI",
    source: "api",
    plan: "pro",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 53,
        percentRemaining: 47,
        resetsAt: "2026-08-17T09:05:06.000Z",
        windowSeconds: 18_000,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 11,
        percentRemaining: 89,
        resetsAt: "2026-08-20T02:03:28.999Z",
        windowSeconds: 604_800,
      },
      {
        id: "mcp_monthly",
        label: "mcp tools",
        kind: "monthly",
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: "2026-09-14T02:03:28.999Z",
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-08-17T04:05:06.000Z",
      sourcesTried: ["pi:zai"],
    },
    attempts: [{ source: "pi:zai", status: "success" }],
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
