import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_PROVIDER_ID = "xai";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

export type PiXaiCredentialResolution =
  | {
      status: "available";
      kind: "oauth" | "api_key";
      /** Present only for in-memory probe use; never log or render. */
      credential: string;
    }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "unsupported" }
  | {
      status: "expired";
      refreshable: boolean;
      /**
       * The stored access token, present so a bounded read-only liveness
       * probe can test it despite the stored expiry field. Probe use only;
       * never log or render.
       */
      credential?: string;
    }
  | { status: "error" };

export type PiXaiCredentialInspection =
  | Exclude<PiXaiCredentialResolution["status"], "available" | "expired">
  | "available"
  | "expired";

export type PiXaiCredentialBroker = {
  resolve(): Promise<PiXaiCredentialResolution>;
  inspect(): Promise<{
    status: PiXaiCredentialInspection;
    refreshable?: boolean;
    error?: string;
  }>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

export function createPiXaiCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): PiXaiCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: () => Date.now(),
    ...overrides,
  };

  return {
    resolve: () => resolveCredential(dependencies),
    inspect: async () => {
      const resolution = await resolveCredential(dependencies);
      if (resolution.status === "available") {
        return { status: "available" };
      }
      if (resolution.status === "expired") {
        return {
          status: "expired",
          refreshable: resolution.refreshable,
        };
      }
      if (resolution.status === "unsupported") {
        return {
          status: "unsupported",
          error: "unsupported_credential_type",
        };
      }
      if (resolution.status === "error") {
        return { status: "error", error: "credential_resolution_failed" };
      }
      if (resolution.status === "invalid") {
        return { status: "invalid", error: "invalid_credential" };
      }
      return { status: "missing" };
    },
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<PiXaiCredentialResolution> {
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
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "error" };
  }

  const root = objectValue(parsed);
  if (!root) return { status: "invalid" };

  const entry = objectValue(root[PI_PROVIDER_ID]);
  if (!entry) return { status: "missing" };

  const type = stringValue(entry.type)?.toLowerCase();
  if (type === "api_key") {
    const apiKey = usableLiteralSecret(entry.key);
    return apiKey !== undefined
      ? { status: "available", kind: "api_key", credential: apiKey }
      : { status: "invalid" };
  }

  if (type === "oauth") {
    const access = usableLiteralSecret(entry.access);
    if (access === undefined) return { status: "invalid" };
    const hasExpiry = Object.hasOwn(entry, "expires");
    const expiresMs = timestampMs(entry.expires);
    if (hasExpiry && expiresMs === undefined) return { status: "invalid" };
    if (expiresMs !== undefined && expiresMs <= dependencies.now()) {
      return {
        status: "expired",
        refreshable: usableLiteralSecret(entry.refresh) !== undefined,
        credential: access,
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
