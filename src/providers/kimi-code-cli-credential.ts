import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  kimiCredentialPath,
  resolveKimiCodeEnvironment,
} from "./kimi-code-config.js";

export const KIMI_CODE_CLI_CREDENTIAL_SOURCE = "kimi-code-cli";

const CREDENTIAL_FILE_LIMIT_BYTES = 64 * 1024;
const CONFIG_FILE_LIMIT_BYTES = 256 * 1024;
const MINIMUM_FRESHNESS_SECONDS = 60;

export type KimiCodeCliCredentialResolution =
  /** The base URL travels with the token: it is the one this slot logged in against. */
  | { status: "available"; accessToken: string; baseUrl: string }
  | {
      status: "expired";
      /**
       * The stored access token and the base URL it was issued for, present so
       * a bounded read-only liveness probe can test it despite the stored
       * expiry field. Probe use only; never log or render.
       */
      accessToken?: string;
      baseUrl?: string;
    }
  | {
      status:
        | "missing"
        | "invalid"
        | "error"
        | "unsupported_storage"
        | "unrecognized_region"
        | "invalid_config";
    };

export type KimiCodeCliCredentialInspection =
  KimiCodeCliCredentialResolution["status"];

export type KimiCodeCliCredentialSource = {
  resolve(): Promise<KimiCodeCliCredentialResolution>;
  inspect(): Promise<KimiCodeCliCredentialInspection>;
};

type CredentialSourceDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  now: () => number;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  /**
   * Separate from `readFile` because the two reads mean different things: this
   * one is non-secret configuration whose absence is normal, and a failure to
   * read it is a configuration problem rather than a credential I/O error.
   */
  readConfigFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export function createKimiCodeCliCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): KimiCodeCliCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    now: Date.now,
    readFile: readBoundedFile,
    readConfigFile: readBoundedFile,
    ...overrides,
  };

  const inspect = async (): Promise<KimiCodeCliCredentialInspection> =>
    (await resolveCredential(dependencies)).status;

  return {
    resolve: () => resolveCredential(dependencies),
    inspect,
  };
}

async function resolveCredential(
  dependencies: CredentialSourceDependencies,
): Promise<KimiCodeCliCredentialResolution> {
  const codeHome = kimiCodeHome(dependencies);
  const config = await readConfigText(codeHome, dependencies);
  if (config.status === "unreadable") return { status: "invalid_config" };
  const environment = resolveKimiCodeEnvironment(config.text);
  if (environment.status !== "resolved") return { status: environment.status };

  const path = kimiCredentialPath(codeHome, environment.credentialFileName);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, CREDENTIAL_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > CREDENTIAL_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const credential = objectValue(parsed);
  const accessToken =
    typeof credential?.access_token === "string"
      ? credential.access_token.trim()
      : "";
  const expiresAt = expirySeconds(credential?.expires_at);
  if (!accessToken || expiresAt === undefined) return { status: "invalid" };
  if (expiresAt <= dependencies.now() / 1_000 + MINIMUM_FRESHNESS_SECONDS) {
    return { status: "expired", accessToken, baseUrl: environment.baseUrl };
  }
  return { status: "available", accessToken, baseUrl: environment.baseUrl };
}

function kimiCodeHome(dependencies: CredentialSourceDependencies): string {
  const configuredHome = nonempty(dependencies.environment.KIMI_CODE_HOME);
  return (
    configuredHome ??
    join(
      nonempty(dependencies.environment.HOME) ?? dependencies.homeDirectory(),
      ".kimi-code",
    )
  );
}

/**
 * An absent `config.toml` is not an error: a mainland-China login persists the
 * default slot, so no file and the default reference describe one environment.
 * An unreadable file is reported as configuration quota-axi could not parse
 * rather than silently defaulting, because defaulting would name a slot the
 * file may well contradict.
 */
async function readConfigText(
  codeHome: string,
  dependencies: CredentialSourceDependencies,
): Promise<{ status: "read"; text?: string } | { status: "unreadable" }> {
  let contents: Buffer;
  try {
    contents = await dependencies.readConfigFile(
      join(codeHome, "config.toml"),
      CONFIG_FILE_LIMIT_BYTES,
    );
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "read" }
      : { status: "unreadable" };
  }
  return contents.byteLength > CONFIG_FILE_LIMIT_BYTES
    ? { status: "unreadable" }
    : { status: "read", text: contents.toString("utf8") };
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

function expirySeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
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
