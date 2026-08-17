import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_PROVIDER_ID = "zai";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

export type ZaiCredentialResolution =
  | {
      status: "available";
      kind: "oauth" | "api_key";
      /** Present only for in-memory probe use; never log or render. */
      credential: string;
    }
  | { status: "missing" }
  | { status: "expired"; refreshable: boolean }
  | { status: "unsupported" }
  | { status: "error" };

export type ZaiCredentialInspection =
  | Exclude<ZaiCredentialResolution["status"], "available">
  | "available";

export type ZaiCredentialBroker = {
  resolve(): Promise<ZaiCredentialResolution>;
  inspect(): Promise<ZaiCredentialInspection>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

export function createPiZaiCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): ZaiCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: () => Date.now(),
    ...overrides,
  };

  const inspect = async (): Promise<ZaiCredentialInspection> =>
    (await resolveCredential(dependencies)).status;

  return {
    resolve: () => resolveCredential(dependencies),
    inspect,
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<ZaiCredentialResolution> {
  const path = authFilePath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) {
    return { status: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "missing" };
  }

  const root = objectValue(parsed);
  if (!root) return { status: "missing" };

  const entry = objectValue(root[PI_PROVIDER_ID]);
  if (!entry) return { status: "missing" };

  // Pi stores a `zai` login as either the literal Coding Plan API key or an
  // OAuth record. Both are read in place: an expired OAuth record is reported
  // as expired rather than refreshed, because refreshing would mutate Pi's
  // auth state.
  const type = stringValue(entry.type)?.toLowerCase();
  if (type === "api_key") {
    const apiKey = usableLiteralSecret(entry.key);
    return apiKey !== undefined
      ? { status: "available", kind: "api_key", credential: apiKey }
      : { status: "missing" };
  }
  if (type === "oauth") {
    const access = usableLiteralSecret(entry.access);
    if (access === undefined) return { status: "missing" };
    const hasExpiry = Object.hasOwn(entry, "expires");
    const expiresMs = timestampMs(entry.expires);
    if (hasExpiry && expiresMs === undefined) return { status: "missing" };
    if (expiresMs !== undefined && expiresMs <= dependencies.now()) {
      return {
        status: "expired",
        refreshable: usableLiteralSecret(entry.refresh) !== undefined,
      };
    }
    return { status: "available", kind: "oauth", credential: access };
  }
  if (type === undefined) return { status: "missing" };
  return { status: "unsupported" };
}

function authFilePath(dependencies: BrokerDependencies): string {
  return join(piAgentDirectory(dependencies), "auth.json");
}

function piAgentDirectory(dependencies: BrokerDependencies): string {
  const home = () =>
    nonempty(dependencies.environment.HOME) ?? dependencies.homeDirectory();
  const configured = nonempty(dependencies.environment.PI_CODING_AGENT_DIR);
  if (configured === undefined) {
    return join(home(), ".pi", "agent");
  }
  if (configured === "~") return home();
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(home(), configured.slice(2));
  }
  return configured;
}

function usableLiteralSecret(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  // Reject environment, template, and command references without resolving them.
  if (value.startsWith("!") || value.includes("$")) {
    return undefined;
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
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

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Pi stores OAuth expiry as epoch milliseconds.
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
