import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";

const PI_PROVIDER_ID = "cursor";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;
const MINIMUM_MILLISECOND_EPOCH = 1_000_000_000_000;

export type PiCursorCredentialResolution =
  | {
      status: "available";
      kind: "oauth" | "api_key";
      /** In-memory quota-probe use only; never log, render, persist, or hash. */
      credential: string;
    }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "unsupported" }
  | {
      status: "expired";
      /** Pi's standard OAuth record contains a refresh property. Presence only. */
      refreshable: boolean;
      /** Stored-expired access token retained only for the read-only liveness probe. */
      credential: string;
    }
  | { status: "error" };

export type PiCursorCredentialInspection = {
  path: string;
  status: PiCursorCredentialResolution["status"];
  refreshable?: boolean;
  error?: string;
};

export type PiCursorCredentialBroker = {
  resolve(): Promise<PiCursorCredentialResolution>;
  inspect(): Promise<PiCursorCredentialInspection>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

/** Strict, bounded, read-only reader for Pi's literal `cursor` entry. */
export function createPiCursorCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): PiCursorCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: Date.now,
    ...overrides,
  };

  return {
    resolve: () => resolveCredential(dependencies),
    inspect: async () =>
      inspectionFor(await resolveCredential(dependencies), dependencies),
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<PiCursorCredentialResolution> {
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(
      authFilePath(dependencies),
      AUTH_FILE_LIMIT_BYTES,
    );
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "invalid" };
  }

  const classified = classifyPiAuthEntry(parsed, PI_PROVIDER_ID);
  if (classified.status !== "present") return classified;
  const { entry } = classified;

  if (entry.type === "api_key") {
    const key = usableLiteralSecret(entry.key);
    if (key === undefined || !validOptionalEnvironment(entry)) {
      return { status: "invalid" };
    }
    return { status: "available", kind: "api_key", credential: key };
  }

  if (entry.type === "oauth") {
    const access = usableLiteralSecret(entry.access);
    const expires = millisecondTimestamp(entry.expires);
    // Pi's OAuth shape always has a string refresh value. quota-axi checks the
    // shape and property presence only; it never copies, sends, or exchanges it.
    const hasRefresh =
      Object.hasOwn(entry, "refresh") && typeof entry.refresh === "string";
    if (access === undefined || expires === undefined || !hasRefresh) {
      return { status: "invalid" };
    }
    if (expires <= dependencies.now()) {
      return {
        status: "expired",
        refreshable: true,
        credential: access,
      };
    }
    return { status: "available", kind: "oauth", credential: access };
  }

  return entry.type === undefined
    ? { status: "invalid" }
    : { status: "unsupported" };
}

function inspectionFor(
  resolution: PiCursorCredentialResolution,
  dependencies: BrokerDependencies,
): PiCursorCredentialInspection {
  const path = authFilePath(dependencies);
  if (resolution.status === "expired") {
    return {
      path,
      status: "expired",
      refreshable: resolution.refreshable,
      error: "credentials_expired_refreshable",
    };
  }
  if (resolution.status === "invalid") {
    return { path, status: "invalid", error: "invalid_credential" };
  }
  if (resolution.status === "unsupported") {
    return {
      path,
      status: "unsupported",
      error: "unsupported_credential_type",
    };
  }
  if (resolution.status === "error") {
    return {
      path,
      status: "error",
      error: "credential_resolution_failed",
    };
  }
  return { path, status: resolution.status };
}

function validOptionalEnvironment(entry: Record<string, unknown>): boolean {
  if (!Object.hasOwn(entry, "env")) return true;
  const environment = entry.env;
  return (
    environment !== null &&
    typeof environment === "object" &&
    !Array.isArray(environment) &&
    Object.values(environment).every((value) => typeof value === "string")
  );
}

function millisecondTimestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MINIMUM_MILLISECOND_EPOCH
    ? value
    : undefined;
}

function authFilePath(dependencies: BrokerDependencies): string {
  return join(piAgentDirectory(dependencies), "auth.json");
}

function piAgentDirectory(dependencies: BrokerDependencies): string {
  const home = () =>
    nonempty(dependencies.environment.HOME) ?? dependencies.homeDirectory();
  const configured = nonempty(dependencies.environment.PI_CODING_AGENT_DIR);
  if (configured === undefined) return join(home(), ".pi", "agent");
  if (configured === "~") return home();
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(home(), configured.slice(2));
  }
  return configured;
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

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
