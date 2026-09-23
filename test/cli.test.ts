import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFlags, parseModelsFlags } from "../src/args.js";
import { main, normalizeArgv } from "../src/cli.js";
import { authCommand, quotaCommand } from "../src/commands.js";
import { PROVIDERS } from "../src/providers/index.js";
import { redactedResponse } from "../src/render.js";
import type {
  ProviderAdapter,
  ProviderOptions,
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
const originalAlibabaProvider = PROVIDERS.alibaba;
const originalOpenCodeGoProvider = PROVIDERS["opencode-go"];
const originalCommandCodeProvider = PROVIDERS.commandcode;
const originalMinimaxProvider = PROVIDERS.minimax;
const originalMimoProvider = PROVIDERS.mimo;
const originalDeepSeekProvider = PROVIDERS.deepseek;
const originalOpenRouterProvider = PROVIDERS.openrouter;
const originalElevenLabsProvider = PROVIDERS.elevenlabs;
const originalDevinProvider = PROVIDERS.devin;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const originalMinimaxApiKey = process.env.MINIMAX_API_KEY;
const originalMimoApiKey = process.env.MIMO_API_KEY;
const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalMmxConfigDir = process.env.MMX_CONFIG_DIR;
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
  PROVIDERS.alibaba = originalAlibabaProvider;
  PROVIDERS["opencode-go"] = originalOpenCodeGoProvider;
  PROVIDERS.commandcode = originalCommandCodeProvider;
  PROVIDERS.minimax = originalMinimaxProvider;
  PROVIDERS.mimo = originalMimoProvider;
  PROVIDERS.deepseek = originalDeepSeekProvider;
  PROVIDERS.openrouter = originalOpenRouterProvider;
  PROVIDERS.elevenlabs = originalElevenLabsProvider;
  PROVIDERS.devin = originalDevinProvider;
  vi.unstubAllGlobals();
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  restoreEnvironment("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
  restoreEnvironment("CODEX_HOME", originalCodexHome);
  restoreEnvironment("MINIMAX_API_KEY", originalMinimaxApiKey);
  restoreEnvironment("MIMO_API_KEY", originalMimoApiKey);
  restoreEnvironment("DEEPSEEK_API_KEY", originalDeepSeekApiKey);
  restoreEnvironment("OPENROUTER_API_KEY", originalOpenRouterApiKey);
  restoreEnvironment("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
  restoreEnvironment("MMX_CONFIG_DIR", originalMmxConfigDir);
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
      "alibaba",
      "opencode-go",
      "commandcode",
      "minimax",
      "mimo",
      "deepseek",
      "openrouter",
      "elevenlabs",
      "devin",
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

  it("accumulates repeated --provider flags in first-seen order", () => {
    expect(
      parseFlags(["--provider", "zai", "--provider", "codex"]).providers,
    ).toEqual(["zai", "codex"]);
    expect(parseFlags(["--provider", "zai,codex"]).providers).toEqual([
      "zai",
      "codex",
    ]);
    expect(
      parseFlags([
        "--provider",
        "codex",
        "--provider=zai,codex",
        "--provider",
        "claude",
      ]).providers,
    ).toEqual(["codex", "zai", "claude"]);
    expect(
      parseFlags(["--provider", "zai", "--provider", "zai"]).providers,
    ).toEqual(["zai"]);
    expect(
      parseFlags(["--provider", "zai", "--provider", "codex"])
        .explicitProviders,
    ).toBe(true);
    expect(
      parseModelsFlags(["--provider", "claude", "--provider", "kimi"])
        .providers,
    ).toEqual(["claude", "kimi"]);
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
          "alibaba",
          "opencode-go",
          "commandcode",
          "minimax",
          "mimo",
          "deepseek",
          "openrouter",
          "elevenlabs",
          "devin",
        ],
        json: true,
        full: true,
        explicitProviders: false,
        tui: false,
        once: false,
        all: false,
        allowKeychainPrompt: true,
        allowClaudeInference: false,
        noCredentialRefresh: false,
        profileOnly: false,
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

  it("parses --all for the human report and notes an explicit provider scope", () => {
    expect(parseFlags(["--tui", "--all"]).all).toBe(true);
    expect(parseFlags(["--tui"]).all).toBe(false);
    expect(parseFlags(["--provider", "zai"]).explicitProviders).toBe(true);
    expect(parseFlags(["--provider=zai,codex"]).explicitProviders).toBe(true);
    expect(parseFlags([]).explicitProviders).toBe(false);
  });

  it("rejects --all without --tui", async () => {
    expect(() => parseFlags(["--all"])).toThrow(
      "--all is only supported with --tui",
    );
    expect(() => parseModelsFlags(["--all"])).toThrow(
      "--all is only supported with --tui",
    );
    await expect(
      authCommand(["--all"], { binPath: "quota-axi" }),
    ).rejects.toThrow("--all is only supported with --tui");
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

  it("opts out of delegated credential refresh", () => {
    expect(parseFlags([]).noCredentialRefresh).toBe(false);
    expect(parseFlags(["--no-credential-refresh"]).noCredentialRefresh).toBe(
      true,
    );
    expect(
      parseModelsFlags(["--no-credential-refresh"]).noCredentialRefresh,
    ).toBe(true);
  });

  it("parses profile-only mode and rejects it for models", () => {
    expect(
      parseFlags(["--provider", "claude", "--profile-only"]).profileOnly,
    ).toBe(true);
    expect(() => parseModelsFlags(["--profile-only"])).toThrow(
      "--profile-only is only supported by the quota command",
    );
  });
});

describe("delegated credential refresh wiring", () => {
  function recordingProvider(seen: ProviderOptions[]): ProviderAdapter {
    return {
      id: "claude",
      label: "Claude",
      async fetchQuota(options) {
        seen.push(options);
        return {
          provider: "claude",
          label: "Claude",
          source: "unavailable",
          windows: [],
          state: {
            status: "error",
            stale: false,
            error: "fixture",
            sourcesTried: [],
          },
        };
      },
      async inspectAuth(options) {
        seen.push(options);
        return { provider: "claude", sources: [] };
      },
    };
  }

  it("lets the quota path delegate refresh by default and opts out on request", async () => {
    const seen: ProviderOptions[] = [];
    PROVIDERS.claude = recordingProvider(seen);

    await quotaCommand(["--provider", "claude"], undefined);
    await quotaCommand(
      ["--provider", "claude", "--no-credential-refresh"],
      undefined,
    );

    expect(seen.map((options) => options.refreshCredentials)).toEqual([
      true,
      false,
    ]);
  });

  it("passes the explicit Claude inference opt-in only when requested", async () => {
    const seen: ProviderOptions[] = [];
    PROVIDERS.claude = recordingProvider(seen);

    await quotaCommand(["--provider", "claude"], undefined);
    await quotaCommand(
      ["--provider", "claude", "--allow-claude-inference"],
      undefined,
    );

    expect(seen[0]?.allowClaudeInference).toBeUndefined();
    expect(seen[1]?.allowClaudeInference).toBe(true);
  });

  it("rejects recurring or unrelated Claude inference opt-ins", async () => {
    await expect(
      quotaCommand(
        ["--provider", "claude", "--tui", "--allow-claude-inference"],
        undefined,
      ),
    ).rejects.toThrow("requires --once with --tui");
    await expect(
      quotaCommand(
        ["--provider", "codex", "--allow-claude-inference"],
        undefined,
      ),
    ).rejects.toThrow("requires the claude provider");
    await expect(
      authCommand(
        ["--provider", "claude", "--allow-claude-inference"],
        undefined,
      ),
    ).rejects.toThrow("only supported by the quota command");
  });

  it("never delegates a refresh from the read-only auth report", async () => {
    const seen: ProviderOptions[] = [];
    PROVIDERS.claude = recordingProvider(seen);

    await authCommand(["--provider", "claude"], undefined);

    expect(seen).toEqual([
      { allowKeychainPrompt: false, refreshCredentials: false },
    ]);
  });

  it("wires profile-only mode without refresh or Keychain access", async () => {
    const seen: ProviderOptions[] = [];
    PROVIDERS.claude = recordingProvider(seen);
    process.env.CLAUDE_CONFIG_DIR = "/explicit/claude-profile";

    await quotaCommand(["--provider", "claude", "--profile-only"], undefined);

    expect(seen).toEqual([
      {
        allowKeychainPrompt: false,
        refreshCredentials: false,
        credentialMode: "profile-only",
      },
    ]);
  });

  it("rejects invalid profile-only scopes before provider I/O", async () => {
    const seen: ProviderOptions[] = [];
    PROVIDERS.claude = recordingProvider(seen);

    await expect(quotaCommand(["--profile-only"], undefined)).rejects.toThrow(
      "--profile-only requires exactly one --provider selector",
    );
    await expect(
      quotaCommand(["--provider", "claude,codex", "--profile-only"], undefined),
    ).rejects.toThrow(
      "--profile-only requires exactly one --provider selector",
    );
    await expect(
      quotaCommand(["--provider", "cursor", "--profile-only"], undefined),
    ).rejects.toThrow("--profile-only does not support provider: cursor");
    await expect(
      authCommand(["--provider", "claude", "--profile-only"], undefined),
    ).rejects.toThrow("--profile-only is only supported by the quota command");
    delete process.env.CLAUDE_CONFIG_DIR;
    await expect(
      quotaCommand(["--provider", "claude", "--profile-only"], undefined),
    ).rejects.toThrow(
      "--profile-only with --provider claude requires explicit CLAUDE_CONFIG_DIR",
    );
    process.env.CLAUDE_CONFIG_DIR = "   ";
    await expect(
      quotaCommand(["--provider", "claude", "--profile-only"], undefined),
    ).rejects.toThrow(
      "--profile-only with --provider claude requires explicit CLAUDE_CONFIG_DIR",
    );
    delete process.env.CODEX_HOME;
    await expect(
      quotaCommand(["--provider", "codex", "--profile-only"], undefined),
    ).rejects.toThrow(
      "--profile-only with --provider codex requires explicit CODEX_HOME",
    );
    expect(seen).toEqual([]);
  });
});

describe("argv normalization", () => {
  it("prefixes the implicit quota command onto a bare invocation", () => {
    expect(normalizeArgv([])).toEqual(["quota"]);
  });

  it("routes leading flags to the quota command", () => {
    expect(normalizeArgv(["--json"])).toEqual(["quota", "--json"]);
    expect(normalizeArgv(["--", "--provider", "agy"])).toEqual([
      "quota",
      "--provider",
      "agy",
    ]);
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
  it("bypasses cache persistence only in profile-only mode", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-profile-cache-"));
    process.env.XDG_CACHE_HOME = tempDir;
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, "claude-profile");
    PROVIDERS.claude = providerWithQuota(freshClaudeQuota());
    const cachePath = join(tempDir, "quota-axi", "quotas.json");

    await quotaCommand(["--provider", "claude", "--profile-only"], undefined);
    expect(existsSync(cachePath)).toBe(false);

    await quotaCommand(["--provider", "claude"], undefined);
    expect(existsSync(cachePath)).toBe(true);
  });

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
      'claude,all,stale,"last refreshed 2026-07-06T18:10:00Z · keychain_prompt_required · reason keychain_access_required",quota-axi --allow-keychain-prompt',
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

  it("advertises the inference opt-in when the env token's scope denial is the final Claude failure", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(envScopeDeniedClaudeQuota());
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude", "--json"],
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
    expect(claude?.state).toMatchObject({
      status: "unavailable",
      authStatus: "usable",
      error: "claude_env_usage_scope_unavailable",
      reason: "inference_opt_in_required",
      remedyCommand: "quota-axi --provider claude --allow-claude-inference",
    });
    expect(claude?.windows).toEqual([]);
    expect(output.help).toHaveLength(1);
    expect(output.help?.[0]).toContain(
      "`quota-axi --provider claude --allow-claude-inference`",
    );
    expect(output.help?.[0]).toMatch(/inference/);
    expect(output.help?.[0]).toMatch(/never does this by default/);
  });

  it("prefers the inference opt-in over Keychain advice when the env scope denial ended discovery", async () => {
    useTempCache();
    const macos = envScopeDeniedClaudeQuota();
    macos.state.sourcesTried = ["oauth-file", "keychain", "env"];
    macos.attempts = [
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
      ...(macos.attempts ?? []),
    ];
    PROVIDERS.claude = providerWithQuota(macos);
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude", "--json"],
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
    expect(claude?.state).toMatchObject({
      reason: "inference_opt_in_required",
      remedyCommand: "quota-axi --provider claude --allow-claude-inference",
    });
    expect(output.help).toHaveLength(1);
    expect(output.help?.[0]).not.toContain("--allow-keychain-prompt");
  });

  it("never falls back to Keychain advice after the opt-in native run fails", async () => {
    useTempCache();
    const macos = envScopeDeniedClaudeQuota();
    macos.state.error = "claude_native_quota_unavailable";
    macos.state.sourcesTried = [
      "oauth-file",
      "keychain",
      "env",
      "claude-native-inference",
    ];
    macos.attempts = [
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
      ...(macos.attempts ?? []),
      {
        source: "claude-native-inference",
        status: "failed",
        error: "claude_native_quota_unavailable",
        degraded: false,
      },
    ];
    PROVIDERS.claude = providerWithQuota(macos);
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude", "--json"],
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
    expect(claude?.state.error).toBe("claude_native_quota_unavailable");
    expect(claude?.state.reason).toBeUndefined();
    expect(claude?.state.remedyCommand).toBeUndefined();
    expect(output.help).toBeUndefined();
  });

  it("renders a native 429's observed windows as quota and exhaustion rows beside the rate limit", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(nativeRateLimitedClaudeQuota());

    const toon = await capture(["--provider", "claude"]);
    const quota = toonRows(toon, "quota");
    expect(quota).toHaveLength(1);
    expect(quota[0]?.slice(0, 3)).toEqual(["claude", "all_models", "0"]);
    expect(toonRows(toon, "exhaustion").map((row) => row.slice(0, 2))).toEqual([
      ["claude", "all_models"],
    ]);
    expect(toonRows(toon, "attention")).toContainEqual([
      "claude",
      "all",
      "rate_limited",
      "claude_native_rate_limited retry after 2026-09-19T06:01:00.000Z",
      "none",
    ]);

    const json = JSON.parse(
      await capture(["--provider", "claude", "--json", "--full"]),
    ) as QuotaAxiResponse;
    const claude = json.providers[0];
    expect(claude?.source).toBe("cli");
    expect(claude?.state).toMatchObject({
      status: "rate_limited",
      stale: false,
      authStatus: "usable",
      retryAfter: "2026-09-19T06:01:00.000Z",
    });
    expect(claude?.windows.map((window) => window.percentUsed)).toEqual([100]);
    expect(
      claude?.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBe(0);
    expect(existsSync(join(process.env.XDG_CACHE_HOME!, "quota-axi"))).toBe(
      false,
    );
  });

  it("renders the inference opt-in remedy on the TOON attention row", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(envScopeDeniedClaudeQuota());
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
    expect(output).toContain(
      "claude,all,unavailable,claude_env_usage_scope_unavailable · reason inference_opt_in_required (auth usable),quota-axi --provider claude --allow-claude-inference",
    );
    expect(output).toContain(
      "Running `quota-axi --provider claude --allow-claude-inference` once",
    );
    expect(output).not.toMatch(/^ {2}claude,all_models,\d/m);
  });

  it("does not re-advertise the inference opt-in once the native fallback was attempted", async () => {
    useTempCache();
    const attempted = envScopeDeniedClaudeQuota();
    attempted.state.error = "claude_native_quota_unavailable";
    attempted.attempts = [
      ...(attempted.attempts ?? []),
      {
        source: "claude-native-inference",
        status: "failed",
        error: "claude_native_quota_unavailable",
        degraded: false,
      },
    ];
    PROVIDERS.claude = providerWithQuota(attempted);
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude", "--json"],
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
    expect(claude?.state.reason).toBeUndefined();
    expect(claude?.state.remedyCommand).toBeUndefined();
    expect(output.help).toBeUndefined();
  });

  it("does not advertise the inference opt-in for a stored credential's 403", async () => {
    useTempCache();
    const stored = envScopeDeniedClaudeQuota();
    stored.state.error = "Claude quota unavailable (403)";
    stored.state.authStatus = undefined;
    stored.attempts = [
      {
        source: "oauth-file",
        status: "failed",
        error: "Claude quota unavailable (403)",
      },
    ];
    PROVIDERS.claude = providerWithQuota(stored);
    const chunks: string[] = [];

    await main({
      argv: ["--provider", "claude", "--json"],
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
    expect(claude?.state.reason).toBeUndefined();
    expect(claude?.state.remedyCommand).toBeUndefined();
    expect(output.help).toBeUndefined();
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

  it("names a used-share window in attention[] without a code quota[] row", async () => {
    useTempCache();
    PROVIDERS.kimi = providerWithQuota({
      ...freshKimiQuota(),
      windows: [
        ...freshKimiQuota().windows,
        {
          id: "month_total",
          label: "month",
          kind: "monthly",
          percentUsed: 40,
          percentRemaining: 60,
          resetsAt: "2027-03-01T00:00:00.000Z",
        },
        {
          id: "month_code",
          label: "code month",
          kind: "monthly",
          percentUsed: 25,
          shareOf: "month_total",
          resetsAt: "2027-03-01T00:00:00.000Z",
        },
      ],
    });

    const toon = await capture(["--provider", "kimi"]);
    expect(toonRows(toon, "attention")).toContainEqual([
      "kimi",
      "all",
      "share",
      "month_code of month_total · 25",
      "none",
    ]);
    expect(toonRows(toon, "quota").map((row) => row[1])).toEqual([
      "all_models",
    ]);
    expect(toon).not.toMatch(/kimi,code[_,]/);

    const json = JSON.parse(
      await capture(["--provider", "kimi", "--json"]),
    ) as QuotaAxiResponse;
    const monthCode = json.providers[0]?.windows.find(
      (window) => window.id === "month_code",
    );
    expect(monthCode?.shareOf).toBe("month_total");
    expect(monthCode?.percentRemaining).toBeUndefined();
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

describe("human report folding for providers that are not set up", () => {
  /**
   * One live provider, one whose credential is present behind a prompt, a
   * Copilot whose only credential is a keyring-stored GitHub CLI login, and
   * every other provider with nothing set up at all. Antigravity, Alibaba, and
   * Command Code carry the attempts their real adapters record when nothing is
   * installed or configured, each wording absence its own way.
   */
  function stubFoldFleet(): void {
    useTempCache();
    for (const id of Object.keys(PROVIDERS) as ProviderQuota["provider"][]) {
      PROVIDERS[id] = providerWithQuota(notSetUpQuota(id));
    }
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    PROVIDERS.claude = providerWithQuota({
      ...notSetUpQuota("claude"),
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
    });
    PROVIDERS.copilot = {
      ...providerWithQuota({
        ...notSetUpQuota("copilot"),
        attempts: [
          {
            source: "apps-json",
            status: "skipped",
            error: "credentials_missing",
          },
          {
            source: "gh:hosts.yml",
            status: "skipped",
            error: "credentials_keyring_storage",
            credentialPresent: true,
          },
        ],
      }),
      incidentalSources: ["gh:hosts.yml"],
    };
    PROVIDERS.agy = providerWithQuota({
      ...notSetUpQuota("agy"),
      state: {
        status: "unavailable",
        stale: false,
        error: "Antigravity/agy is not running",
      },
      attempts: [
        {
          source: "cli",
          status: "skipped",
          error: "agy CLI is not installed",
          degraded: false,
        },
        {
          source: "loopback",
          status: "skipped",
          error: "Antigravity/agy is not running",
          degraded: false,
        },
      ],
    });
    PROVIDERS.alibaba = providerWithQuota({
      ...notSetUpQuota("alibaba"),
      state: {
        status: "unavailable",
        stale: false,
        error: "bl_cli_unavailable",
      },
      attempts: [
        { source: "bl-cli", status: "skipped", error: "bl_cli_unavailable" },
      ],
    });
    PROVIDERS.commandcode = providerWithQuota({
      ...notSetUpQuota("commandcode"),
      attempts: [
        "pi:commandcode",
        "env:COMMAND_CODE_API_KEY",
        "env:COMMANDCODE_API_KEY",
        "commandcode-cli",
        "omp:commandcode",
      ].map((source) => ({
        source,
        status: "skipped",
        error: "commandcode_sign_in_required",
      })),
    });
  }

  it("folds them into one footer line, reading each adapter's incidental sources", async () => {
    stubFoldFleet();
    const output = await capture(["--tui", "--once"]);

    expect(output.trimEnd().split("\n").slice(-3)).toEqual([
      "  ○ not set up  cursor · copilot · grok · kimi · zai · agy · alibaba · opencode-go · commandcode",
      "                minimax · mimo · deepseek · openrouter · elevenlabs · devin",
      "                quota-axi auth shows where each is read",
    ]);
    expect(output).not.toMatch(/╭─ ○ (agy|alibaba|commandcode) /);

    expect(output).toMatch(/· 1 live · 1 needs attention · 15 not set up\n/);
    expect(output).toContain("╭─ ● codex ");
    expect(output).toContain("╭─ ○ claude ");
    expect(output).toContain("  ○ not set up  cursor · copilot · grok · kimi");
    expect(output).toContain("quota-axi auth shows where each is read");
    expect(output).not.toMatch(/╭─ ○ (copilot|zai|elevenlabs) /);
  });

  it("draws every provider as a card with --all", async () => {
    stubFoldFleet();
    const output = await capture(["--tui", "--once", "--all"]);

    expect(output).toContain("  ○ not set up · 15\n");
    expect(output).toContain("╭─ ○ copilot ");
    expect(output).toContain("╭─ ○ elevenlabs ");
    expect(output).not.toContain("quota-axi auth shows where each is read");
  });

  it("never folds a provider named with --provider", async () => {
    stubFoldFleet();
    const output = await capture([
      "--tui",
      "--once",
      "--provider",
      "zai,codex",
    ]);

    expect(output).toMatch(/· 1 live · 0 need attention · 1 not set up\n/);
    expect(output).toContain("╭─ ○ zai ");
    expect(output).not.toContain("quota-axi auth shows where each is read");
  });

  it("expands and folds them with a in the live report", async () => {
    stubFoldFleet();
    const stdout = process.stdout as unknown as Record<string, unknown>;
    const stdin = process.stdin as unknown as Record<string, unknown>;
    const saved = {
      stdoutTty: stdout.isTTY,
      stdinTty: stdin.isTTY,
      setRawMode: stdin.setRawMode,
      rows: stdout.rows,
      columns: stdout.columns,
    };
    const painted: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      painted.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    stdout.isTTY = true;
    stdin.isTTY = true;
    stdin.setRawMode = () => process.stdin;
    stdout.rows = 80;
    stdout.columns = 100;
    const plain = (text: string): string =>
      // eslint-disable-next-line no-control-regex
      text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const lastFrame = (): string => plain(painted.at(-1) ?? "");
    const settle = async (needle: string): Promise<void> => {
      for (let tries = 0; tries < 200; tries++) {
        if (lastFrame().includes(needle)) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`no frame containing ${needle}`);
    };
    try {
      const run = capture(["--tui"]);
      await settle(
        "Press r to refresh · q to quit · a show not set up · refreshing every 5m",
      );
      expect(lastFrame()).not.toContain("╭─ ○ zai ");

      process.stdin.emit("data", Buffer.from("a"));
      await settle("a hide not set up");
      expect(lastFrame()).toContain("  ○ not set up · 15");
      expect(lastFrame()).toContain("╭─ ○ zai ");

      process.stdin.emit("data", Buffer.from("q"));
      // The final frame echoed on quit keeps the operator's choice.
      expect(plain(await run)).toContain("╭─ ○ zai ");
    } finally {
      stdout.isTTY = saved.stdoutTty;
      stdin.isTTY = saved.stdinTty;
      stdin.setRawMode = saved.setRawMode;
      stdout.rows = saved.rows;
      stdout.columns = saved.columns;
      vi.restoreAllMocks();
    }
  });
});

describe("new provider public quota output", () => {
  it("renders registered MiniMax model scopes through the JSON CLI", async () => {
    useTempCache();
    const key = "synthetic-minimax-cli-key";
    process.env.MINIMAX_API_KEY = key;
    const payload = JSON.parse(
      readFileSync("test/fixtures/minimax/quota.json", "utf8"),
    );
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.minimax.io/v1/token_plan/remains",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${key}`,
        );
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);

    const json = JSON.parse(
      await capture(["--provider", "minimax", "--json", "--full"]),
    ) as QuotaAxiResponse;
    const provider = json.providers[0];

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider).toMatchObject({
      provider: "minimax",
      source: "api",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["env:MINIMAX_API_KEY"],
      },
      attempts: [{ source: "env:MINIMAX_API_KEY", status: "success" }],
    });
    expect(provider?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "model:minimax-m3:5h",
          percentRemaining: 91,
          windowSeconds: 18_000,
        }),
        expect.objectContaining({
          id: "model:minimax-m3:7d",
          percentRemaining: 70,
          windowSeconds: 604_800,
        }),
      ]),
    );
    expect(provider?.quotaSemantics?.effectiveAvailability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "model:minimax-m3",
          status: "known",
          effectivePercentRemaining: 70,
        }),
        expect.objectContaining({
          scope: "model:minimax-m2.7-highspeed",
          status: "known",
          effectivePercentRemaining: 50,
        }),
      ]),
    );
    expect(JSON.stringify(json)).not.toContain(key);
  });

  it("keeps registered MiMo authentication without a fabricated quota scope", async () => {
    useTempCache();
    process.env.MIMO_API_KEY = "synthetic-mimo-cli-key";

    const json = JSON.parse(
      await capture(["--provider", "mimo", "--json", "--full"]),
    ) as QuotaAxiResponse;
    expect(json.providers).toEqual([
      expect.objectContaining({
        provider: "mimo",
        source: "api",
        windows: [],
        state: expect.objectContaining({
          status: "fresh",
          stale: false,
          authStatus: "usable",
          sourcesTried: ["env:MIMO_API_KEY"],
        }),
        quotaSemantics: expect.objectContaining({
          status: "unknown",
          effectiveAvailability: [],
          description: expect.stringContaining("No quota windows"),
        }),
      }),
    ]);
  });

  it("reports missing registered MiMo authentication through JSON", async () => {
    useTempCache();
    delete process.env.MIMO_API_KEY;

    const json = JSON.parse(
      await capture(["--provider", "mimo", "--json", "--full"]),
    ) as QuotaAxiResponse;
    expect(json.providers).toEqual([
      expect.objectContaining({
        provider: "mimo",
        source: "unavailable",
        windows: [],
        state: {
          status: "auth_required",
          stale: false,
          error: "mimo_credential_unavailable",
          sourcesTried: ["env:MIMO_API_KEY"],
        },
      }),
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("reports invalid MiniMax file authentication through the auth CLI", async () => {
    useTempCache();
    delete process.env.MINIMAX_API_KEY;
    process.env.PI_CODING_AGENT_DIR = join(tempDir!, "pi-agent");
    process.env.MMX_CONFIG_DIR = join(tempDir!, "mmx");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
      JSON.stringify({ minimax: { type: "api_key" } }),
    );

    const json = JSON.parse(
      await capture(["auth", "--provider", "minimax", "--json"]),
    ) as {
      auth: Array<{ provider: string; sources: Array<Record<string, string>> }>;
    };
    expect(json.auth).toEqual([
      expect.objectContaining({
        provider: "minimax",
        sources: [
          expect.objectContaining({
            source: "env:MINIMAX_API_KEY",
            status: "missing",
          }),
          expect.objectContaining({
            source: "pi:minimax",
            status: "invalid",
            error: "credential_missing",
          }),
          expect.objectContaining({
            source: "minimax:config.json",
            status: "missing",
          }),
        ],
      }),
    ]);
  });

  it("publishes the registered DeepSeek balance through the JSON CLI", async () => {
    useTempCache();
    const key = "synthetic-deepseek-cli-key";
    process.env.DEEPSEEK_API_KEY = key;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.deepseek.com/user/balance");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${key}`,
        );
        return new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [
              {
                currency: "USD",
                total_balance: "12.50",
                granted_balance: "10.00",
                topped_up_balance: "2.50",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetch);

    const json = JSON.parse(
      await capture(["--provider", "deepseek", "--json", "--full"]),
    ) as QuotaAxiResponse;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(json.providers).toEqual([
      expect.objectContaining({
        provider: "deepseek",
        source: "api",
        windows: [],
        credits: { remaining: 12.5, unit: "usd" },
        state: expect.objectContaining({
          status: "fresh",
          stale: false,
          sourcesTried: ["env:DEEPSEEK_API_KEY"],
        }),
        attempts: [{ source: "env:DEEPSEEK_API_KEY", status: "success" }],
      }),
    ]);
    expect(JSON.stringify(json)).not.toContain(key);
    expect(process.exitCode).toBeUndefined();
  });

  it("publishes the registered OpenRouter key cap in JSON and names it in the default report", async () => {
    useTempCache();
    const key = "synthetic-openrouter-cli-key";
    process.env.OPENROUTER_API_KEY = key;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://openrouter.ai/api/v1/key");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${key}`,
        );
        return new Response(
          JSON.stringify({
            data: {
              label: "personal",
              limit: 100,
              limit_remaining: 73.25,
              limit_reset: "Daily",
              usage: 26.75,
              is_free_tier: false,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetch);

    const json = JSON.parse(
      await capture(["--provider", "openrouter", "--json", "--full"]),
    ) as QuotaAxiResponse;
    expect(json.providers).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        source: "api",
        account: {
          accountId: "personal",
          identityStatus: "unverified",
        },
        credits: { remaining: 73.25, unit: "usd" },
        windows: [
          expect.objectContaining({
            id: "key-limit",
            kind: "credits",
            spentUsd: 26.75,
            limitUsd: 100,
            percentRemaining: 73.25,
            resetText: "Daily",
          }),
        ],
        state: expect.objectContaining({ status: "fresh", stale: false }),
      }),
    ]);
    expect(JSON.stringify(json)).not.toContain(key);

    const report = await capture(["--provider", "openrouter"]);
    expect(report).toContain("openrouter,all,unresolved_windows,key-limit");
  });

  it("reports both new providers as signed out when no key is present", async () => {
    useTempCache();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.PI_CODING_AGENT_DIR = join(tempDir!, "pi-agent-empty");
    const fetch = vi.fn(async () => {
      throw new Error("no request expected without a credential");
    });
    vi.stubGlobal("fetch", fetch);

    const report = await capture(["--provider", "deepseek,openrouter"]);

    expect(fetch).not.toHaveBeenCalled();
    expect(report).toContain(
      "deepseek,all,auth_required,deepseek_credential_unavailable",
    );
    expect(report).toContain(
      "openrouter,all,auth_required,openrouter_credential_unavailable",
    );
    expect(process.exitCode).toBe(1);
  });

  it("publishes Devin included quota in TOON and JSON without the session token", async () => {
    useTempCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T12:00:00.000Z"));
    const key = "synthetic-devin-cli-key";
    process.env.WINDSURF_API_KEY = key;
    const payload = JSON.parse(
      readFileSync("test/fixtures/devin/pro.json", "utf8"),
    ) as unknown;
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    try {
      const toon = await capture(["--provider", "devin"]);
      expect(toonRows(toon, "quota").map((row) => row.slice(0, 3))).toEqual([
        ["devin", "included_quota", "60"],
      ]);
      expect(toon).not.toContain(key);
      expect(toon).not.toContain("person@example.invalid");

      const json = JSON.parse(
        await capture(["--provider", "devin", "--json"]),
      ) as QuotaAxiResponse;
      expect(json.providers[0]).toMatchObject({
        provider: "devin",
        credits: { remaining: 2.5, unit: "usd" },
      });
      expect(json.providers[0]?.account).toBeUndefined();
      expect(json.providers[0]?.windows.map((window) => window.id)).toEqual([
        "weekly",
        "daily",
      ]);
      expect(JSON.stringify(json)).not.toContain(key);

      const full = JSON.parse(
        await capture(["--provider", "devin", "--json", "--full"]),
      ) as QuotaAxiResponse;
      expect(full.providers[0]?.account).toEqual({
        email: "person@example.invalid",
        accountId: "fixture-user",
      });
      expect(
        full.providers[0]?.quotaSemantics?.effectiveAvailability[0],
      ).toMatchObject({
        scope: "included_quota",
        effectivePercentRemaining: 60,
        boundedBy: ["weekly", "daily"],
      });
    } finally {
      delete process.env.WINDSURF_API_KEY;
    }
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
    PROVIDERS.alibaba = providerWithQuota(freshAlibabaQuota());
    PROVIDERS["opencode-go"] = providerWithQuota(freshOpenCodeGoQuota());
    PROVIDERS.commandcode = providerWithQuota(freshCommandCodeQuota());
    PROVIDERS.minimax = providerWithQuota(
      emptyFreshQuota("minimax", "MiniMax"),
    );
    PROVIDERS.mimo = providerWithQuota(emptyFreshQuota("mimo", "MiMo"));
    PROVIDERS.deepseek = providerWithQuota(
      emptyFreshQuota("deepseek", "DeepSeek"),
    );
    PROVIDERS.openrouter = providerWithQuota(
      emptyFreshQuota("openrouter", "OpenRouter"),
    );
    PROVIDERS.elevenlabs = providerWithQuota(freshElevenLabsQuota());
    PROVIDERS.devin = providerWithQuota(freshDevinQuota());

    const output = await capture([]);
    const named = new Set([
      ...toonRows(output, "quota").map((row) => row[0]),
      ...toonRows(output, "attention").map((row) => row[0]),
    ]);

    expect([...named].sort()).toEqual([
      "agy",
      "alibaba",
      "claude",
      "codex",
      "commandcode",
      "copilot",
      "cursor",
      "deepseek",
      "devin",
      "elevenlabs",
      "grok",
      "kimi",
      "mimo",
      "minimax",
      "opencode-go",
      "openrouter",
      "zai",
    ]);
    expect(output).not.toContain("omitted");
  });

  it("omits only absent providers and counts them in one help line", async () => {
    stubNotSetUpFleet();
    const output = await capture([]);
    const stayed = ["agy", "claude", "codex", "cursor", "grok", "minimax"];

    expect(namedProviders(output)).toEqual(stayed);
    expect(output).toContain(
      `${Object.keys(PROVIDERS).length - stayed.length} providers not set up are omitted; run \`quota-axi --full\` to list them`,
    );
    expect(output).toContain("degraded_source");
    const keychainAt = output.indexOf("Tell your user:");
    const omittedAt = output.indexOf("providers not set up are omitted");
    const tierAt = output.indexOf(
      "Run `quota-axi --full` for windows, pace, reserve, and account evidence",
    );
    expect(keychainAt).toBeGreaterThan(-1);
    expect(keychainAt).toBeLessThan(omittedAt);
    expect(omittedAt).toBeLessThan(tierAt);
    expect(process.exitCode).toBeUndefined();

    const full = await capture(["--full"]);
    expect(namedProviders(full)).toEqual(
      Object.keys(PROVIDERS).sort() as string[],
    );
    expect(full).not.toContain("omitted");
  });

  it("keeps an explicitly requested absent provider and restores it with --full", async () => {
    stubNotSetUpFleet();
    const requested = await capture(["--provider", "zai"]);

    expect(toonRows(requested, "attention").map((row) => row[0])).toEqual([
      "zai",
    ]);
    expect(requested).not.toContain("omitted");
    expect(process.exitCode).toBe(1);
  });

  it("uses the singular omission line for one provider that is not set up", async () => {
    stubEveryProvider((id) =>
      id === "elevenlabs" ? notSetUpQuota(id) : emptyFreshQuota(id, id),
    );

    const output = await capture([]);

    expect(output).toContain(
      "1 provider not set up is omitted; run `quota-axi --full` to list it",
    );
    expect(output).not.toContain("elevenlabs");
    expect(toonRows(output, "attention").map((row) => row[0])).toEqual(
      Object.keys(PROVIDERS).filter((id) => id !== "elevenlabs"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 with empty decision blocks when every provider is not set up", async () => {
    stubEveryProvider((id) => notSetUpQuota(id));

    const output = await capture([]);

    expect(output).toContain("quota[0]:");
    expect(output).toContain("exhaustion[0]:");
    expect(output).toContain("attention[0]:");
    expect(output).toContain(
      `${Object.keys(PROVIDERS).length} providers not set up are omitted; run \`quota-axi --full\` to list them`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("marks absent lanes notSetUp in JSON and still lists every provider", async () => {
    stubNotSetUpFleet();

    const lean = JSON.parse(await capture(["--json"])) as QuotaAxiResponse;
    const full = JSON.parse(
      await capture(["--json", "--full"]),
    ) as QuotaAxiResponse;

    expect(lean.schemaVersion).toBe(5);
    expect(full.schemaVersion).toBe(5);
    expect(lean.providers.map((provider) => provider.provider)).toEqual(
      Object.keys(PROVIDERS),
    );
    expect(full.providers.map((provider) => provider.provider)).toEqual(
      Object.keys(PROVIDERS),
    );
    for (const report of [lean, full]) {
      expect(
        report.providers.find((provider) => provider.provider === "zai")
          ?.notSetUp,
      ).toBe(true);
      expect(
        report.providers.find((provider) => provider.provider === "copilot")
          ?.notSetUp,
      ).toBe(true);
      for (const id of [
        "agy",
        "claude",
        "codex",
        "cursor",
        "grok",
        "minimax",
      ]) {
        expect(
          report.providers.find((provider) => provider.provider === id)
            ?.notSetUp,
        ).toBeUndefined();
      }
    }
    expect(
      full.providers.find((provider) => provider.provider === "zai")?.attempts,
    ).toEqual([
      {
        source: "env:zai",
        status: "skipped",
        error: "credentials_missing",
      },
    ]);
    expect(JSON.stringify(lean)).not.toContain('"notSetUp":false');
  });

  it("folds an expanded provider only when every lane is absent", async () => {
    stubEveryProvider((id) => notSetUpQuota(id));
    PROVIDERS.codex = providerWithAccounts([
      ["openai-codex", notSetUpQuota("codex")],
      ["openai-codex-work", freshCodexQuota()],
    ]);

    const output = await capture([]);

    expect(output).toContain("openai-codex");
    expect(output).toContain("openai-codex-work");
    expect(namedProviders(output)).toEqual(["codex"]);
    expect(output).toContain(
      `${Object.keys(PROVIDERS).length - 1} providers not set up are omitted; run \`quota-axi --full\` to list them`,
    );
    expect(process.exitCode).toBeUndefined();

    const json = JSON.parse(await capture(["--json"])) as QuotaAxiResponse;
    expect(json.schemaVersion).toBe(6);
    expect(json.providers).toHaveLength(Object.keys(PROVIDERS).length + 1);
    const lanes = json.providers.filter(
      (provider) => provider.provider === "codex",
    );
    expect(lanes.map((lane) => lane.accountKey)).toEqual([
      "openai-codex",
      "openai-codex-work",
    ]);
    expect(
      lanes.find((lane) => lane.accountKey === "openai-codex")?.notSetUp,
    ).toBe(true);
    expect(
      lanes.find((lane) => lane.accountKey === "openai-codex-work")?.notSetUp,
    ).toBeUndefined();
    expect(
      json.providers
        .filter((provider) => provider.provider !== "codex")
        .every((provider) => provider.notSetUp === true),
    ).toBe(true);

    const restored = await capture(["--full"]);
    expect(namedProviders(restored)).toEqual(
      Object.keys(PROVIDERS).sort() as string[],
    );
    expect(restored).not.toContain("omitted");
  });

  it("renders repeated --provider the same as one comma-separated flag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    stubEveryProvider((id) => notSetUpQuota(id));
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    PROVIDERS.zai = providerWithQuota(notSetUpQuota("zai"));

    const repeated = await capture([
      "--provider",
      "zai",
      "--provider",
      "codex",
    ]);
    const comma = await capture(["--provider", "zai,codex"]);

    expect(repeated).toBe(comma);
    expect(repeated).toContain(
      "zai,all,auth_required,zai_credential_unavailable",
    );
    expect(toonRows(repeated, "quota").map((row) => row[0])).toEqual(["codex"]);
    expect(repeated).not.toContain("omitted");
  });

  it("ignores empty provider occurrences without widening a named scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    stubEveryProvider((id) => notSetUpQuota(id));
    const codex = await capture(["--provider=codex"]);
    expect(await capture(["--provider=", "--provider=codex"])).toBe(codex);
    expect(await capture(["--provider=codex", "--provider="])).toBe(codex);
    expect(await capture(["--provider=,codex"])).toBe(codex);
    expect(
      parseModelsFlags(["--provider=", "--provider=codex"]).providers,
    ).toEqual(["codex"]);
  });

  it("retains all providers when every provider occurrence is empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    stubEveryProvider((id) => notSetUpQuota(id));
    expect(parseFlags(["--provider="]).providers).toEqual(
      parseFlags([]).providers,
    );
    expect(parseFlags(["--provider=", "--provider="]).providers).toEqual(
      parseFlags([]).providers,
    );
    expect(parseModelsFlags(["--provider="]).providers).toEqual(
      parseModelsFlags([]).providers,
    );
    expect(await capture(["--provider=", "--full"])).toBe(
      await capture(["--full"]),
    );
  });

  it("never adds a false unresolved_windows row for a never-set-up OpenCode Go", async () => {
    useTempCache();
    PROVIDERS["opencode-go"] = providerWithQuota(signedOutOpenCodeGoQuota());

    const output = await capture(["--provider", "opencode-go"]);

    expect(toonRows(output, "attention")).toContainEqual([
      "opencode-go",
      "all",
      "auth_required",
      "opencode_go_credential_unavailable",
      "none",
    ]);
    expect(output).not.toContain("unresolved_windows");
  });

  it("still reports unresolved windows for a set-up OpenCode Go missing a stacked cap", async () => {
    useTempCache();
    PROVIDERS["opencode-go"] = providerWithQuota(freshOpenCodeGoQuota());

    const output = await capture(["--provider", "opencode-go"]);

    expect(toonRows(output, "attention")).toContainEqual([
      "opencode-go",
      "all",
      "unresolved_windows",
      "rolling + monthly",
      "none",
    ]);
  });

  it("emits Cursor IDE and Grok Bot as separate quota[] rows", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    PROVIDERS.cursor = providerWithQuota(cursorWithGrokBotWindow());

    const output = await capture(["--provider", "cursor"]);
    expect(toonRows(output, "quota").map((row) => row.slice(0, 3))).toEqual([
      ["cursor", "all_models", "58"],
      ["cursor", "grok_bot", "62"],
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

  it.each([false, true])(
    "states a raw credit balance with expanded accounts %s",
    async (expanded) => {
      useTempCache();
      PROVIDERS.commandcode = providerWithQuota({
        provider: "commandcode",
        label: "Command Code",
        source: "api",
        windows: [],
        credits: { remaining: 12.5, unit: "credits" },
        state: {
          status: "fresh",
          stale: false,
          refreshedAt: "2026-07-06T18:10:00Z",
          authStatus: "usable",
          sourcesTried: ["pi:commandcode"],
        },
      });

      if (expanded) {
        PROVIDERS.codex = providerWithAccounts([
          ["openai-codex", pacedProvider("codex", 20, 80)],
          ["openai-codex-work", pacedProvider("codex", 40, 60)],
        ]);
      }
      const output = await capture([
        "--provider",
        expanded ? "commandcode,codex" : "commandcode",
      ]);

      expect(
        toonRows(output, "attention").filter((row) => row[0] === "commandcode"),
      ).toEqual([
        [
          "commandcode",
          ...(expanded ? ["default"] : []),
          "all",
          "credits",
          "remaining 12.5 credits (auth usable)",
          "none",
        ],
      ]);
    },
  );

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
        "last refreshed 2026-07-06T18:10:00Z · keychain_prompt_required · reason keychain_access_required",
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

  it("names a bound conflict in attention[] instead of an exhausted quota[] row", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T05:27:00.000Z"));
    PROVIDERS.codex = providerWithQuota(codexBoundConflictQuota());

    const output = await capture(["--provider", "codex"]);
    const quota = toonRows(output, "quota").map((row) => row[1]);

    expect(quota).toEqual(["all_models"]);
    expect(toonRows(output, "attention")).toContainEqual([
      "codex",
      "model:codex_bengalfox",
      "bound_conflict",
      "weekly reads 0 · model:codex_bengalfox:5h + model:codex_bengalfox:7d still report allowance",
      "none",
    ]);
    expect(toonRows(output, "exhaustion").map((row) => row[1])).toEqual([
      "all_models",
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

  it("gives an unexpanded provider the default account key beside an expanded one", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    PROVIDERS.claude = providerWithQuota(pacedProvider("claude", 90, 10));
    PROVIDERS.codex = providerWithAccounts([
      ["openai-codex", pacedProvider("codex", 20, 80)],
      ["openai-codex-work", pacedProvider("codex", 40, 60)],
    ]);

    const output = await capture(["--provider", "claude,codex"]);

    expect(output).toContain("quota[3]{provider,accountKey,");
    expect(toonRows(output, "quota").map((row) => row.slice(0, 2))).toEqual([
      ["claude", "default"],
      ["codex", "openai-codex"],
      ["codex", "openai-codex-work"],
    ]);
    expect(output).not.toContain("accountKeys");
  });

  it("publishes accountKeys for a non-folding provider and for lanes whose readings name their membership", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    PROVIDERS.claude = providerWithQuota(pacedProvider("claude", 90, 10));
    const home = pacedProvider("codex", 20, 80);
    const work = pacedProvider("codex", 40, 60);
    PROVIDERS.codex = {
      ...providerWithAccounts([
        ["codex-home", home],
        ["openai-codex-work", work],
      ]),
      async discoverAccounts() {
        return [
          {
            accountKey: "codex-home",
            async fetchQuota() {
              return { ...home, accountKeys: ["openai-codex"] };
            },
            async inspectAuth() {
              return { provider: "codex", sources: [] };
            },
          },
          {
            accountKey: "openai-codex-work",
            async fetchQuota() {
              return work;
            },
            async inspectAuth() {
              return { provider: "codex", sources: [] };
            },
          },
        ];
      },
    };

    const json = JSON.parse(
      await capture(["--provider", "claude,codex", "--json"]),
    ) as QuotaAxiResponse;
    expect(json.schemaVersion).toBe(6);
    expect(
      json.providers.map((provider) => [
        provider.provider,
        provider.accountKey,
        provider.accountKeys,
      ]),
    ).toEqual([
      ["claude", "default", ["default"]],
      ["codex", "codex-home", ["codex-home", "openai-codex"]],
      ["codex", "openai-codex-work", ["openai-codex-work"]],
    ]);

    const full = JSON.parse(
      await capture(["--provider", "claude,codex", "--json", "--full"]),
    ) as QuotaAxiResponse;
    expect(full.providers.map((provider) => provider.accountKeys)).toEqual([
      ["default"],
      ["codex-home", "openai-codex"],
      ["openai-codex-work"],
    ]);

    const toon = await capture(["--provider", "claude,codex"]);
    expect(toon).not.toContain("accountKeys");

    const single = JSON.parse(
      await capture(["--provider", "claude", "--json"]),
    ) as QuotaAxiResponse;
    expect(single.schemaVersion).toBe(5);
    expect(single.providers[0]?.accountKey).toBeUndefined();
    expect(single.providers[0]?.accountKeys).toEqual(["default"]);
  });
});

describe("report generatedAt", () => {
  it("stamps generatedAt after every fetch so a reset computed at response time opens its cycle", async () => {
    useTempCache();
    PROVIDERS["opencode-go"] = {
      ...providerWithQuota(freshOpenCodeGoQuota()),
      async fetchQuota() {
        // Vendor computes the rolling reset as "now + 5 h" at response time,
        // strictly after the command started.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const resetsAt = new Date(Date.now() + 18_000 * 1000).toISOString();
        return {
          ...freshOpenCodeGoQuota(),
          windows: [
            {
              id: "rolling",
              label: "rolling",
              kind: "unknown",
              percentUsed: 0,
              percentRemaining: 100,
              windowSeconds: 18_000,
              resetsAt,
            },
          ],
        };
      },
    };

    const output = JSON.parse(
      await quotaCommand(["--provider", "opencode-go", "--json", "--full"], {
        binPath: "quota-axi",
      }),
    ) as {
      generatedAt: string;
      providers: {
        windows: { id: string; pace?: Record<string, unknown> }[];
      }[];
    };

    const rolling = output.providers[0]?.windows.find(
      ({ id }) => id === "rolling",
    );
    expect(rolling?.pace).toMatchObject({
      status: "on_pace",
      elapsedPercent: 0,
    });
    // Zero burn: absent when no time has elapsed, 0 once a millisecond has.
    expect(rolling?.pace?.burnMultiple ?? 0).toBe(0);
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
    PROVIDERS.alibaba = providerWithAuth("alibaba", "Alibaba Coding Plan");
    PROVIDERS["opencode-go"] = providerWithAuth("opencode-go", "OpenCode Go");
    PROVIDERS.commandcode = providerWithAuth("commandcode", "Command Code");
    PROVIDERS.minimax = providerWithAuth("minimax", "MiniMax");
    PROVIDERS.mimo = providerWithAuth("mimo", "MiMo");
    PROVIDERS.deepseek = providerWithAuth("deepseek", "DeepSeek");
    PROVIDERS.openrouter = providerWithAuth("openrouter", "OpenRouter");

    const output = await capture(["--allow-keychain-prompt", "auth"]);
    expect(output).toContain(
      "Inspect local quota auth sources without printing secret values",
    );
    expect(output).toContain("deepseek,test,none,available,none");
    expect(output).toContain("openrouter,test,none,available,none");
    expect(output).not.toContain("unknown argument");
    expect(process.exitCode).toBeUndefined();
  });

  it("offers the secure-store hint for any keychain diagnostic", async () => {
    PROVIDERS.claude = {
      id: "claude",
      label: "Claude",
      async fetchQuota() {
        throw new Error("unexpected quota fetch");
      },
      async inspectAuth() {
        return {
          provider: "claude" as const,
          sources: [
            {
              source: "keychain",
              status: "skipped" as const,
              error: "keychain_access_denied",
            },
          ],
        };
      },
    };

    const output = await capture(["--provider", "claude", "auth"]);

    expect(output).toContain(
      "Run `quota-axi --allow-keychain-prompt auth` to permit native secure-store access",
    );
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

describe("terminal height and the machine output paths", () => {
  async function run(
    argv: string[],
    rows: number | undefined,
  ): Promise<string> {
    const stdout = process.stdout as unknown as {
      rows: number | undefined;
      columns: number | undefined;
    };
    const originalRows = stdout.rows;
    const originalColumns = stdout.columns;
    stdout.rows = rows;
    stdout.columns = 100;
    try {
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
    } finally {
      stdout.rows = originalRows;
      stdout.columns = originalColumns;
    }
  }

  function stubFleet(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    useTempCache();
    PROVIDERS.claude = providerWithQuota(staleClaudeQuota());
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
  }

  for (const argv of [
    ["--provider", "claude,codex"],
    ["--provider", "claude,codex", "--json"],
    ["--provider", "claude,codex", "--tui", "--once"],
  ]) {
    it(`renders \`${argv.join(" ")}\` identically at every height`, async () => {
      stubFleet();
      const tall = await run(argv, 60);
      stubFleet();
      const short = await run(argv, 6);
      stubFleet();
      const unknown = await run(argv, undefined);

      expect(short).toBe(tall);
      expect(unknown).toBe(tall);
      expect(tall.length).toBeGreaterThan(0);
    });
  }
});

function emptyFreshQuota(
  provider: ProviderQuota["provider"],
  label: string,
): ProviderQuota {
  return {
    provider,
    label,
    source: "api",
    windows: [],
    state: { status: "fresh", stale: false },
  };
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

/** Expands into one lane per account, the way an adapter's discovery does. */
function providerWithAccounts(
  lanes: [string, ProviderQuota][],
): ProviderAdapter {
  return {
    ...providerWithQuota(lanes[0][1]),
    async discoverAccounts() {
      return lanes.map(([accountKey, quota]) => ({
        accountKey,
        async fetchQuota() {
          return quota;
        },
        async inspectAuth() {
          return { provider: quota.provider, sources: [] };
        },
      }));
    },
  };
}

function stubEveryProvider(
  quotaFor: (id: ProviderQuota["provider"]) => ProviderQuota,
): void {
  useTempCache();
  for (const id of Object.keys(PROVIDERS) as ProviderQuota["provider"][]) {
    PROVIDERS[id] = providerWithQuota(quotaFor(id));
  }
}

/**
 * One of each presence the omission rule has to tell apart: a stale reading,
 * a Keychain prompt, a degraded store, a provider that recorded no attempts,
 * an adapter-declared uncertain skip, a failed request, an incidental-source
 * login that is still absence, and everyone else genuinely not set up.
 */
function stubNotSetUpFleet(): void {
  stubEveryProvider((id) => notSetUpQuota(id));
  PROVIDERS.codex = providerWithQuota({
    ...staleClaudeQuota(),
    provider: "codex",
    label: "Codex",
  });
  PROVIDERS.claude = providerWithQuota({
    ...notSetUpQuota("claude"),
    state: {
      status: "unavailable",
      stale: false,
      error: "keychain_prompt_required",
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
  });
  PROVIDERS.cursor = providerWithQuota({
    ...notSetUpQuota("cursor"),
    state: {
      status: "unavailable",
      stale: false,
      error: "state-vscdb unreadable",
      degradedSources: [{ source: "state-vscdb", error: "unreadable" }],
    },
    attempts: [
      {
        source: "state-vscdb",
        status: "skipped",
        error: "unreadable",
        credentialPresent: true,
        degraded: true,
      },
    ],
  });
  const minimax = notSetUpQuota("minimax");
  delete minimax.attempts;
  PROVIDERS.minimax = providerWithQuota(minimax);
  PROVIDERS.agy = {
    ...providerWithQuota({
      ...notSetUpQuota("agy"),
      state: {
        status: "unavailable",
        stale: false,
        error: "agy CLI timed out",
      },
      attempts: [
        { source: "cli", status: "skipped", error: "agy CLI timed out" },
      ],
    }),
    isUncertainSkip: (attempt) => attempt.error === "agy CLI timed out",
  };
  PROVIDERS.grok = providerWithQuota({
    ...notSetUpQuota("grok"),
    state: { status: "error", stale: false, error: "network down" },
    attempts: [{ source: "web", status: "failed", error: "network down" }],
  });
  PROVIDERS.copilot = {
    ...providerWithQuota({
      ...notSetUpQuota("copilot"),
      attempts: [
        {
          source: "apps-json",
          status: "skipped",
          error: "credentials_missing",
        },
        {
          source: "gh:hosts.yml",
          status: "skipped",
          error: "credentials_keyring_storage",
          credentialPresent: true,
        },
      ],
    }),
    incidentalSources: ["gh:hosts.yml"],
  };
}

function namedProviders(output: string): string[] {
  return [
    ...new Set([
      ...toonRows(output, "quota").map((row) => row[0] ?? ""),
      ...toonRows(output, "attention").map((row) => row[0] ?? ""),
    ]),
  ].sort();
}

function notSetUpQuota(provider: ProviderQuota["provider"]): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "unavailable",
    windows: [],
    state: {
      status: "auth_required",
      stale: false,
      error: `${provider}_credential_unavailable`,
      sourcesTried: [`env:${provider}`],
    },
    attempts: [
      {
        source: `env:${provider}`,
        status: "skipped",
        error: "credentials_missing",
      },
    ],
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

function envScopeDeniedClaudeQuota(): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source: "unavailable",
    windows: [],
    state: {
      status: "unavailable",
      stale: false,
      authStatus: "usable",
      error: "claude_env_usage_scope_unavailable",
      sourcesTried: ["env"],
    },
    attempts: [
      {
        source: "env",
        status: "failed",
        error: "claude_env_usage_scope_unavailable",
        degraded: false,
      },
    ],
  };
}

function nativeRateLimitedClaudeQuota(): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source: "cli",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 100,
        percentRemaining: 0,
        resetsAt: "2099-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
    ],
    state: {
      status: "rate_limited",
      stale: false,
      authStatus: "usable",
      error: "claude_native_rate_limited",
      retryAfter: "2026-09-19T06:01:00.000Z",
      sourcesTried: ["env", "claude-native-inference"],
    },
    attempts: [
      {
        source: "env",
        status: "failed",
        error: "claude_env_usage_scope_unavailable",
        degraded: false,
      },
      {
        source: "claude-native-inference",
        status: "failed",
        error: "claude_native_rate_limited",
        degraded: false,
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

function cursorWithGrokBotWindow(): ProviderQuota {
  return {
    provider: "cursor",
    label: "Cursor",
    source: "api",
    plan: "ultra",
    windows: [
      {
        id: "included_usage",
        label: "included usage",
        kind: "monthly",
        percentUsed: 42,
        percentRemaining: 58,
        startsAt: "2026-07-22T00:00:00.000Z",
        resetsAt: "2026-08-22T00:00:00.000Z",
      },
      {
        id: "grok_bot",
        label: "Grok Bot",
        kind: "weekly",
        percentUsed: 38,
        percentRemaining: 62,
        startsAt: "2026-08-19T21:37:33.239Z",
        resetsAt: "2026-08-26T21:37:33.239Z",
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-08-21T12:00:00.000Z",
      sourcesTried: ["api"],
    },
    attempts: [{ source: "api", status: "success" }],
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

function freshAlibabaQuota(): ProviderQuota {
  return {
    provider: "alibaba",
    label: "Alibaba Coding Plan",
    source: "api",
    plan: "Coding Plan Pro",
    windows: [
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 10,
        percentRemaining: 90,
        windowSeconds: 604800,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["pi:alibaba-plan"],
    },
  };
}

function freshOpenCodeGoQuota(): ProviderQuota {
  return {
    provider: "opencode-go",
    label: "OpenCode Go",
    source: "api",
    plan: "OpenCode Go",
    windows: [
      {
        id: "weekly",
        label: "weekly",
        kind: "weekly",
        percentUsed: 12,
        percentRemaining: 88,
        windowSeconds: 604800,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["opencode:auth.json"],
    },
  };
}

/** A never-set-up OpenCode Go: no credential, so no windows at all. */
function signedOutOpenCodeGoQuota(): ProviderQuota {
  return {
    provider: "opencode-go",
    label: "OpenCode Go",
    source: "unavailable",
    windows: [],
    state: {
      status: "auth_required",
      stale: false,
      error: "opencode_go_credential_unavailable",
      sourcesTried: ["opencode:auth.json"],
    },
  };
}

function freshCommandCodeQuota(): ProviderQuota {
  return {
    provider: "commandcode",
    label: "Command Code",
    source: "api",
    plan: "Command Code",
    windows: [
      {
        id: "weekly",
        label: "weekly",
        kind: "weekly",
        percentUsed: 12,
        percentRemaining: 88,
        windowSeconds: 604800,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["pi:commandcode"],
    },
  };
}

function freshDevinQuota(): ProviderQuota {
  return {
    provider: "devin",
    label: "Devin",
    source: "api",
    plan: "max",
    windows: [
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 20,
        percentRemaining: 80,
        windowSeconds: 604_800,
        startsAt: "2026-09-20T08:00:00.000Z",
        resetsAt: "2026-09-27T08:00:00.000Z",
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: "2026-09-22T12:00:00.000Z",
      sourcesTried: ["env:WINDSURF_API_KEY"],
    },
  };
}

function freshElevenLabsQuota(): ProviderQuota {
  return {
    provider: "elevenlabs",
    label: "ElevenLabs",
    source: "api",
    plan: "creator",
    windows: [
      {
        id: "characters",
        label: "characters",
        kind: "monthly",
        percentUsed: 40,
        percentRemaining: 60,
        startsAt: "2026-06-12T00:00:00.000Z",
        resetsAt: "2026-07-12T00:00:00.000Z",
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["env:ELEVENLABS_API_KEY"],
    },
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

/**
 * The 2026-09-07 capture: the Codex account weekly reads zero while the named
 * model's own 5h and 7d meters are visibly drawing down, and a live call to
 * that model succeeded.
 */
function codexBoundConflictQuota(): ProviderQuota {
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
        percentUsed: 8,
        percentRemaining: 92,
        startsAt: "2026-09-07T05:27:00.000Z",
        resetsAt: "2026-09-07T10:27:00.000Z",
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 100,
        percentRemaining: 0,
        startsAt: "2026-08-31T17:27:00.000Z",
        resetsAt: "2026-09-07T17:27:00.000Z",
      },
      {
        id: "model:codex_bengalfox:5h",
        label: "Spark session",
        kind: "model",
        percentUsed: 8,
        percentRemaining: 92,
        startsAt: "2026-09-07T05:27:00.000Z",
        resetsAt: "2026-09-07T10:27:00.000Z",
      },
      {
        id: "model:codex_bengalfox:7d",
        label: "Spark week",
        kind: "model",
        percentUsed: 4,
        percentRemaining: 96,
        startsAt: "2026-09-07T05:27:00.000Z",
        resetsAt: "2026-09-14T05:27:00.000Z",
      },
    ],
    state: { status: "fresh", stale: false, sourcesTried: ["cli-rpc"] },
  };
}
