import { homedir } from "node:os";
import { join } from "node:path";
import { readBoundedFile } from "../lib/fs.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";

const PI_PROVIDER_ID = "commandcode";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

export const PI_COMMANDCODE_CREDENTIAL_SOURCE = "pi:commandcode";

export type CommandCodeLocalResolution =
  | { status: "absent" }
  | { status: "structurally_invalid"; error: string }
  | { status: "unsupported" }
  | { status: "read_error"; error: string }
  | {
      status: "resolved";
      /** Present only for in-memory probe use; never log or render. */
      credential: string;
    };

export type PiCommandCodeCredentialBroker = {
  resolve(): Promise<CommandCodeLocalResolution>;
  inspect(): Promise<{
    status: "available" | "missing" | "invalid" | "error";
    path: string;
    error?: string;
  }>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export function createPiCommandCodeCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): PiCommandCodeCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    ...overrides,
  };

  return {
    resolve: () => resolveCredential(dependencies),
    inspect: async () => {
      const path = authFilePath(dependencies);
      const resolution = await resolveCredential(dependencies);
      if (resolution.status === "resolved") {
        return { status: "available", path };
      }
      if (resolution.status === "absent") {
        return { status: "missing", path };
      }
      if (resolution.status === "read_error") {
        return { status: "error", path, error: resolution.error };
      }
      if (resolution.status === "unsupported") {
        return {
          status: "invalid",
          path,
          error: "unsupported_credential_type",
        };
      }
      return { status: "invalid", path, error: resolution.error };
    },
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<CommandCodeLocalResolution> {
  const path = authFilePath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "absent" }
      : { status: "read_error", error: "credential_resolution_failed" };
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) {
    return {
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return {
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    };
  }

  const classified = classifyPiAuthEntry(parsed, PI_PROVIDER_ID);
  if (classified.status === "missing") return { status: "absent" };
  if (classified.status === "invalid") {
    return {
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    };
  }

  return credentialFromPiEntry(classified.entry);
}

/**
 * Command Code's Pi OAuth wrapper stores a non-expiring API key. Expiry
 * metadata is ignored and the duplicate refresh field is never read.
 */
export function credentialFromPiEntry(
  entry: Record<string, unknown>,
): CommandCodeLocalResolution {
  const type = stringValue(entry.type)?.toLowerCase();
  if (type === "api_key") {
    const apiKey = usableLiteralSecret(entry.key);
    return apiKey !== undefined
      ? { status: "resolved", credential: apiKey }
      : {
          status: "structurally_invalid",
          error: "commandcode_credential_invalid",
        };
  }
  if (type === "oauth") {
    const access = usableLiteralSecret(entry.access);
    return access !== undefined
      ? { status: "resolved", credential: access }
      : {
          status: "structurally_invalid",
          error: "commandcode_credential_invalid",
        };
  }
  if (type === undefined) {
    return {
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    };
  }
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
