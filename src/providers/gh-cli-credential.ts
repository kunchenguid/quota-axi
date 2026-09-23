import { homedir } from "node:os";
import { join } from "node:path";
import { readBoundedFile } from "../lib/fs.js";
import { usableLiteralSecret } from "../lib/secret.js";

/**
 * The GitHub CLI (`gh`) login, read in place as a GitHub Copilot credential.
 *
 * Current Copilot sign-ins no longer write `github-copilot/apps.json`, and the
 * Copilot CLI accepts a `gh` OAuth token as a Copilot credential, so the `gh`
 * login is often the one a signed-in user actually has. quota-axi reads the
 * token `gh` itself would send to `github.com` and uses it only as the bearer of
 * GitHub's first-party Copilot user request - the host `gh` already sends it to.
 *
 * `gh` keeps that token in `hosts.yml` only when it stores credentials in plain
 * text; otherwise the token lives in the OS keyring. The keyring is never read,
 * and `gh` is never launched to print a token: a keyring login is recorded as a
 * skipped source. A `gh` login is not evidence of Copilot access; the adapter
 * owns the final verdict (see README Provider notes).
 *
 * The reader is deliberately narrow rather than a YAML dependency. It walks the
 * block mappings `gh` writes and keeps exactly one value, the `github.com`
 * host's own `oauth_token`, which is the token `gh` resolves for that host
 * before it looks in the keyring. Enterprise hosts, per-user token copies, and
 * every other key are parsed past and never kept.
 */
export const GH_CLI_CREDENTIAL_SOURCE = "gh:hosts.yml";

/** The only host whose token may reach the public Copilot user endpoint. */
const PUBLIC_GITHUB_HOST = "github.com";
const TOKEN_KEY = "oauth_token";
const HOSTS_FILE_LIMIT_BYTES = 64 * 1024;

export type GhCliCredentialResolution =
  /** No `hosts.yml`, or one with no `github.com` login. */
  | { status: "absent"; path: string }
  /** The file exists but is not a `hosts.yml` this reader can walk. */
  | { status: "structurally_invalid"; path: string }
  /** A `github.com` login whose token `gh` keeps in the OS keyring. */
  | { status: "unsupported"; path: string }
  /** The file exists but could not be read. */
  | { status: "read_error"; path: string }
  | {
      status: "resolved";
      path: string;
      /** Probe use only; never log, render, or cache. */
      token: string;
    };

type GhCliCredentialDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

/**
 * `gh`'s own configuration directory precedence: `GH_CONFIG_DIR`, then
 * `XDG_CONFIG_HOME/gh`, then `AppData/GitHub CLI` on Windows, then
 * `~/.config/gh`.
 */
export function ghCliHostsPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: () => string = homedir,
): string {
  const configDir = environment.GH_CONFIG_DIR
    ? environment.GH_CONFIG_DIR
    : environment.XDG_CONFIG_HOME
      ? join(environment.XDG_CONFIG_HOME, "gh")
      : platform === "win32" && environment.AppData
        ? join(environment.AppData, "GitHub CLI")
        : join(homeDirectory(), ".config", "gh");
  return join(configDir, "hosts.yml");
}

export async function resolveGhCliCredential(
  overrides: Partial<GhCliCredentialDependencies> = {},
): Promise<GhCliCredentialResolution> {
  const dependencies: GhCliCredentialDependencies = {
    environment: process.env,
    platform: process.platform,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    ...overrides,
  };
  const path = ghCliHostsPath(
    dependencies.environment,
    dependencies.platform,
    dependencies.homeDirectory,
  );

  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, HOSTS_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "absent", path }
      : { status: "read_error", path };
  }
  if (contents.byteLength > HOSTS_FILE_LIMIT_BYTES) {
    return { status: "structurally_invalid", path };
  }

  const scanned = scanHostsFile(contents.toString("utf8"));
  if (scanned.status === "invalid") {
    return { status: "structurally_invalid", path };
  }
  if (scanned.host === "absent") return { status: "absent", path };
  if (scanned.host !== "mapping" || scanned.token === "non_scalar") {
    return { status: "structurally_invalid", path };
  }
  /**
   * `gh` falls back to the keyring whenever the host carries no token of its
   * own, which is exactly how a secure-storage login is written.
   */
  if (scanned.token === undefined || scanned.token === "") {
    return { status: "unsupported", path };
  }
  const token = usableLiteralSecret(scanned.token);
  return token === undefined
    ? { status: "structurally_invalid", path }
    : { status: "resolved", path, token };
}

type ScannedHosts =
  | { status: "invalid" }
  | {
      status: "read";
      /** What the first `github.com` key holds. */
      host: "absent" | "mapping" | "other";
      /** The host's own token scalar, or `non_scalar` for a nested value. */
      token?: string | "non_scalar";
    };

type Frame = {
  /** Indentation of this mapping's keys, fixed by its first key. */
  indent: number;
  /** Key path from the document root to this mapping. */
  path: string[];
  /** Keys already seen here; `gh` resolves a repeated key to its first entry. */
  seen: Set<string>;
  /** True under a repeated key, whose contents `gh` never reads. */
  shadowed: boolean;
};

