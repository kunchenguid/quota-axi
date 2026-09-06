import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/**
 * An opaque, deterministic cache-provenance identifier for the Claude profile
 * selected by the current process. The selected path never leaves this helper.
 */
export function claudeCredentialContextId(): string {
  const configDir = resolve(
    (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize(
      "NFC",
    ),
  );
  return createHash("sha256")
    .update(`claude-config-dir:${configDir}`)
    .digest("hex");
}

const KIMI_CONFIG_CONTEXT_LIMIT_BYTES = 256 * 1024;

/**
 * An opaque, deterministic cache-provenance identifier for the Kimi Code
 * environment selected by the current process.
 *
 * Kimi Code keeps one credential per deployment and records the current one in
 * `config.toml`, so switching between its `.com` and `.ai` deployments rewrites
 * that file. Hashing the file's bytes alongside the home that holds it is what
 * partitions cached Kimi snapshots by the configuration that produced them,
 * exactly as the Claude profile above partitions Claude's. Neither the path nor
 * any configured value leaves this helper.
 */
export function kimiCredentialContextId(): string {
  const codeHome = resolve(
    (
      process.env.KIMI_CODE_HOME ||
      join(process.env.HOME || homedir(), ".kimi-code")
    ).normalize("NFC"),
  );
  return createHash("sha256")
    .update(
      `kimi-code-home:${codeHome}\nconfig:${boundedFileDigest(
        join(codeHome, "config.toml"),
        KIMI_CONFIG_CONTEXT_LIMIT_BYTES,
      )}`,
    )
    .digest("hex");
}

/** A digest of a file's leading bytes, or a stable marker when there are none. */
function boundedFileDigest(path: string, maxBytes: number): string {
  let file: number;
  try {
    file = openSync(path, "r");
  } catch {
    return "absent";
  }
  try {
    const buffer = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const read = readSync(
        file,
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
    }
    return createHash("sha256")
      .update(buffer.subarray(0, offset))
      .digest("hex");
  } catch {
    return "unreadable";
  } finally {
    closeSync(file);
  }
}

export function claudeKeychainAccessMarkerPath(
  account: string,
  configDir?: string,
): string {
  const profileSuffix = configDir
    ? `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`
    : "";
  const accountSuffix = createHash("sha256")
    .update(account)
    .digest("hex")
    .slice(0, 16);
  return join(
    cacheDirPath(),
    `claude-keychain-access-granted${profileSuffix}-account-${accountSuffix}`,
  );
}

export function cursorCliKeychainAccessMarkerPath(account: string): string {
  const accountSuffix = createHash("sha256")
    .update(account)
    .digest("hex")
    .slice(0, 16);
  return join(
    cacheDirPath(),
    `cursor-cli-keychain-access-granted-account-${accountSuffix}`,
  );
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
