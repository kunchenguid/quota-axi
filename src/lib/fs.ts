import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export type JsonFileReadResult =
  | { status: "success"; value: unknown }
  | { status: "missing" }
  | { status: "invalid"; error: string };

export function collapseHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (!isAbsolute(path) && !startsWithHomePrefix(path, home)) return path;
  const relativePath = relative(home, path);
  if (relativePath === "") return "~";
  if (isHomeRelativePath(relativePath))
    return `~/${normalizeRelativePath(relativePath)}`;
  if (startsWithHomePrefix(path, home))
    return `~/${path.slice(home.length + 1).replace(/\\/g, "/")}`;
  return path;
}

function isHomeRelativePath(path: string): boolean {
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function normalizeRelativePath(path: string): string {
  return sep === "\\" ? path.replace(/\\/g, "/") : path;
}

function startsWithHomePrefix(path: string, home: string): boolean {
  const separator = path[home.length];
  return (
    separator !== undefined &&
    (separator === "/" || separator === "\\") &&
    samePath(path.slice(0, home.length), home)
  );
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32")
    return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

export function cacheFilePath(): string {
  return join(cacheDirPath(), "quotas.json");
}

export function claudeKeychainAccessMarkerPath(configDir?: string): string {
  const suffix = configDir
    ? `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`
    : "";
  return join(cacheDirPath(), `claude-keychain-access-granted${suffix}`);
}

function cacheDirPath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "quota-axi");
}

export function ensurePrivateParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
}

export function readJsonFile(file: string): unknown | undefined {
  const result = readJsonFileResult(file);
  return result.status === "success" ? result.value : undefined;
}

export function readJsonFileResult(file: string): JsonFileReadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "invalid", error: "file_read_error" };
  }
  try {
    return { status: "success", value: JSON.parse(text) };
  } catch {
    return { status: "invalid", error: "json_parse_error" };
  }
}

function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
