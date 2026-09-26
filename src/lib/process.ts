import { execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as path from "node:path";

export type ExecFileTextOptions = {
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
};

export function execFileText(
  command: string,
  args: string[],
  timeoutMs: number,
  optionsOrMaxBuffer: ExecFileTextOptions | number = {},
): Promise<string> {
  const options =
    typeof optionsOrMaxBuffer === "number"
      ? { maxBufferBytes: optionsOrMaxBuffer }
      : optionsOrMaxBuffer;
  return new Promise((resolve, reject) => {
    let invocation: ReturnType<typeof shimInvocation>;
    try {
      invocation = shimInvocation(command, args, options.env);
    } catch (error) {
      reject(error);
      return;
    }
    execFile(
      invocation.command,
      invocation.args,
      {
        timeout: timeoutMs,
        // A busy multi-agent host's full `ps` table with command lines runs
        // well past 1 MiB, which surfaced as an unexplained probe failure.
        maxBuffer: options.maxBufferBytes ?? 16 * 1024 * 1024,
        ...(invocation.environment
          ? { env: invocation.environment }
          : options.env
            ? { env: options.env }
            : {}),
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function shimInvocation(
  command: string,
  args: string[],
  childEnvironment?: NodeJS.ProcessEnv,
): {
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
} {
  if (
    process.platform !== "win32" ||
    ![".cmd", ".bat"].includes(path.win32.extname(command).toLowerCase())
  ) {
    return { command, args };
  }
  const environment: NodeJS.ProcessEnv = {
    ...(childEnvironment ?? process.env),
    QUOTA_AXI_COMMAND: validateWindowsArgument(command),
    ...Object.fromEntries(
      args.map((argument, index) => [
        `QUOTA_AXI_ARG_${index}`,
        validateWindowsArgument(argument),
      ]),
    ),
  };
  const script = [
    "$command = [Environment]::GetEnvironmentVariable('QUOTA_AXI_COMMAND')",
    "$arguments = @(",
    ...args.map(
      (_, index) =>
        `[Environment]::GetEnvironmentVariable('QUOTA_AXI_ARG_${index}')`,
    ),
    ")",
    "& $command @arguments",
    "exit $LASTEXITCODE",
  ].join(";");
  return {
    command: powershellPath(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    environment,
  };
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return systemRoot
    ? path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

function validateWindowsArgument(value: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      throw new TypeError("Windows command arguments cannot contain controls");
    }
  }
  return value;
}

export async function commandExists(command: string): Promise<boolean> {
  return (await findCommandPath(command)) !== undefined;
}

export async function findCommandPath(
  command: string,
): Promise<string | undefined> {
  const normalized = command.trim();
  if (normalized.length === 0) return undefined;
  for (const candidate of commandPathCandidates(normalized)) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function commandPathCandidates(command: string): string[] {
  if (hasPathSeparator(command)) return executableCandidates(command);
  const pathValue = process.env.PATH;
  if (!pathValue) return [];
  const pathApi = process.platform === "win32" ? path.win32 : path;
  const delimiter =
    process.platform === "win32" ? path.win32.delimiter : path.delimiter;
  return pathValue
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, "") || ".")
    .flatMap((entry) => executableCandidates(pathApi.join(entry, command)));
}

function executableCandidates(file: string): string[] {
  if (process.platform !== "win32") return [file];
  const pathApi = path.win32;
  if (pathApi.extname(file)) return [file];
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${file}${extension}`);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(
      file,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

export function terminateChild(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill("SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) return;
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 2000);
  forceKill.unref();
  child.once("exit", () => clearTimeout(forceKill));
}

// Linux procps rejects the BSD `-x` selector alongside `-u` ("must set
// personality to get -x option"), so only macOS/BSD gets it. Both list the
// current user's processes including ones without a controlling terminal.
export function currentUserProcessListArgs(effectiveUid: number): string[] {
  const selector =
    process.platform === "linux"
      ? ["-u", String(effectiveUid)]
      : ["-x", "-u", String(effectiveUid)];
  return [...selector, "-o", "pid=,command="];
}
