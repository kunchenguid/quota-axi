import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const KIMI_CODE_CLI_CREDENTIAL_SOURCE = "kimi-code-cli";

const CREDENTIAL_FILE_LIMIT_BYTES = 64 * 1024;
const MINIMUM_FRESHNESS_SECONDS = 60;

export type KimiCodeCliCredentialResolution =
  | { status: "available"; accessToken: string }
  | { status: "missing" | "invalid" | "expired" };

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
  readTextFile: (path: string) => Promise<string>;
};

export function createKimiCodeCliCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): KimiCodeCliCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    now: Date.now,
    readTextFile: (path) => readFile(path, "utf8"),
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
  const path = credentialPath(dependencies);
  let raw: string;
  try {
    raw = await dependencies.readTextFile(path);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  }
  if (Buffer.byteLength(raw, "utf8") > CREDENTIAL_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
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
    return { status: "expired" };
  }
  return { status: "available", accessToken };
}

function credentialPath(dependencies: CredentialSourceDependencies): string {
  const codeHome =
    nonempty(dependencies.environment.KIMI_CODE_HOME) ??
    nonempty(dependencies.environment.HOME) ??
    dependencies.homeDirectory();
  return join(codeHome, "credentials", "kimi-code.json");
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
