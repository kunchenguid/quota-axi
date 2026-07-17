import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { authCommand, quotaCommand, type QuotaContext } from "./commands.js";

export const DESCRIPTION =
  "Report local agent-provider quota windows for routing-aware agents.";

export const TOP_HELP = `usage: quota-axi [auth] [flags]
commands[2]:
  (none)=quota, auth
flags[6]:
  --provider <claude,codex,cursor,copilot,grok>, --json, --full, --allow-keychain-prompt, --help, -v/--version
examples:
  quota-axi
  quota-axi --provider claude
  quota-axi --provider cursor,copilot,grok
  quota-axi --json
  quota-axi --full
  quota-axi auth
`;

const VERSION = readPackageVersion();

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
    },
    // `quota` is the implicit default command, so the bare-invocation home view
    // is never reached (see normalizeArgv); wiring it keeps the SDK contract.
    home: quotaCommand,
    resolveContext: () => ({ binPath }),
    getCommandHelp: (command) =>
      command === "quota" || command === "auth" ? TOP_HELP : undefined,
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
  if (first === "quota" || first === "auth" || first === "update") {
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
    if (arg === "--provider") {
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
    if (arg === "--provider") {
      index++;
      continue;
    }
    if (arg === "quota" || arg === "auth" || arg === "update") return index;
  }
  return -1;
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0)
      return parsed.version;
  }
  return "0.0.0";
}
