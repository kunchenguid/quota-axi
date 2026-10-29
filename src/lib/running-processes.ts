import { currentUserProcessListArgs, execFileText } from "./process.js";

/**
 * Read-only listing of the current user's running processes.
 *
 * quota-axi uses this only to answer "is the vendor already running?" before it
 * would delegate a credential refresh. It is deliberately narrow: it lists the
 * effective user's own processes, matches them in memory, and keeps nothing.
 * Command lines are never reported, cached, or logged, because another
 * process's argv can carry material that is none of quota-axi's business.
 *
 * "Unavailable" is a real answer, not an error: on Windows, without an
 * effective uid, or when `ps` cannot run, quota-axi does not know what else is
 * running and callers must treat that as "cannot prove it is safe".
 */

/** One `ps` call, well inside any provider budget. */
const PROCESS_LIST_TIMEOUT_MS = 4_000;

export type RunningProcess = {
  pid: number;
  commandLine: string;
  /** CLAUDE_CONFIG_DIR only; absent when environment ownership is unreadable. */
  claudeConfigDir?: string;
};

export type RunningProcessList =
  | { status: "listed"; processes: readonly RunningProcess[] }
  | { status: "unavailable" };

export async function listRunningCommandLines(): Promise<RunningProcessList> {
  if (process.platform === "win32") return { status: "unavailable" };
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) return { status: "unavailable" };
  try {
    const output = await execFileText(
      "ps",
      currentUserProcessListArgs(effectiveUid),
      PROCESS_LIST_TIMEOUT_MS,
    );
    const processes = output
      .split("\n")
      .map(parseProcessLine)
      .filter((entry): entry is RunningProcess => entry !== undefined);
    if (process.platform === "darwin") {
      for (const entry of processes) {
        if (!isClaudeCommand(entry.commandLine)) continue;
        entry.claudeConfigDir = await readClaudeConfigDir(entry.pid);
      }
    }
    return { status: "listed", processes };
  } catch {
    return { status: "unavailable" };
  }
}

function isClaudeCommand(commandLine: string): boolean {
  return (
    /(?:^|\/)claude(?:\s|$)/.test(commandLine) ||
    commandLine.includes("@anthropic-ai/claude-code/")
  );
}

async function readClaudeConfigDir(pid: number): Promise<string | undefined> {
  try {
    const output = await execFileText(
      "ps",
      ["eww", "-p", String(pid)],
      PROCESS_LIST_TIMEOUT_MS,
    );
    // Keep only the non-secret ownership hint; do not retain or expose the rest.
    const match = /(?:^|\s)CLAUDE_CONFIG_DIR=([^\s]+)/.exec(output);
    return match?.[1] ?? "";
  } catch {
    return undefined;
  }
}

function parseProcessLine(line: string): RunningProcess | undefined {
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, commandLine: match[2] };
}
