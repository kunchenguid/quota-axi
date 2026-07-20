import type { ClaudeConfigSelection } from "./args.js";

export function withClaudeConfigFlags(
  command: string,
  configs: ClaudeConfigSelection[] | undefined,
): string {
  const identities = configs
    ?.map((config) => config.keychainIdentity)
    .filter(Boolean);
  if (!identities || identities.length === 0) return command;
  const flags = identities
    .map((identity) => `--claude-config-dir=${quoteCommandArgument(identity)}`)
    .join(" ");
  return `${command} ${flags}`;
}

function quoteCommandArgument(value: string): string {
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}
