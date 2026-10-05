import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { traceInput } from "./input-trace.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  claudeEnvOauthToken,
  claudeProfileLocations,
} from "./claude-profile.js";

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
  const { configDir, keychainService } = claudeProfileLocations();
  // Include the exact service: it already encodes the secure-storage selector,
  // including a relative raw path hash.
  // Version the identity to withhold snapshots an earlier release wrote for
  // this same selection: `v2` covers former opaque discovery, `v3` the windows
  // 0.1.50 stored with `utilization`/`percent` read as remaining.
  //
  // An explicit environment token selects an account the profile path and
  // Keychain service do not describe, so it earns its own identity: a snapshot
  // taken with one must never be served as stale once it is gone. The marker is
  // appended only when such a token is supplied, so every existing profile
  // keeps the identity it already cached under. It is a presence marker, never
  // any part of the token.
  const envSelected = claudeEnvOauthToken() !== undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "claude-profile-v3",
        resolve(configDir),
        keychainService,
        ...(envSelected ? ["env-token"] : []),
      ]),
    )
    .digest("hex");
}

// The grant is per Keychain item, so the marker is keyed by the service the
// value read will name, which already encodes any explicit profile directory.
export function claudeKeychainAccessMarkerPath(
  account: string,
  service: string,
): string {
  const serviceSuffix = createHash("sha256")
    .update(service)
    .digest("hex")
    .slice(0, 8);
  const accountSuffix = createHash("sha256")
    .update(account)
    .digest("hex")
    .slice(0, 16);
  return join(
    cacheDirPath(),
    `claude-keychain-access-granted-${serviceSuffix}-account-${accountSuffix}`,
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

/** Non-secret proof scoped to the exact Copilot config path, service, and account. */
export function copilotCliKeychainAccessMarkerPath(
  path: string,
  service: string,
  account: string,
): string {
  const suffix = createHash("sha256")
    .update(JSON.stringify([resolve(path), service, account]))
    .digest("hex");
  return join(cacheDirPath(), `copilot-cli-keychain-access-granted-${suffix}`);
}

/** Non-secret proof scoped to the exact Muse Keychain service and account. */
export function museKeychainAccessMarkerPath(
  service: string,
  account: string,
): string {
  const suffix = createHash("sha256")
    .update(JSON.stringify([service, account]))
    .digest("hex");
  return join(cacheDirPath(), `muse-keychain-access-granted-${suffix}`);
}

/** Path of Muse's key-endpoint attempt ledger, beside the quota cache. */
export function museKeyReadLedgerPath(): string {
  return join(cacheDirPath(), "muse-key-reads.json");
}

/**
 * The recorded grant for a Keychain value read. `bound` ties the grant to the
 * item's non-secret modification fingerprint, observed when the granted value
 * read succeeded; `legacy` is the presence-only marker earlier versions wrote,
 * which names no item state.
 */
export type KeychainAccessGrant =
  | { status: "bound"; itemFingerprint: string }
  | { status: "legacy" }
  | { status: "missing" };

/**
 * Extracts the item's non-secret modification date (`mdat`) from the attribute
 * output of a `security find-generic-password` probe run without `-w`. Accepts
 * both timedate spellings security emits: printable text and the
 * hex-and-annotation form. Returns undefined when no fingerprint is present.
 */
export function parseKeychainItemFingerprint(
  probeOutput: string,
): string | undefined {
  const match = /^\s*"mdat"<timedate>=[ \t]*(\S[^\n]*?)[ \t]*$/m.exec(
    probeOutput,
  );
  if (!match) return undefined;
  const raw = match[1]!;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(raw)) return raw;
  const quoted = /^"(\d{14}Z)"$/.exec(raw)?.[1];
  if (quoted !== undefined) return quoted;
  const hex = /^0x((?:[0-9a-fA-F]{2})+)\s+"(\d{14}Z)\\000"$/.exec(raw);
  if (!hex) return undefined;
  const decoded = Buffer.from(hex[1]!, "hex").toString("utf8");
  return decoded === `${hex[2]}\0` ? hex[2] : undefined;
}

/** Reads the recorded grant, if any; an unreadable marker grants nothing. */
export function readKeychainAccessGrant(file: string): KeychainAccessGrant {
  traceInput(file);
  return readKeychainAccessGrantUntraced(file);
}

function readKeychainAccessGrantUntraced(file: string): KeychainAccessGrant {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { status: "missing" };
  }
  const content = text.trim();
  if (content === "granted") return { status: "legacy" };
  const prefix = "granted ";
  if (content.startsWith(prefix)) {
    const itemFingerprint = content.slice(prefix.length).trim();
    if (itemFingerprint.length > 0) return { status: "bound", itemFingerprint };
  }
  return { status: "missing" };
}

