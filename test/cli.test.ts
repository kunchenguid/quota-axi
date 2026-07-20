import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFlags, selectClaudeConfigs } from "../src/args.js";
import { main, normalizeArgv } from "../src/cli.js";
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
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  PROVIDERS.claude = originalClaudeProvider;
  PROVIDERS.codex = originalCodexProvider;
  PROVIDERS.cursor = originalCursorProvider;
  PROVIDERS.copilot = originalCopilotProvider;
  PROVIDERS.grok = originalGrokProvider;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
});

describe("CLI flag parsing", () => {
  it("defaults to all supported providers", () => {
    expect(parseFlags([]).providers).toEqual([
      "claude",
      "codex",
      "cursor",
      "copilot",
      "grok",
    ]);
  });

  it("scopes comma-separated providers", () => {
    expect(parseFlags(["--provider", "claude"]).providers).toEqual(["claude"]);
    expect(parseFlags(["--provider=cursor,copilot,grok"]).providers).toEqual([
      "cursor",
      "copilot",
      "grok",
    ]);
  });

  it("ignores a standalone argument separator", () => {
    expect(parseFlags(["--", "--provider", "grok", "--json"])).toMatchObject({
      providers: ["grok"],
      json: true,
    });
  });

  it("collects the boolean flags", () => {
    expect(
      parseFlags(["--json", "--full", "--allow-keychain-prompt"], {}),
    ).toEqual({
      providers: ["claude", "codex", "cursor", "copilot", "grok"],
      json: true,
      full: true,
      allowKeychainPrompt: true,
    });
  });

  it("selects repeated Claude config flags in first-seen order and deduplicates normalized paths", () => {
    const flags = parseFlags(
      [
        "--claude-config-dir",
        "./fixtures/../arcs",
        "--claude-config-dir=./jr",
        "--claude-config-dir",
        "./arcs",
      ],
      {
        CLAUDE_CONFIG_DIRS: ["/env/ra", "/env/yfz"].join(delimiter),
        CLAUDE_CONFIG_DIR: "/legacy",
      },
    );

    expect(flags.claudeConfigs).toEqual([
      {
        directory: resolve("arcs"),
        keychainIdentity: "./fixtures/../arcs",
      },
      { directory: resolve("jr"), keychainIdentity: "./jr" },
    ]);
  });

  it("uses plural, singular, then default Claude config sources deterministically", () => {
    expect(
      selectClaudeConfigs([], {
        CLAUDE_CONFIG_DIRS: ["/env/arcs", "/env/jr", "/env/arcs"].join(
          delimiter,
        ),
        CLAUDE_CONFIG_DIR: "/legacy",
      }),
    ).toEqual({
      source: "CLAUDE_CONFIG_DIRS",
      configs: [
        { directory: resolve("/env/arcs"), keychainIdentity: "/env/arcs" },
        { directory: resolve("/env/jr"), keychainIdentity: "/env/jr" },
      ],
    });
    expect(selectClaudeConfigs([], { CLAUDE_CONFIG_DIR: "./legacy" })).toEqual({
      source: "CLAUDE_CONFIG_DIR",
      configs: [{ keychainIdentity: "./legacy" }],
    });
    expect(selectClaudeConfigs([], {})).toEqual({ source: "default" });
  });

  it("rejects a missing Claude config directory value", () => {
    expect(() => parseFlags(["--claude-config-dir"])).toThrow(
      "--claude-config-dir requires a directory path",
    );
    expect(() => parseFlags(["--claude-config-dir="])).toThrow(
      "--claude-config-dir requires a directory path",
    );
    expect(() => parseFlags(["--claude-config-dir", "   "])).toThrow(
      "--claude-config-dir requires a directory path",
    );
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
    expect(normalizeArgv(["--claude-config-dir", "auth", "--json"])).toEqual([
      "quota",
      "--claude-config-dir",
      "auth",
      "--json",
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
    expect(output.schemaVersion).toBe(2);
    expect(claude?.state.reason).toBe("keychain_access_required");
    expect(claude?.state.remedyCommand).toBe(
      "quota-axi --allow-keychain-prompt",
    );
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
          error: "credentials_expired",
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

  it("preserves the single-seat JSON and human schemas for one explicit config", async () => {
    useTempCache();
    let receivedConfigDir: string | undefined;
    PROVIDERS.claude = {
      ...providerWithQuota(freshClaudeQuota()),
      async fetchQuota(options) {
        receivedConfigDir = options.claudeConfigDir;
        return freshClaudeQuota();
      },
    };
    const configDir = resolve("/private/configs/arcs");

    const json = JSON.parse(
      await capture([
        "--provider",
        "claude",
        "--claude-config-dir",
        configDir,
        "--json",
      ]),
    ) as QuotaAxiResponse;
    const human = await capture([
      "--provider",
      "claude",
      "--claude-config-dir",
      configDir,
    ]);

    expect(receivedConfigDir).toBe(configDir);
    expect(json.providers).toHaveLength(1);
    expect(json.providers[0].label).toBe("Claude");
    expect(json.providers[0].seat).toBeUndefined();
    expect(human).toContain(
      "providers[1]{provider,plan,source,status,refreshedAt}:",
    );
    expect(human).not.toContain("{provider,seat,");
  });

  it("renders deterministic mixed Claude seats with Codex and Grok in JSON without private paths", async () => {
    useTempCache();
    const [arcs, jr] = useMixedProviderFixtures();

    const text = await capture([
      "--provider",
      "claude,codex,grok",
      "--claude-config-dir",
      arcs,
      "--claude-config-dir",
      jr,
      "--json",
    ]);
    const output = JSON.parse(text) as QuotaAxiResponse;

    expect(
      output.providers.map((provider) => ({
        provider: provider.provider,
        seat: provider.seat,
        status: provider.state.status,
      })),
    ).toEqual([
      { provider: "claude", seat: seatId(arcs), status: "fresh" },
      { provider: "claude", seat: seatId(jr), status: "auth_required" },
      { provider: "codex", seat: undefined, status: "fresh" },
      { provider: "grok", seat: undefined, status: "fresh" },
    ]);
    expect(output.providers[0].label).toBe(`Claude (${seatId(arcs)})`);
    expect(text).not.toContain("/private/customer/configs");
    expect(text).not.toContain("fixture-secret-token");
    expect(text).not.toContain("person@example.invalid");
    expect(process.exitCode).toBeUndefined();
  });

  it("distinguishes Claude seats in one human view with Codex and Grok", async () => {
    useTempCache();
    const [arcs, jr] = useMixedProviderFixtures();

    const output = await capture([
      "--provider",
      "claude,codex,grok",
      "--claude-config-dir",
      arcs,
      "--claude-config-dir",
      jr,
    ]);

    expect(output).toContain(
      "providers[4]{provider,seat,plan,source,status,refreshedAt}:",
    );
    expect(output).toContain(`claude,${seatId(arcs)},pro,oauth,fresh`);
    expect(output).toContain(
      `claude,${seatId(jr)},unknown,unavailable,auth_required`,
    );
    expect(output).toContain("codex,none,pro,cli-rpc,fresh");
    expect(output).toContain("grok,none,supergrok,api,fresh");
    expect(output).toContain(
      "windows[3]{provider,seat,id,label,percentRemaining,resetsAt,state}:",
    );
    expect(output.split("help[")[0]).not.toContain("/private/customer/configs");
    expect(output).toContain(
      "--claude-config-dir='/private/customer/configs/arcs'",
    );
    expect(output).not.toContain("fixture-secret-token");
  });

  it("labels multi-seat auth reports without exposing config paths", async () => {
    const [arcs, jr] = useMixedProviderFixtures();

    const text = await capture([
      "auth",
      "--provider",
      "claude",
      "--claude-config-dir",
      arcs,
      "--claude-config-dir",
      jr,
      "--json",
    ]);
    const output = JSON.parse(text) as {
      auth: Array<{
        provider: string;
        seat?: string;
        sources: Array<{ path?: string }>;
      }>;
    };

    expect(output.auth.map((report) => report.seat)).toEqual([
      seatId(arcs),
      seatId(jr),
    ]);
    expect(output.auth.flatMap((report) => report.sources)).not.toContainEqual(
      expect.objectContaining({ path: expect.any(String) }),
    );
    expect(text).not.toContain("/private/customer/configs");
  });

  it("keeps seat identifiers stable when the selected set changes", async () => {
    useTempCache();
    const arcs = resolve("/private/configs/arcs");
    const firstPeer = resolve("/private/configs/first");
    const secondPeer = resolve("/private/configs/second");
    installClaudeSeatRouter({
      arcs: freshClaudeQuota,
      first: freshClaudeQuota,
      second: freshClaudeQuota,
    });

    const first = JSON.parse(
      await capture([
        "--provider",
        "claude",
        "--claude-config-dir",
        arcs,
        "--claude-config-dir",
        firstPeer,
        "--json",
      ]),
    ) as QuotaAxiResponse;
    const second = JSON.parse(
      await capture([
        "--provider",
        "claude",
        "--claude-config-dir",
        arcs,
        "--claude-config-dir",
        secondPeer,
        "--json",
      ]),
    ) as QuotaAxiResponse;

    expect(first.providers[0].seat).toBe(seatId(arcs));
    expect(second.providers[0].seat).toBe(seatId(arcs));
  });

  it("preserves every selected profile in keychain remediation", async () => {
    useTempCache();
    const keychainIdentities: Array<string | undefined> = [];
    PROVIDERS.claude = {
      ...providerWithQuota(staleClaudeQuota()),
      async fetchQuota(options) {
        keychainIdentities.push(options.claudeKeychainIdentity);
        return staleClaudeQuota();
      },
    };

    const output = JSON.parse(
      await capture([
        "--provider",
        "claude",
        "--claude-config-dir",
        "./team-a",
        "--claude-config-dir",
        "../team-b",
        "--json",
      ]),
    ) as QuotaAxiResponse;
    const remedy =
      "quota-axi --allow-keychain-prompt --provider claude " +
      "--claude-config-dir='./team-a' --claude-config-dir='../team-b'";

    expect(keychainIdentities).toEqual(["./team-a", "../team-b"]);
    expect(
      output.providers.map((provider) => provider.state.remedyCommand),
    ).toEqual([remedy, remedy]);
    expect(output.help).toEqual([
      `Tell your user: run \`${remedy}\` once and approve Keychain access ("Always Allow") so quota-axi can read claude's live quota.`,
    ]);
  });

  it("preserves selected profiles in contextual quota commands", async () => {
    useTempCache();
    PROVIDERS.claude = providerWithQuota(freshClaudeQuota());
    const configFlags =
      "--claude-config-dir='./team-a' --claude-config-dir='../team-b'";

    const output = await capture([
      "--provider",
      "claude",
      "--claude-config-dir",
      "./team-a",
      "--claude-config-dir",
      "../team-b",
    ]);

    expect(output).toContain(
      `Run \`quota-axi --provider claude --json ${configFlags}\` for JSON output`,
    );
    expect(output).toContain(
      `Run \`quota-axi --full ${configFlags}\` to include account and source-attempt details`,
    );
    expect(output).toContain(
      `Run \`quota-axi auth ${configFlags}\` to inspect local auth source availability without printing secrets`,
    );
  });

  it("preserves selected profiles in the auth Keychain remedy", async () => {
    PROVIDERS.claude = providerWithAuth("claude", "Claude");
    const configFlags =
      "--claude-config-dir='./team-a' --claude-config-dir='../team-b'";

    const output = await capture([
      "auth",
      "--provider",
      "claude",
      "--claude-config-dir",
      "./team-a",
      "--claude-config-dir",
      "../team-b",
    ]);

    expect(output).toContain(
      `Run \`quota-axi --allow-keychain-prompt auth ${configFlags}\` to permit macOS Keychain access`,
    );
  });

  it("serializes prompt-capable Claude reads without blocking other providers", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    useTempCache();
    const first = resolve("/private/configs/first");
    const second = resolve("/private/configs/second");
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    let markCodexStarted!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    const secondStarted = new Promise<void>((resolveStarted) => {
      markSecondStarted = resolveStarted;
    });
    const codexStarted = new Promise<void>((resolveStarted) => {
      markCodexStarted = resolveStarted;
    });
    PROVIDERS.claude = {
      ...providerWithQuota(freshClaudeQuota()),
      async fetchQuota(options) {
        if (options.claudeConfigDir === first) {
          markFirstStarted();
          await firstGate;
        } else {
          markSecondStarted();
        }
        return freshClaudeQuota();
      },
    };
    PROVIDERS.codex = {
      ...providerWithQuota(freshCodexQuota()),
      async fetchQuota() {
        markCodexStarted();
        return freshCodexQuota();
      },
    };

    let secondWasStarted = false;
    void secondStarted.then(() => {
      secondWasStarted = true;
    });
    const command = capture([
      "--provider",
      "claude,codex",
      "--claude-config-dir",
      first,
      "--claude-config-dir",
      second,
      "--allow-keychain-prompt",
      "--json",
    ]);
    await Promise.all([firstStarted, codexStarted]);
    expect(secondWasStarted).toBe(false);
    releaseFirst();
    await Promise.all([secondStarted, command]);
  });

  it("keeps prompt-enabled Claude reads concurrent outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    useTempCache();
    const first = resolve("/private/configs/first");
    const second = resolve("/private/configs/second");
    let releaseReads!: () => void;
    let markBothStarted!: () => void;
    let started = 0;
    const readGate = new Promise<void>((resolveGate) => {
      releaseReads = resolveGate;
    });
    const bothStarted = new Promise<void>((resolveStarted) => {
      markBothStarted = resolveStarted;
    });
    PROVIDERS.claude = {
      ...providerWithQuota(freshClaudeQuota()),
      async fetchQuota() {
        started++;
        if (started === 2) markBothStarted();
        await readGate;
        return freshClaudeQuota();
      },
    };

    const command = capture([
      "--provider",
      "claude",
      "--claude-config-dir",
      first,
      "--claude-config-dir",
      second,
      "--allow-keychain-prompt",
      "--json",
    ]);
    const concurrent = await Promise.race([
      bothStarted.then(() => true),
      new Promise<false>((resolveTimeout) =>
        setTimeout(() => resolveTimeout(false), 100),
      ),
    ]);
    releaseReads();
    await command;

    expect(concurrent).toBe(true);
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
    expect(output).toContain("usage: quota-axi [auth] [flags]");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the top-level help for legacy -h", async () => {
    const output = await capture(["auth", "-h"]);
    expect(output).toContain("usage: quota-axi [auth] [flags]");
    expect(process.exitCode).toBeUndefined();
  });

  it("routes flag-before-auth invocations to auth", async () => {
    PROVIDERS.claude = providerWithAuth("claude", "Claude");
    PROVIDERS.codex = providerWithAuth("codex", "Codex");
    PROVIDERS.cursor = providerWithAuth("cursor", "Cursor");
    PROVIDERS.copilot = providerWithAuth("copilot", "GitHub Copilot");
    PROVIDERS.grok = providerWithAuth("grok", "Grok");

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
      schemaVersion: 2,
      summary: { availability: "ok", ok: 1, unavailable: 0, total: 1 },
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
    // The aggregate is non-secret and survives redaction in both views.
    expect(redactedResponse(response, false).summary).toEqual(response.summary);
    expect(redactedResponse(response, true).summary).toEqual(response.summary);
  });
});

describe("aggregate availability summary", () => {
  it("bounds one 429 seat and reports partial availability without erasing others", async () => {
    useTempCache();
    const dirs = useFiveSeatFixtures();

    const text = await capture([
      "--provider",
      "claude",
      ...dirs.flatMap((dir) => ["--claude-config-dir", dir]),
      "--json",
    ]);
    const output = JSON.parse(text) as QuotaAxiResponse;

    expect(output.summary).toEqual({
      availability: "partial",
      ok: 3,
      unavailable: 2,
      total: 5,
    });
    expect(output.providers.map((provider) => provider.seat)).toEqual(
      dirs.map(seatId),
    );
    const bySeat = Object.fromEntries(
      output.providers.map((provider) => [provider.seat, provider]),
    );
    const [arcs, jr, nyu, ra, yfz] = dirs.map(seatId);
    // The single 429 stays bounded to its own seat...
    expect(bySeat[jr].state.status).toBe("rate_limited");
    expect(bySeat[jr].state.retryAfter).toBe("2026-07-20T18:45:51Z");
    // ...and does not erase successful windows from the healthy seats.
    expect(bySeat[arcs].windows.length).toBeGreaterThan(0);
    expect(bySeat[nyu].state.status).toBe("stale");
    expect(bySeat[nyu].windows.length).toBeGreaterThan(0);
    expect(bySeat[yfz].windows.length).toBeGreaterThan(0);
    expect(bySeat[ra].state.status).toBe("auth_required");
    // Duplicate account identity (arcs and yfz share an accountId) never
    // collapses two config dirs into one row.
    expect(
      output.providers.filter((provider) => provider.provider === "claude"),
    ).toHaveLength(5);
    // Partial availability is usable data → exit 0.
    expect(process.exitCode).toBeUndefined();
    // The shared account id is redacted from default output.
    expect(text).not.toContain("acct-shared");
  });

  it("renders the partial verdict in the human TOON headline", async () => {
    useTempCache();
    const dirs = useFiveSeatFixtures();

    const output = await capture([
      "--provider",
      "claude",
      ...dirs.flatMap((dir) => ["--claude-config-dir", dir]),
    ]);

    expect(output).toContain("summary:");
    expect(output).toContain("availability: partial");
    expect(output).toContain("ok: 3");
    expect(output).toContain("unavailable: 2");
    expect(output).toContain("total: 5");
  });

  it("includes every Claude seat under --full alongside Codex and Grok", async () => {
    useTempCache();
    const dirs = useFiveSeatFixtures();
    PROVIDERS.codex = providerWithQuota(freshCodexQuota());
    PROVIDERS.grok = providerWithQuota(freshGrokQuota());

    const output = JSON.parse(
      await capture([
        "--provider",
        "claude,codex,grok",
        ...dirs.flatMap((dir) => ["--claude-config-dir", dir]),
        "--full",
        "--json",
      ]),
    ) as QuotaAxiResponse;

    expect(output.providers).toHaveLength(7);
    expect(output.summary).toEqual({
      availability: "partial",
      ok: 5,
      unavailable: 2,
      total: 7,
    });
    // Codex and Grok are not regressed by the multi-seat Claude fan-out.
    const codex = output.providers.find(
      (provider) => provider.provider === "codex",
    );
    const grok = output.providers.find(
      (provider) => provider.provider === "grok",
    );
    expect(codex?.state.status).toBe("fresh");
    expect(codex?.windows.length).toBeGreaterThan(0);
    expect(grok?.state.status).toBe("fresh");
    expect(grok?.windows.length).toBeGreaterThan(0);
    // --full carries per-source attempts for the healthy Claude seat.
    expect(
      output.providers.find((provider) => provider.seat === seatId(dirs[0]))
        ?.attempts,
    ).toBeDefined();
  });

  it("reports complete unavailability and exits 1 when every seat fails", async () => {
    useTempCache();
    const dirs = useAllFailingSeatFixtures();

    const output = JSON.parse(
      await capture([
        "--provider",
        "claude",
        ...dirs.flatMap((dir) => ["--claude-config-dir", dir]),
        "--json",
      ]),
    ) as QuotaAxiResponse;

    expect(output.summary).toEqual({
      availability: "unavailable",
      ok: 0,
      unavailable: 5,
      total: 5,
    });
    expect(
      output.providers.every((provider) => provider.windows.length === 0),
    ).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("reports full availability and exits 0 when every seat is fresh", async () => {
    useTempCache();
    const dirs = useAllFreshSeatFixtures();

    const output = JSON.parse(
      await capture([
        "--provider",
        "claude",
        ...dirs.flatMap((dir) => ["--claude-config-dir", dir]),
        "--json",
      ]),
    ) as QuotaAxiResponse;

    expect(output.summary).toEqual({
      availability: "ok",
      ok: 5,
      unavailable: 0,
      total: 5,
    });
    expect(process.exitCode).toBeUndefined();
  });
});

function seatId(directory: string): string {
  return `${basename(directory) || "root"}-${createHash("sha256")
    .update(directory)
    .digest("hex")
    .slice(0, 6)}`;
}

const FIVE_SEAT_NAMES = ["arcs", "jr", "nyu", "ra", "yfz"] as const;

function fiveSeatDirs(): string[] {
  return FIVE_SEAT_NAMES.map((name) => resolve(`/fake/seats/${name}`));
}

function failedClaudeSeat(
  status: ProviderQuota["state"]["status"],
  error: string,
  extra: { retryAfter?: string } = {},
): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source: "unavailable",
    windows: [],
    state: {
      status,
      stale: false,
      error,
      sourcesTried: ["oauth"],
      ...(extra.retryAfter ? { retryAfter: extra.retryAfter } : {}),
    },
    attempts: [{ source: "oauth", status: "failed", error }],
  };
}

function installClaudeSeatRouter(
  byName: Record<string, () => ProviderQuota>,
): void {
  PROVIDERS.claude = {
    id: "claude",
    label: "Claude",
    async fetchQuota(options) {
      const name = basename(options.claudeConfigDir ?? "");
      const build = byName[name];
      if (!build) throw new Error(`unexpected seat fixture: ${name}`);
      return build();
    },
    async inspectAuth() {
      return { provider: "claude", sources: [] };
    },
  };
}

function useFiveSeatFixtures(): string[] {
  const dirs = fiveSeatDirs();
  const sharedIdentity = {
    accountId: "acct-shared",
    identityStatus: "verified" as const,
  };
  installClaudeSeatRouter({
    // Healthy seat with live windows and an account identity.
    arcs: () => ({ ...freshClaudeQuota(), account: { ...sharedIdentity } }),
    // One seat rate-limited (HTTP 429) — bounded to itself.
    jr: () =>
      failedClaudeSeat("rate_limited", "Claude quota endpoint rate limited", {
        retryAfter: "2026-07-20T18:45:51Z",
      }),
    // Stale cached data still counts as usable.
    nyu: () => ({
      ...freshClaudeQuota(),
      source: "cache",
      state: {
        status: "stale",
        stale: true,
        refreshedAt: "2026-07-06T18:10:00Z",
        error: "Claude quota endpoint rate limited",
        sourcesTried: ["oauth", "cache"],
      },
    }),
    // Unavailable auth.
    ra: () => failedClaudeSeat("auth_required", "Claude sign-in required"),
    // Duplicate account identity of arcs — must still render as its own seat.
    yfz: () => ({ ...freshClaudeQuota(), account: { ...sharedIdentity } }),
  });
  return dirs;
}

function useAllFailingSeatFixtures(): string[] {
  const dirs = fiveSeatDirs();
  installClaudeSeatRouter({
    arcs: () =>
      failedClaudeSeat("rate_limited", "Claude quota endpoint rate limited", {
        retryAfter: "2026-07-20T18:45:51Z",
      }),
    jr: () =>
      failedClaudeSeat("rate_limited", "Claude quota endpoint rate limited", {
        retryAfter: "2026-07-20T18:44:00Z",
      }),
    nyu: () => failedClaudeSeat("auth_required", "Claude sign-in required"),
    ra: () => failedClaudeSeat("error", "Claude quota unavailable"),
    yfz: () =>
      failedClaudeSeat("unavailable", "Claude quota endpoint unavailable"),
  });
  return dirs;
}

function useAllFreshSeatFixtures(): string[] {
  const dirs = fiveSeatDirs();
  installClaudeSeatRouter(
    Object.fromEntries(
      FIVE_SEAT_NAMES.map((name) => [name, () => freshClaudeQuota()]),
    ),
  );
  return dirs;
}

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

function useMixedProviderFixtures(): [string, string] {
  const arcs = resolve("/private/customer/configs/arcs");
  const jr = resolve("/private/customer/configs/jr");
  PROVIDERS.claude = {
    id: "claude",
    label: "Claude",
    async fetchQuota(options) {
      if (options.claudeConfigDir === arcs) {
        return {
          ...freshClaudeQuota(),
          account: {
            email: "person@example.invalid",
            accountId: "fixture-secret-token",
          },
        };
      }
      return {
        provider: "claude",
        label: "Claude",
        source: "unavailable",
        windows: [],
        state: {
          status: "auth_required",
          stale: false,
          error: "Claude sign-in required",
          sourcesTried: ["oauth-file"],
        },
        attempts: [
          {
            source: "oauth-file",
            status: "skipped",
            error: "credentials_missing",
          },
        ],
      };
    },
    async inspectAuth(options) {
      return {
        provider: "claude",
        sources: [
          {
            source: "oauth-file",
            path: join(
              options.claudeConfigDir ?? "unexpected",
              ".credentials.json",
            ),
            status: options.claudeConfigDir === arcs ? "available" : "missing",
          },
        ],
      };
    },
  };
  PROVIDERS.codex = providerWithQuota(freshCodexQuota());
  PROVIDERS.grok = providerWithQuota(freshGrokQuota());
  return [arcs, jr];
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
      error: "Claude sign-in required",
      sourcesTried: ["oauth-file", "keychain", "cache"],
    },
    attempts: [
      {
        source: "oauth-file",
        status: "skipped",
        error: "credentials_expired",
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

function freshGrokQuota(): ProviderQuota {
  return {
    provider: "grok",
    label: "Grok",
    source: "api",
    plan: "supergrok",
    windows: [
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: 20,
        percentRemaining: 80,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-06T18:10:00Z",
      sourcesTried: ["api"],
    },
    attempts: [{ source: "api", status: "success" }],
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
