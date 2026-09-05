import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { usableLiteralSecret } from "../lib/secret.js";

const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

export type PiApiKeyCredentialResolution =
  | {
      status: "available";
      /** The Pi auth.json entry id the credential was read from. */
      providerId: string;
      /** Present only for in-memory quota use; never logged or rendered. */
      credential: string;
    }
  | { status: "missing" }
  | {
      status: "invalid";
      /** The entry whose key was unusable, so reports name the culprit. */
      providerId: string;
    }
  | {
      status: "unsupported";
      /** The entry whose credential type is not an API key. */
      providerId: string;
    }
  | { status: "error" };

export type PiApiKeyCredentialInspection =
  | { status: "available"; providerId: string }
  | { status: "missing"; providerId: string }
  | {
      status: "invalid";
      providerId: string;
      error: "invalid_credential" | "invalid_auth_file";
    }
  | {
      status: "unsupported";
      providerId: string;
      error: "unsupported_credential_type";
    }
  | {
      status: "error";
      providerId: string;
      error: "credential_resolution_failed";
    };

export type PiApiKeyCredentialBroker = {
  /** Ordered Pi auth.json entry ids this broker reads; the first is primary. */
  providerIds: readonly string[];
  resolve(): Promise<PiApiKeyCredentialResolution>;
  inspect(): Promise<PiApiKeyCredentialInspection>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

/**
 * Read-only broker for Pi auth.json entries that store a literal API key
 * (`{ "type": "api_key", "key": "..." }`), in place, for providers whose
 * quota endpoint authenticates with that key directly. The file is never
 * written, credential references (`!command`, `$ENV`) are never resolved,
 * and no credential material leaves `resolve()`'s return value.
 */
export function createPiApiKeyCredentialBroker(
  providerIds: readonly string[],
  overrides: Partial<BrokerDependencies> = {},
): PiApiKeyCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    ...overrides,
  };

  return {
    providerIds,
    resolve: () => resolveCredential(providerIds, dependencies),
    inspect: () => inspectCredential(providerIds, dependencies),
  };
}

/**
 * Ordered-entry fallthrough mirrors the opencode source's first-usable-key
 * scan: an entry that holds no typed credential or an unusable key is
 * skipped in favor of later ids, and its problem is only reported when no
 * listed entry yields a usable literal key.
 */
async function resolveCredential(
  providerIds: readonly string[],
  dependencies: BrokerDependencies,
): Promise<PiApiKeyCredentialResolution> {
  const parsed = await readPiAuth(dependencies);
  if (typeof parsed === "string") {
    // A file-level failure has no responsible entry; the primary id reports it.
    return parsed === "missing"
      ? { status: "missing" }
      : parsed === "invalid"
        ? { status: "invalid", providerId: providerIds[0] ?? "" }
        : { status: "error" };
  }
  const root = parsed;
  let firstProblem:
    | { status: "invalid" | "unsupported"; providerId: string }
    | undefined;
  for (const providerId of providerIds) {
    const entry = objectValue(root[providerId]);
    if (!entry) continue;
    const type =
      typeof entry.type === "string"
        ? entry.type.trim().toLowerCase()
        : undefined;
    if (type === "api_key") {
      const apiKey = usableLiteralSecret(entry.key);
      if (apiKey !== undefined) {
        return { status: "available", providerId, credential: apiKey };
      }
      firstProblem ??= { status: "invalid", providerId };
      continue;
    }
    if (type === undefined) continue;
    firstProblem ??= { status: "unsupported", providerId };
  }
  return firstProblem ?? { status: "missing" };
}

async function inspectCredential(
  providerIds: readonly string[],
  dependencies: BrokerDependencies,
): Promise<PiApiKeyCredentialInspection> {
  const primary = providerIds[0] ?? "";
  const resolution = await resolveCredential(providerIds, dependencies);
  switch (resolution.status) {
    case "available":
      return { status: "available", providerId: resolution.providerId };
    case "missing":
      return { status: "missing", providerId: primary };
    case "invalid":
      return {
        status: "invalid",
        providerId: resolution.providerId,
        error: "invalid_credential",
      };
    case "unsupported":
      return {
        status: "unsupported",
        providerId: resolution.providerId,
        error: "unsupported_credential_type",
      };
    default:
      return {
        status: "error",
        providerId: primary,
        error: "credential_resolution_failed",
      };
  }
}

/**
 * Returns the parsed auth object, or the failure status string shared by
 * every Pi credential reader: `missing` (ENOENT), `invalid` (oversized file
 * or non-object root), or `error` (unreadable file or unparseable JSON).
 */
async function readPiAuth(
  dependencies: BrokerDependencies,
): Promise<Record<string, unknown> | "missing" | "invalid" | "error"> {
  const path = authFilePath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "error";
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) return "invalid";

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return "error";
  }
  const root = objectValue(parsed);
  return root ?? "invalid";
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
