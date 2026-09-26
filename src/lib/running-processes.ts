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
    return {
      status: "listed",
      processes: output
        .split("\n")
        .map(parseProcessLine)
        .filter((entry): entry is RunningProcess => entry !== undefined),
    };
  } catch {
    return { status: "unavailable" };
  }
}

function parseProcessLine(line: string): RunningProcess | undefined {
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, commandLine: match[2] };
}
