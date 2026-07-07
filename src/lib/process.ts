import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as path from "node:path";

export function execFileText(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
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

export async function commandExists(command: string): Promise<boolean> {
  const normalized = command.trim();
  if (normalized.length === 0) return false;
  for (const candidate of commandPathCandidates(normalized)) {
    if (await isExecutableFile(candidate)) return true;
  }
  return false;
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

export type SessionStdin = {
  write: (chunk: string) => void;
  writeAfter: (delayMs: number, chunk: string) => void;
};

export function spawnTextSession(
  command: string,
  args: string[],
  input: (stdin: SessionStdin) => void,
  timeoutMs: number,
  ready: (buffer: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    let settled = false;
    let buffer = "";
    const pendingTimers: NodeJS.Timeout[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const pending of pendingTimers) clearTimeout(pending);
      terminateChild(child);
      if (error) reject(error);
      else resolve(buffer);
    };
    const timer = setTimeout(
      () => finish(new Error("command timed out")),
      timeoutMs,
    );
    const write = (chunk: string) => {
      if (!settled && child.stdin.writable) child.stdin.write(chunk);
    };

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (ready(buffer)) {
        pendingTimers.push(setTimeout(() => finish(), 300));
      }
    });
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(new Error("command unavailable")));
    child.on("close", () => finish());
    input({
      write,
      writeAfter: (delayMs, chunk) => {
        pendingTimers.push(setTimeout(() => write(chunk), delayMs));
      },
    });
  });
}