/**
 * Walks the block mappings of a `hosts.yml` line by line. Anything outside the
 * plain shape `gh` writes - sequences, flow collections spanning lines, block
 * scalars, anchors, tabs in indentation - makes the whole document unreadable
 * rather than guessed at, because a misread structure could attribute one
 * host's token to another.
 */
function scanHostsFile(text: string): ScannedHosts {
  const result: Extract<ScannedHosts, { status: "read" }> = {
    status: "read",
    host: "absent",
  };
  const stack: Frame[] = [];
  /** The last key read with nothing after its colon. */
  let pending: { indent: number; path: string[]; shadowed: boolean } | null =
    null;
  let sawContent = false;

  /** A pending key with no deeper line under it holds an empty value. */
  const recordEmpty = (key: NonNullable<typeof pending>): void => {
    if (key.shadowed) return;
    if (isHostPath(key.path)) result.host = "other";
    if (isTokenPath(key.path)) result.token = "";
  };

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const indentMatch = /^[ \t]*/.exec(rawLine);
    const leading = indentMatch ? indentMatch[0] : "";
    const content = rawLine.slice(leading.length);
    if (content === "" || content.startsWith("#")) continue;
    if (leading.includes("\t")) return { status: "invalid" };
    if (!sawContent && leading === "" && /^---\s*(#.*)?$/.test(content)) {
      sawContent = true;
      continue;
    }
    sawContent = true;
    const indent = leading.length;

    if (pending && indent > pending.indent) {
      stack.push({
        indent,
        path: pending.path,
        seen: new Set(),
        shadowed: pending.shadowed,
      });
      if (!pending.shadowed) {
        if (isHostPath(pending.path)) result.host = "mapping";
        if (isTokenPath(pending.path)) result.token = "non_scalar";
      }
    } else if (pending) {
      recordEmpty(pending);
    }
    pending = null;

    if (stack.length === 0) {
      stack.push({ indent, path: [], seen: new Set(), shadowed: false });
    }
    while (stack.length > 1 && stack[stack.length - 1].indent > indent) {
      stack.pop();
    }
    const frame = stack[stack.length - 1];
    if (frame.indent !== indent) return { status: "invalid" };

    const entry = parseEntry(content);
    if (!entry) return { status: "invalid" };
    const path = [...frame.path, entry.key];
    const shadowed = frame.shadowed || frame.seen.has(entry.key);
    frame.seen.add(entry.key);

    if (entry.value === undefined) {
      pending = { indent, path, shadowed };
      continue;
    }
    if (shadowed) continue;
    if (isHostPath(path)) result.host = "other";
    if (isTokenPath(path)) {
      const token = scalarValue(entry.value);
      if (token === undefined) return { status: "invalid" };
      result.token = token;
    }
  }

  if (pending) recordEmpty(pending);
  return result;
}

function isHostPath(path: string[]): boolean {
  return path.length === 1 && path[0] === PUBLIC_GITHUB_HOST;
}

function isTokenPath(path: string[]): boolean {
  return (
    path.length === 2 && path[0] === PUBLIC_GITHUB_HOST && path[1] === TOKEN_KEY
  );
}

/**
 * One `key:` or `key: value` line. The value is returned raw, so only the one
 * scalar this reader keeps is ever interpreted.
 */
function parseEntry(
  content: string,
): { key: string; value: string | undefined } | undefined {
  let key: string;
  let rest: string;
  if (content.startsWith("'") || content.startsWith('"')) {
    const quoted = readQuoted(content);
    if (!quoted || !quoted.rest.startsWith(":")) return undefined;
    key = quoted.value;
    rest = quoted.rest.slice(1);
  } else {
    if (/^[-?:,[\]{}#&*!|>%@`]/.test(content)) return undefined;
    const separator = /:(?=\s|$)/.exec(content);
    if (!separator) return undefined;
    key = content.slice(0, separator.index).trimEnd();
    rest = content.slice(separator.index + 1);
  }
  if (key === "") return undefined;
  if (rest !== "" && !/^\s/.test(rest)) return undefined;
  const value = rest.trim();
  if (value === "" || value.startsWith("#")) return { key, value: undefined };
  return { key, value };
}

/**
 * A single-line scalar: plain, single-quoted, or double-quoted without escape
 * sequences. Anything that could continue onto later lines or name another
 * node is refused.
 */
function scalarValue(value: string): string | undefined {
  if (value.startsWith("'") || value.startsWith('"')) {
    const quoted = readQuoted(value);
    if (!quoted) return undefined;
    const trailing = quoted.rest.trim();
    return trailing === "" || trailing.startsWith("#")
      ? quoted.value
      : undefined;
  }
  if (/^[-?:,[\]{}&*!|>%@`]/.test(value)) return undefined;
  const comment = /\s#/.exec(value);
  return (comment ? value.slice(0, comment.index) : value).trimEnd();
}

function readQuoted(text: string): { value: string; rest: string } | undefined {
  const quote = text[0];
  let value = "";
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === "\\") return undefined;
    if (char !== quote) {
      value += char;
      continue;
    }
    if (quote === "'" && text[index + 1] === "'") {
      value += "'";
      index += 1;
      continue;
    }
    return { value, rest: text.slice(index + 1) };
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
