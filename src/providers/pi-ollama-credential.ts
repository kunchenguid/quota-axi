import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";

const PI_PROVIDER_ID = "ollama-cloud";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

export type PiOllamaCredentialResolution =
  | { status: "available"; credential: string; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string }
  | { status: "unsupported"; path: string }
  | { status: "error"; path: string };

export type PiOllamaCredentialInspection =
  | {
      status: Exclude<PiOllamaCredentialResolution["status"], "available">;
      path: string;
      error?: string;
    }
  | { status: "available"; path: string };

export type PiOllamaCredentialBroker = {
  resolve(): Promise<PiOllamaCredentialResolution>;
  inspect(): Promise<PiOllamaCredentialInspection>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export function createPiOllamaCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): PiOllamaCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    ...overrides,
  };

  return {
    resolve: () => resolveCredential(dependencies),
    inspect: async () => {
      const resolution = await resolveCredential(dependencies);
      if (resolution.status === "available") {
        return { status: "available", path: resolution.path };
      }
      return {
        status: resolution.status,
        path: resolution.path,
        ...(resolution.status === "invalid"
          ? { error: "invalid_credential" }
          : resolution.status === "unsupported"
            ? { error: "unsupported_credential_type" }
            : resolution.status === "error"
              ? { error: "credential_resolution_failed" }
              : {}),
      };
    },
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<PiOllamaCredentialResolution> {
  const path = authFilePath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing", path }
      : { status: "error", path };
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) {
    return { status: "invalid", path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "invalid", path };
  }

  const classified = classifyPiAuthEntry(parsed, PI_PROVIDER_ID);
  if (classified.status !== "present") {
    return { status: classified.status, path };
  }

  const type = stringValue(classified.entry.type)?.toLowerCase();
  if (type === "api_key") {
    const credential = usableLiteralSecret(classified.entry.key);
    return credential === undefined
      ? { status: "invalid", path }
      : { status: "available", credential, path };
  }
  if (type === undefined) return { status: "invalid", path };
  return { status: "unsupported", path };
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
