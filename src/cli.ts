import { runAxiCli } from "axi-sdk-js";
import {
  authCommand,
  coverageCommand,
  quotaCommand,
  type QuotaContext,
} from "./commands.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Report local agent-provider quota windows for routing-aware agents.";

export const TOP_HELP = `usage: quota-axi [auth|coverage] [flags]
commands[3]:
  (none)=quota, auth, coverage
quota/auth flags[7]:
  --provider <claude,codex,cursor,copilot,grok,kimi>, --claude-config-dir <path> (repeatable), --json, --full, --allow-keychain-prompt, --help, -v/--version
coverage flags[2]:
  --json, --help
examples:
  quota-axi
  quota-axi --provider claude
  quota-axi --provider claude,codex --claude-config-dir ~/.claude-work --claude-config-dir ~/.claude-personal
  quota-axi --provider cursor,copilot,grok,kimi
  quota-axi --json
  quota-axi --full
  quota-axi auth
  quota-axi coverage
`;

type MainOptions = {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  binPath?: string;
};

export async function main(options: MainOptions = {}): Promise<void> {
  const binPath = options.binPath ?? process.argv[1] ?? "quota-axi";
  const argv = normalizeArgv(options.argv ?? process.argv.slice(2));

  await runAxiCli<QuotaContext>({
    argv,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    commands: {
      quota: quotaCommand,
      auth: authCommand,
      coverage: coverageCommand,
    },
    // `quota` is the implicit default command, so the bare-invocation home view
    // is never reached (see normalizeArgv); wiring it keeps the SDK contract.
    home: quotaCommand,
    resolveContext: () => ({ binPath }),
    getCommandHelp: (command) =>
      command === "quota" || command === "auth" || command === "coverage"
        ? TOP_HELP
        : undefined,
  });
}

/**
 * Route the flag-first default surface onto the `quota` command. `quota-axi`,
 * `quota-axi --json`, and `quota-axi --provider claude` all mean "run quota",
 * but runAxiCli routes on argv[0] and rejects a leading flag. Prefixing the
 * implicit `quota` command name preserves the historical surface while letting
 * the SDK own routing, help, version, and error framing.
 */
export function normalizeArgv(raw: string[]): string[] {
  if (raw.length === 0) return ["quota"];
  if (findLegacyFlag(raw, (arg) => arg === "--help" || arg === "-h") >= 0) {
    return ["--help"];
  }
  const versionIndex = findLegacyFlag(raw, isVersionFlag);
  if (versionIndex >= 0) {
    return [raw[versionIndex]];
  }
  const commandIndex = findCommand(raw);
  if (commandIndex > 0) {
    return [
      raw[commandIndex],
      ...raw.slice(0, commandIndex),
      ...raw.slice(commandIndex + 1),
    ];
  }
  const first = raw[0];
  if (raw.length === 1 && isTopLevelFlag(first)) {
    return raw;
  }
  if (
    first === "quota" ||
    first === "auth" ||
    first === "coverage" ||
    first === "update"
  ) {
    return raw;
  }
  if (first.startsWith("-")) {
    return ["quota", ...raw];
  }
  return raw;
}

function isTopLevelFlag(flag: string): boolean {
  return flag === "--help" || isVersionFlag(flag);
}

function isVersionFlag(flag: string): boolean {
  return flag === "-v" || flag === "-V" || flag === "--version";
}

function findLegacyFlag(
  raw: string[],
  predicate: (arg: string) => boolean,
): number {
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index];
    if (takesValue(arg)) {
      index++;
      continue;
    }
    if (predicate(arg)) return index;
  }
  return -1;
}

function findCommand(raw: string[]): number {
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index];
    if (takesValue(arg)) {
      index++;
      continue;
    }
    if (
      arg === "quota" ||
      arg === "auth" ||
      arg === "coverage" ||
      arg === "update"
    )
      return index;
  }
  return -1;
}

function takesValue(flag: string): boolean {
  return flag === "--provider" || flag === "--claude-config-dir";
}
