import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { traceInput } from "../lib/input-trace.js";
import type { ProviderSource } from "../types.js";

export const PI_ANTHROPIC_PROVIDER_ID = "anthropic";
export const PI_ANTHROPIC_SOURCE =
  "pi:anthropic" as const satisfies ProviderSource;
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

export type PiAnthropicCredentials = {
  /** Present only for an in-memory quota probe; never log, render, or cache. */
  accessToken: string;
  expiresAtMs?: number;
};

export type PiAnthropicCredentialResolution =
  | { status: "available"; credentials: PiAnthropicCredentials }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "unsupported" }
  | {
      status: "expired";
      refreshable: boolean;
      /** Probe use only; never log or render. */
      credentials?: PiAnthropicCredentials;
    }
  | { status: "error" };

export type PiAnthropicCredentialBroker = {
  resolve(): Promise<PiAnthropicCredentialResolution>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

export function createPiAnthropicCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): PiAnthropicCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: Date.now,
    ...overrides,
  };

  return {
    resolve: () => resolveCredential(dependencies),
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<PiAnthropicCredentialResolution> {
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
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) return { status: "invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    return { status: "invalid" };
  }

  const classified = classifyPiAuthEntry(parsed, PI_ANTHROPIC_PROVIDER_ID);
  if (classified.status !== "present") return classified;
  const { entry } = classified;
  const type = stringValue(entry.type)?.toLowerCase();
  if (type !== "oauth") {
    return type === undefined
      ? { status: "invalid" }
      : { status: "unsupported" };
  }

  const accessToken = usableLiteral(entry.access);
  if (accessToken === undefined) return { status: "invalid" };
  const hasExpiry = Object.hasOwn(entry, "expires");
  const expiresAtMs = timestampMs(entry.expires);
  if (hasExpiry && expiresAtMs === undefined) return { status: "invalid" };
  const credentials = { accessToken, expiresAtMs };
  if (expiresAtMs !== undefined && expiresAtMs <= dependencies.now()) {
    return {
      status: "expired",
      refreshable: Object.hasOwn(entry, "refresh"),
      credentials,
    };
  }
  return { status: "available", credentials };
}

function authFilePath(dependencies: BrokerDependencies): string {
  return resolvePiAuthFilePath(
    dependencies.environment,
    dependencies.homeDirectory,
  );
}

function usableLiteral(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  if (value.startsWith("!") || value.includes("$")) return undefined;
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    return undefined;
  return value;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
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
  traceInput(path);
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
