import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandExists, execFileText } from "../lib/process.js";

export const CURSOR_CLI_CREDENTIAL_SOURCE = "cursor-cli-auth";

/** Used whenever `cursor-agent --version` cannot be resolved or validated. */
export const DEFAULT_CURSOR_CLIENT_VERSION = "unknown";

const CREDENTIAL_FILE_LIMIT_BYTES = 1024 * 1024;
const CLIENT_VERSION_TIMEOUT_MS = 5_000;
// Intentionally matches the ESC control character to strip ANSI escapes
// from subprocess stdout before it is validated for use as an HTTP header
// value (PRD R5).
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const CLIENT_VERSION_PATTERN = /^[\w.+-]{1,64}$/;

export type CursorCliCredentialResolution =
  | { status: "available"; accessToken: string; clientVersion: string }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "skipped"; reason: "unsupported_platform" };

export type CursorCliCredentialInspection =
  CursorCliCredentialResolution["status"];

export type CursorCliCredentialSource = {
  resolve(): Promise<CursorCliCredentialResolution>;
  inspect(): Promise<CursorCliCredentialInspection>;
};

type CredentialSourceDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  platform: () => NodeJS.Platform;
  now: () => number;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  commandExists: (command: string) => Promise<boolean>;
  execFileText: (
    command: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<string>;
};

export function cursorCliAuthPath(
  overrides: Partial<
    Pick<CredentialSourceDependencies, "environment" | "homeDirectory">
  > = {},
): string {
  const environment = overrides.environment ?? process.env;
  const homeDirectory = overrides.homeDirectory ?? homedir;
  const configured = nonempty(environment.CURSOR_CLI_AUTH_JSON);
  if (configured) return configured;
  const home = nonempty(environment.HOME) ?? homeDirectory();
  const configHome =
    nonempty(environment.XDG_CONFIG_HOME) ?? join(home, ".config");
  return join(configHome, "cursor", "auth.json");
}

export function createCursorCliCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): CursorCliCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    platform: () => process.platform,
    now: Date.now,
    readFile: readBoundedFile,
    commandExists,
    execFileText,
    ...overrides,
  };

  const inspect = async (): Promise<CursorCliCredentialInspection> =>
    (await resolveCredential(dependencies)).status;

  return {
    resolve: () => resolveCredential(dependencies),
    inspect,
  };
}

async function resolveCredential(
  dependencies: CredentialSourceDependencies,
): Promise<CursorCliCredentialResolution> {
  if (dependencies.platform() === "win32") {
    return { status: "skipped", reason: "unsupported_platform" };
  }

  const path = cursorCliAuthPath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, CREDENTIAL_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  }
  if (contents.byteLength > CREDENTIAL_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    return { status: "invalid" };
  }

  const auth = objectValue(parsed);
  const accessToken =
    typeof auth?.accessToken === "string" ? auth.accessToken.trim() : "";
  if (!accessToken) return { status: "invalid" };

  const expirySeconds = jwtExpirySeconds(accessToken);
  if (
    expirySeconds !== undefined &&
    expirySeconds <= dependencies.now() / 1_000
  ) {
    return { status: "expired" };
  }

  const clientVersion = await resolveClientVersion(dependencies);
  return { status: "available", accessToken, clientVersion };
}

/**
 * Best-effort JWT `exp` extraction (PRD R4). Never throws: a token that is
 * not a parseable JWT yields `undefined`, which the caller treats as
 * "expiry unknown" rather than a failure — the API's own 401 is the
 * authority in that case.
 */
function jwtExpirySeconds(token: string): number | undefined {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  try {
    const payload = objectValue(
      JSON.parse(base64UrlDecode(segments[1])) as unknown,
    );
    const exp = payload?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(paddingLength), "base64").toString(
    "utf8",
  );
}

/**
 * Resolves `cursor-agent --version` for the `x-cursor-client-version`
 * header. Always returns a validated, header-safe string: ANSI-stripped,
 * trimmed, and charset-checked before use (PRD R5/R6). Any failure —
 * missing binary, timeout, or a value that fails validation — falls back to
 * DEFAULT_CURSOR_CLIENT_VERSION and never blocks credential resolution.
 */
async function resolveClientVersion(
  dependencies: CredentialSourceDependencies,
): Promise<string> {
  try {
    if (!(await dependencies.commandExists("cursor-agent"))) {
      return DEFAULT_CURSOR_CLIENT_VERSION;
    }
    const output = await dependencies.execFileText(
      "cursor-agent",
      ["--version"],
      CLIENT_VERSION_TIMEOUT_MS,
    );
    const sanitized = output.replace(ANSI_ESCAPE_PATTERN, "").trim();
    return CLIENT_VERSION_PATTERN.test(sanitized)
      ? sanitized
      : DEFAULT_CURSOR_CLIENT_VERSION;
  } catch {
    return DEFAULT_CURSOR_CLIENT_VERSION;
  }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
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

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
