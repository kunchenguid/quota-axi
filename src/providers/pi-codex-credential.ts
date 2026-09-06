import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";

const PI_PROVIDER_ID = "openai-codex";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;
const MINIMUM_MILLISECOND_EPOCH = 1_000_000_000_000;

export type PiCodexCredentials = {
  /** Present only for an in-memory quota probe; never log, render, or cache. */
  accessToken: string;
  accountId: string;
  expiresAtMs: number;
};

export type PiCodexCredentialResolution =
  | { status: "available"; credentials: PiCodexCredentials }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "unsupported" }
  | { status: "expired"; refreshable: boolean }
  | { status: "error" };

export type PiCodexCredentialInspection = {
  path: string;
  status: PiCodexCredentialResolution["status"];
  refreshable?: boolean;
  error?: string;
};

export type PiCodexCredentialBroker = {
  resolve(): Promise<PiCodexCredentialResolution>;
  inspect(): Promise<PiCodexCredentialInspection>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

export function createPiCodexCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): PiCodexCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: Date.now,
    ...overrides,
  };

  return {
    resolve: () => resolveCredential(dependencies),
    inspect: async () => {
      const resolution = await resolveCredential(dependencies);
      const path = authFilePath(dependencies);
      if (resolution.status === "expired") {
        return {
          path,
          status: "expired",
          refreshable: resolution.refreshable,
          error: resolution.refreshable
            ? "credentials_expired_refreshable"
            : "credentials_expired",
        };
      }
      if (resolution.status === "unsupported") {
        return {
          path,
          status: "unsupported",
          error: "unsupported_credential_type",
        };
      }
      if (resolution.status === "invalid") {
        return { path, status: "invalid", error: "invalid_credential" };
      }
      if (resolution.status === "error") {
        return {
          path,
          status: "error",
          error: "credential_resolution_failed",
        };
      }
      return { path, status: resolution.status };
    },
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<PiCodexCredentialResolution> {
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
  // Match the Pi xai broker's invalid status for over-cap files
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

  const type = stringValue(entry.type)?.toLowerCase();
  if (type === "api_key") return { status: "unsupported" };
  if (type !== "oauth") {
    return type === undefined
      ? { status: "invalid" }
      : { status: "unsupported" };
  }

  const accessToken = usableLiteral(entry.access);
  const accountId = usableLiteral(entry.accountId);
  const expiresAtMs = millisecondTimestamp(entry.expires);
  if (
    accessToken === undefined ||
    accountId === undefined ||
    expiresAtMs === undefined
  ) {
    return { status: "invalid" };
  }
  if (expiresAtMs <= dependencies.now()) {
    return {
      status: "expired",
      refreshable: usableLiteral(entry.refresh) !== undefined,
    };
  }

  return {
    status: "available",
    credentials: { accessToken, accountId, expiresAtMs },
  };
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

function usableLiteral(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  // Reject environment, template, and command references without resolving them.
  if (value.startsWith("!") || value.includes("$")) return undefined;
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

function millisecondTimestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MINIMUM_MILLISECOND_EPOCH
    ? value
    : undefined;
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
