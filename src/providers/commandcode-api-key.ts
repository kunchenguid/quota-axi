import { homedir } from "node:os";
import { join } from "node:path";
import { readBoundedFile } from "../lib/fs.js";
import { usableLiteralSecret } from "../lib/secret.js";
import {
  credentialFromPiEntry,
  type CommandCodeLocalResolution,
} from "./pi-commandcode-credential.js";

const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

export const COMMAND_CODE_API_KEY_SOURCE = "env:COMMAND_CODE_API_KEY";
export const COMMANDCODE_API_KEY_SOURCE = "env:COMMANDCODE_API_KEY";
export const COMMANDCODE_CLI_CREDENTIAL_SOURCE = "commandcode-cli";
export const OMP_COMMANDCODE_CREDENTIAL_SOURCE = "omp:commandcode";

export type CommandCodeFileSource = {
  resolve(): Promise<CommandCodeLocalResolution>;
  inspect(): Promise<{
    status: "available" | "missing" | "invalid" | "error";
    path: string;
    error?: string;
  }>;
};

export type CommandCodeEnvSource = {
  resolve(): Promise<CommandCodeLocalResolution>;
  inspect(): Promise<{
    status: "available" | "missing" | "invalid";
    error?: string;
  }>;
};

type FileSourceDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

const defaultFileDependencies = (): FileSourceDependencies => ({
  environment: process.env,
  homeDirectory: homedir,
  readFile: readBoundedFile,
});

export function createCommandCodeEnvSource(
  name: "COMMAND_CODE_API_KEY" | "COMMANDCODE_API_KEY",
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CommandCodeEnvSource {
  const resolve = (): Promise<CommandCodeLocalResolution> =>
    Promise.resolve(envResolution(environment[name]));
  return {
    resolve,
    inspect: async () => inspectFromResolution(await resolve()),
  };
}

export function createCommandCodeCliCredentialSource(
  overrides: Partial<FileSourceDependencies> = {},
): CommandCodeFileSource {
  const dependencies = { ...defaultFileDependencies(), ...overrides };
  return createFileSource(dependencies, (home) =>
    join(home, ".commandcode", "auth.json"),
  );
}

export function createOmpCommandCodeCredentialSource(
  overrides: Partial<FileSourceDependencies> = {},
): CommandCodeFileSource {
  const dependencies = { ...defaultFileDependencies(), ...overrides };
  return createFileSource(
    dependencies,
    (home) => join(home, ".omp", "agent", "auth.json"),
    extractOmpCommandCodeCredential,
  );
}

function createFileSource(
  dependencies: FileSourceDependencies,
  filePath: (home: string) => string,
  extract: (value: unknown) => CommandCodeLocalResolution = extractCliApiKey,
): CommandCodeFileSource {
  const pathFor = () => filePath(homeDirectory(dependencies));
  const resolve = () => resolveFile(dependencies, pathFor(), extract);
  return {
    resolve,
    inspect: async () => {
      const path = pathFor();
      const resolution = await resolve();
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

async function resolveFile(
  dependencies: FileSourceDependencies,
  path: string,
  extract: (value: unknown) => CommandCodeLocalResolution,
): Promise<CommandCodeLocalResolution> {
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
  return extract(parsed);
}

function extractCliApiKey(value: unknown): CommandCodeLocalResolution {
  const root = objectValue(value);
  if (!root) {
    return {
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    };
  }
  if (!Object.hasOwn(root, "apiKey")) return { status: "absent" };
  const apiKey = usableLiteralSecret(root.apiKey);
  return apiKey !== undefined
    ? { status: "resolved", credential: apiKey }
    : {
        status: "structurally_invalid",
        error: "commandcode_credential_invalid",
      };
}

function extractOmpCommandCodeCredential(
  value: unknown,
): CommandCodeLocalResolution {
  const root = objectValue(value);
  if (!root) {
    return {
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    };
  }
  let seen = false;
  for (const name of ["commandcode", "command-code"]) {
    if (!Object.hasOwn(root, name)) continue;
    seen = true;
    const entry = root[name];
    if (!isObject(entry)) {
      return {
        status: "structurally_invalid",
        error: "commandcode_credential_invalid",
      };
    }
    const fromPiShape = credentialFromPiEntry(entry);
    if (fromPiShape.status === "resolved") return fromPiShape;
    const apiKey = usableLiteralSecret(entry.apiKey);
    if (apiKey !== undefined) return { status: "resolved", credential: apiKey };
    if (fromPiShape.status !== "structurally_invalid") return fromPiShape;
  }
  return seen
    ? {
        status: "structurally_invalid",
        error: "commandcode_credential_invalid",
      }
    : { status: "absent" };
}

function envResolution(value: string | undefined): CommandCodeLocalResolution {
  if (value === undefined) return { status: "absent" };
  const credential = usableLiteralSecret(value);
  return credential !== undefined
    ? { status: "resolved", credential }
    : {
        status: "structurally_invalid",
        error: "commandcode_credential_invalid",
      };
}

function inspectFromResolution(resolution: CommandCodeLocalResolution): {
  status: "available" | "missing" | "invalid";
  error?: string;
} {
  if (resolution.status === "resolved") return { status: "available" };
  if (resolution.status === "absent") return { status: "missing" };
  if (resolution.status === "unsupported") {
    return { status: "invalid", error: "unsupported_credential_type" };
  }
  return { status: "invalid", error: resolution.error };
}

function homeDirectory(dependencies: FileSourceDependencies): string {
  const home = nonempty(dependencies.environment.HOME);
  return home ?? dependencies.homeDirectory();
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
