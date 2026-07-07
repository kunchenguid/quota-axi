import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JsonFileReadResult =
  | { status: "success"; value: unknown }
  | { status: "missing" }
  | { status: "invalid"; error: string };

export function collapseHome(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function cacheFilePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "quota-axi", "quotas.json");
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
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
