import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import type { ProviderSource } from "../types.js";

export const PI_CODEX_BUILTIN_ID = "openai-codex";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;
const PI_CODEX_PROVIDER_ID = /^openai-codex(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const PI_CODEX_SOURCE = /^pi:openai-codex(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
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
  | {
      status: "expired";
      refreshable: boolean;
      /**
       * The stored credentials, present so a bounded read-only liveness
       * probe can test them despite the stored expiry field. Probe use only;
       * never log or render.
       */
      credentials?: PiCodexCredentials;
    }
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
  resolveEntry(providerId: string): Promise<PiCodexCredentialResolution>;
  inspectEntry(providerId: string): Promise<PiCodexCredentialInspection>;
  listProviderIds(): Promise<string[]>;
};

export function isPiCodexProviderId(value: string): boolean {
  return PI_CODEX_PROVIDER_ID.test(value);
}

export function isPiCodexSource(value: string): boolean {
  return PI_CODEX_SOURCE.test(value);
}

export function piCodexSource(providerId: string): ProviderSource {
  return `pi:${providerId}` as ProviderSource;
}

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
    resolve: () => resolveCredential(dependencies, PI_CODEX_BUILTIN_ID),
    inspect: () => inspectCredential(dependencies, PI_CODEX_BUILTIN_ID),
    resolveEntry: (providerId) => resolveCredential(dependencies, providerId),
    inspectEntry: (providerId) => inspectCredential(dependencies, providerId),
    listProviderIds: () => listProviderIds(dependencies),
  };
}

async function inspectCredential(
  dependencies: BrokerDependencies,
  providerId: string,
): Promise<PiCodexCredentialInspection> {
  const resolution = await resolveCredential(dependencies, providerId);
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
}

type AuthObjectRead =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "error" };

async function readAuthObject(
  dependencies: BrokerDependencies,
): Promise<AuthObjectRead> {
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

  try {
    const parsed: unknown = JSON.parse(contents.toString("utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? { status: "ok", value: parsed as Record<string, unknown> }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

async function listProviderIds(
  dependencies: BrokerDependencies,
): Promise<string[]> {
  const parsed = await readAuthObject(dependencies);
  if (parsed.status !== "ok") return [];
  return piCodexProviderIds(parsed.value);
}

function piCodexProviderIds(parsed: Record<string, unknown>): string[] {
  const ids = Object.keys(parsed).filter(isPiCodexProviderId);
  ids.sort((left, right) => {
    if (left === PI_CODEX_BUILTIN_ID) return -1;
    if (right === PI_CODEX_BUILTIN_ID) return 1;
    return left.localeCompare(right);
  });
  return ids;
}

async function resolveCredential(
  dependencies: BrokerDependencies,
  providerId: string,
): Promise<PiCodexCredentialResolution> {
  if (!isPiCodexProviderId(providerId)) return { status: "missing" };
  const parsed = await readAuthObject(dependencies);
  if (parsed.status === "missing") return { status: "missing" };
  if (parsed.status === "error") return { status: "error" };
  if (parsed.status === "invalid") return { status: "invalid" };

  const classified = classifyPiAuthEntry(parsed.value, providerId);
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
      refreshable: Object.hasOwn(entry, "refresh"),
      credentials: { accessToken, accountId, expiresAtMs },
    };
  }

  return {
    status: "available",
    credentials: { accessToken, accountId, expiresAtMs },
  };
}

function authFilePath(dependencies: BrokerDependencies): string {
  return resolvePiAuthFilePath(
    dependencies.environment,
    dependencies.homeDirectory,
  );
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