/**
 * Records the grant best-effort at `0600`, skipping the write when the file
 * already records the same grant. A whole-second fingerprint from the value
 * read's second or later is ambiguous, so it removes any prior binding instead.
 * An undefined fingerprint writes the legacy presence-only form, for stores
 * that expose no item modification metadata.
 */
export function writeKeychainAccessGrant(
  file: string,
  itemFingerprint: string | undefined,
  valueReadStartedAt: number,
): void {
  try {
    if (
      itemFingerprint !== undefined &&
      keychainFingerprintEpochSecond(itemFingerprint) >=
        Math.floor(valueReadStartedAt / 1000)
    ) {
      unlinkSync(file);
      return;
    }
    const existing = readKeychainAccessGrantUntraced(file);
    if (itemFingerprint === undefined) {
      if (existing.status === "legacy") return;
    } else if (
      existing.status === "bound" &&
      existing.itemFingerprint === itemFingerprint
    ) {
      return;
    }
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      itemFingerprint === undefined
        ? "granted\n"
        : `granted ${itemFingerprint}\n`,
      { mode: 0o600 },
    );
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

function keychainFingerprintEpochSecond(itemFingerprint: string): number {
  const generalized = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(
    itemFingerprint,
  );
  if (generalized) {
    return Math.floor(
      Date.UTC(
        Number(generalized[1]),
        Number(generalized[2]) - 1,
        Number(generalized[3]),
        Number(generalized[4]),
        Number(generalized[5]),
        Number(generalized[6]),
      ) / 1000,
    );
  }
  const printable =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
      itemFingerprint,
    );
  if (!printable) return Number.NaN;
  return Math.floor(
    Date.parse(
      `${printable[1]}T${printable[2]}${printable[3]}${printable[4]}:${printable[5]}`,
    ) / 1000,
  );
}

/**
 * Whether a recorded grant permits a plain-call macOS Keychain value read.
 * Only a grant bound to the current item fingerprint authorizes, so a failed
 * probe, a legacy marker, or an item rewritten since the grant is never read.
 * Stores without item fingerprints apply their own presence-only policy.
 */
export function keychainAccessGrantPermitsRead(
  grant: KeychainAccessGrant,
  itemFingerprint: string | undefined,
): boolean {
  return (
    itemFingerprint !== undefined &&
    grant.status === "bound" &&
    grant.itemFingerprint === itemFingerprint
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
  traceInput(file);
  return readUntracedJsonFileResult(file);
}

/**
 * The same read without recording it as an input of the current reading, for
 * quota-axi's own state such as the cache, which every write changes.
 */
export function readUntracedJsonFile(file: string): unknown | undefined {
  const result = readUntracedJsonFileResult(file);
  return result.status === "success" ? result.value : undefined;
}

function readUntracedJsonFileResult(file: string): JsonFileReadResult {
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

/**
 * Read at most `maxBytes + 1` bytes, so a caller can tell an oversized file from
 * one that fits without ever holding more than its own limit in memory.
 */
export async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  traceInput(path);
  const file = await open(path, "r");
  try {
    const contents = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await file.read(
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return Buffer.from(contents.buffer, contents.byteOffset, offset);
  } finally {
    await file.close();
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
