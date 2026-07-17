import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFlags } from "../src/args.js";
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
    expect(parseFlags(["--json", "--full", "--allow-keychain-prompt"])).toEqual(
      {
        providers: ["claude", "codex", "cursor", "copilot", "grok"],
        json: true,
        full: true,
        allowKeychainPrompt: true,
      },
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
