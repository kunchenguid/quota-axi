import { delimiter, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseProviders } from "./providers/index.js";
import type { ProviderId } from "./types.js";

export type ClaudeConfigSource =
  | "cli"
  | "CLAUDE_CONFIG_DIRS"
  | "CLAUDE_CONFIG_DIR"
  | "default";

export type ClaudeConfigSelection = {
  directory?: string;
  keychainIdentity: string;
};

export type QuotaFlags = {
  providers: ProviderId[];
  json: boolean;
  full: boolean;
  allowKeychainPrompt: boolean;
  claudeConfigs?: ClaudeConfigSelection[];
};

/**
 * Parse the flags shared by the `quota` and `auth` commands. Command routing is
 * owned by {@link runAxiCli}; this only interprets the flags that follow.
 * `--full` is accepted by both commands but only consumed by `quota`.
 */
export function parseFlags(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): QuotaFlags {
  let providerValue: string | undefined;
  let json = false;
  let full = false;
  let allowKeychainPrompt = false;
  const cliClaudeConfigDirs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--allow-keychain-prompt") {
      allowKeychainPrompt = true;
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value) {
        throw new AxiError(
          "--provider requires a comma-separated provider list",
          "VALIDATION_ERROR",
          ["Pass --provider=... if the value begins with --"],
        );
      }
      providerValue = value;
      index++;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      providerValue = arg.slice("--provider=".length);
      continue;
    }
    if (arg === "--claude-config-dir") {
      const value = args[index + 1];
      if (!value || !value.trim() || value.trim().startsWith("--")) {
        throw new AxiError(
          "--claude-config-dir requires a directory path",
          "VALIDATION_ERROR",
          ["Pass --claude-config-dir=... if the path begins with --"],
        );
      }
      cliClaudeConfigDirs.push(value);
      index++;
      continue;
    }
    if (arg.startsWith("--claude-config-dir=")) {
      const value = arg.slice("--claude-config-dir=".length);
      if (!value.trim()) {
        throw new AxiError(
          "--claude-config-dir requires a directory path",
          "VALIDATION_ERROR",
        );
      }
      cliClaudeConfigDirs.push(value);
      continue;
    }
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `quota-axi --help` for supported commands and flags",
    ]);
  }

  const claudeConfig = selectClaudeConfigs(cliClaudeConfigDirs, env);
  return {
    providers: parseProviderScope(providerValue),
    json,
    full,
    allowKeychainPrompt,
    ...(claudeConfig.configs ? { claudeConfigs: claudeConfig.configs } : {}),
  };
}

export function selectClaudeConfigs(
  cliValues: string[],
  env: NodeJS.ProcessEnv = process.env,
): { configs?: ClaudeConfigSelection[]; source: ClaudeConfigSource } {
  if (cliValues.length > 0) {
    return { configs: normalizeConfigs(cliValues), source: "cli" };
  }

  const pluralValues = (env.CLAUDE_CONFIG_DIRS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pluralValues.length > 0) {
    return {
      configs: normalizeConfigs(pluralValues),
      source: "CLAUDE_CONFIG_DIRS",
    };
  }

  if (env.CLAUDE_CONFIG_DIR !== undefined) {
    return {
      configs: [{ keychainIdentity: env.CLAUDE_CONFIG_DIR.normalize("NFC") }],
      source: "CLAUDE_CONFIG_DIR",
    };
  }
  return { source: "default" };
}

function normalizeConfigs(values: string[]): ClaudeConfigSelection[] {
  const configs: ClaudeConfigSelection[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const keychainIdentity = value.trim().normalize("NFC");
    const directory = resolve(keychainIdentity).normalize("NFC");
    const key =
      process.platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push({ directory, keychainIdentity });
  }
  return configs;
}

function parseProviderScope(value: string | undefined): ProviderId[] {
  try {
    return parseProviders(value);
  } catch (error) {
    throw new AxiError(
      error instanceof Error ? error.message : "unsupported provider",
      "VALIDATION_ERROR",
      ["Supported providers: claude, codex, cursor, copilot, grok"],
    );
  }
}
