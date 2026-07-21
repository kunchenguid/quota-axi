import type { Credential } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_PROVIDER_ID = "kimi-coding";
const PI_AUTH_READ_LIMIT_BYTES = 1_048_576;
const COMMAND_OUTPUT_LIMIT_BYTES = 16_384;
const UNRESOLVED_CREDENTIAL = "\0";
const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const BRACED_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export type KimiCredentialResolution =
  | { status: "available"; apiKey: string }
  | { status: "missing" }
  | { status: "unsupported" }
  | { status: "error" };

export type KimiCredentialInspection =
  | Exclude<KimiCredentialResolution["status"], "available">
  | "available";

export type KimiCredentialBroker = {
  resolve(): Promise<KimiCredentialResolution>;
  inspect(): Promise<KimiCredentialInspection>;
};

type PiModelRuntime = {
  listCredentials(): Promise<readonly { providerId: string; type: string }[]>;
  getAuth(providerId: string): Promise<
    | {
        auth: { apiKey?: string; headers?: unknown; baseUrl?: unknown };
        source?: unknown;
      }
    | undefined
  >;
};

type BrokerDependencies = {
  loadRuntime: () => Promise<PiModelRuntime>;
};

export function createPiKimiCredentialBroker(
  dependencies: BrokerDependencies = { loadRuntime: loadPiRuntime },
): KimiCredentialBroker {
  return {
    async resolve(): Promise<KimiCredentialResolution> {
      try {
        const runtime = await dependencies.loadRuntime();
        const storedType = await storedCredentialType(runtime);
        if (storedType !== undefined && storedType !== "api_key") {
          return { status: "unsupported" };
        }
        const resolved = await runtime.getAuth(PI_PROVIDER_ID);
        const apiKey = usableApiKey(resolved?.auth.apiKey);
        return apiKey !== undefined
          ? { status: "available", apiKey }
          : { status: "missing" };
      } catch {
        return { status: "error" };
      }
    },

    async inspect(): Promise<KimiCredentialInspection> {
      try {
        const runtime = await dependencies.loadRuntime();
        const storedType = await storedCredentialType(runtime);
        if (storedType !== undefined && storedType !== "api_key") {
          return "unsupported";
        }
        const resolved = await runtime.getAuth(PI_PROVIDER_ID);
        return usableApiKey(resolved?.auth.apiKey) === undefined
          ? "missing"
          : "available";
      } catch {
        return "error";
      }
    },
  };
}

async function storedCredentialType(
  runtime: PiModelRuntime,
): Promise<string | undefined> {
  return (await runtime.listCredentials()).find(
    (credential) => credential.providerId === PI_PROVIDER_ID,
  )?.type;
}

async function loadPiRuntime(): Promise<PiModelRuntime> {
  const [{ ModelRuntime }, { InMemoryCredentialStore }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);
  const credentials = new InMemoryCredentialStore();
  const storedCredential = readKimiCredential();
  if (storedCredential !== undefined) {
    await credentials.modify(PI_PROVIDER_ID, async () => storedCredential);
  }
  return ModelRuntime.create({
    credentials,
    allowModelNetwork: false,
    modelsPath: null,
  });
}

function readKimiCredential(): Credential | undefined {
  const authPath = join(piAgentDirectory(), "auth.json");
  let content: string | undefined;
  try {
    content = readBoundedUtf8File(authPath);
  } catch {
    return blockedCredential();
  }
  if (content === undefined) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return blockedCredential();
  }
  if (!isRecord(data)) return blockedCredential();
  if (!Object.prototype.hasOwnProperty.call(data, PI_PROVIDER_ID)) {
    return undefined;
  }

  const credential = data[PI_PROVIDER_ID];
  if (!isRecord(credential) || typeof credential.type !== "string") {
    return blockedCredential();
  }
  if (credential.type !== "api_key") {
    return unsupportedCredential();
  }
  if (credential.key !== undefined && typeof credential.key !== "string") {
    return blockedCredential();
  }
  const environment = credentialEnvironment(credential.env);
  if (credential.env !== undefined && environment === undefined) {
    return blockedCredential();
  }
  if (credential.key === undefined) {
    return { type: "api_key", ...(environment ? { env: environment } : {}) };
  }

  const key = resolveCredentialValue(credential.key, environment);
  return key === undefined
    ? blockedCredential()
    : {
        type: "api_key",
        key,
        ...(environment ? { env: environment } : {}),
      };
}

function readBoundedUtf8File(path: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > PI_AUTH_READ_LIMIT_BYTES) {
      throw new Error("auth_invalid");
    }
    const buffer = Buffer.allocUnsafe(PI_AUTH_READ_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > PI_AUTH_READ_LIMIT_BYTES) throw new Error("auth_too_large");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, offset),
    );
  } finally {
    closeSync(descriptor);
  }
}

function resolveCredentialValue(
  value: string,
  environment: Record<string, string> | undefined,
): string | undefined {
  const envName =
    ENV_REFERENCE.exec(value)?.[1] ?? BRACED_ENV_REFERENCE.exec(value)?.[1];
  if (envName !== undefined) {
    return usableApiKey(environment?.[envName] || process.env[envName]);
  }
  if (value.startsWith("!")) {
    const command = value.slice(1).trim();
    if (command.length === 0) return undefined;
    try {
      return usableApiKey(
        execSync(command, {
          encoding: "utf8",
          maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        }).trim(),
      );
    } catch {
      return undefined;
    }
  }
  if (value.includes("$")) return undefined;
  return usableApiKey(value);
}

function usableApiKey(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value === UNRESOLVED_CREDENTIAL ||
    value.trim().length === 0 ||
    value.startsWith("!") ||
    value.includes("$") ||
    /[\0-\x1f\x7f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function credentialEnvironment(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string")) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function piAgentDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === undefined || configured.length === 0) {
    return join(homedir(), ".pi", "agent");
  }
  if (configured === "~") return homedir();
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
}

function blockedCredential(): Credential {
  return { type: "api_key", key: UNRESOLVED_CREDENTIAL };
}

function unsupportedCredential(): Credential {
  return { type: "oauth", access: "", refresh: "", expires: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
