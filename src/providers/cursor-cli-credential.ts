import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cursorCliKeychainAccessMarkerPath,
  ensurePrivateParent,
  readJsonFileResult,
} from "../lib/fs.js";
import { execFileText } from "../lib/process.js";
import type { AuthSourceReport, ProviderOptions } from "../types.js";

/**
 * The Cursor CLI (`cursor-agent`) keeps sign-in identity in a plain
 * `cli-config.json` and the tokens themselves in the macOS login Keychain,
 * unlike the Cursor editor which keeps both in its `state.vscdb`. This module
 * reads only the access token, only on macOS, and only through the same
 * `--allow-keychain-prompt` gate the Claude keychain source uses.
 *
 * Access-token refresh is intentionally not implemented: the sibling
 * `cursor-refresh-token` item is never read, because quota-axi does not mutate
 * provider state and has no first-party refresh contract to rely on. An expired
 * access token therefore surfaces as `Cursor sign-in required`, whose remedy is
 * running `cursor-agent login` again.
 */
export const CURSOR_CLI_SOURCE = "cli-keychain";
export const CURSOR_CLI_KEYCHAIN_SERVICE = "cursor-access-token";
export const CURSOR_CLI_KEYCHAIN_ACCOUNT = "cursor-user";

const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;

export type CursorCliIdentity = { email?: string; userId?: string };

export type CursorCliCredentialState =
  | {
      status: "available";
      accessToken: string;
      identity: CursorCliIdentity;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid" | "skipped"; source: AuthSourceReport };

type IdentityResult =
  | { status: "present"; identity: CursorCliIdentity }
  | { status: "missing" }
  | { status: "invalid"; error: string };

type KeychainItemPresence = "present" | "missing" | "unknown";

/** The Cursor CLI token store is the macOS login Keychain only. */
export function isCursorCliSourceSupported(): boolean {
  return process.platform === "darwin";
}

export function cursorCliConfigPath(): string {
  if (process.env.CURSOR_CLI_CONFIG) return process.env.CURSOR_CLI_CONFIG;
  return join(homedir(), ".cursor", "cli-config.json");
}

export async function readCursorCliCredentialState(
  options: ProviderOptions,
  presenceOnly = false,
): Promise<CursorCliCredentialState> {
  const path = cursorCliConfigPath();
  if (!isCursorCliSourceSupported()) return missingState(path);

  const identityResult = readCursorCliIdentity(path);
  if (identityResult.status === "missing") return missingState(path);
  if (identityResult.status === "invalid") {
    return {
      status: "invalid",
      source: {
        source: CURSOR_CLI_SOURCE,
        path,
        status: "invalid",
        error: identityResult.error,
      },
    };
  }

  const { identity } = identityResult;
  if (
    presenceOnly ||
    !(options.allowKeychainPrompt || hasKeychainAccessMarker(identity))
  ) {
    return skippedKeychainState(path, await readKeychainItemPresence());
  }
  return readKeychainAccessToken(path, identity);
}

/** Identity only: `cli-config.json` never holds a token. */
export function readCursorCliIdentity(path: string): IdentityResult {
  const raw = readJsonFileResult(path);
  if (raw.status === "missing") return { status: "missing" };
  if (raw.status === "invalid") return { status: "invalid", error: raw.error };
  const authInfo = objectValue(objectValue(raw.value)?.authInfo);
  if (!authInfo) return { status: "missing" };
  const identity: CursorCliIdentity = {
    email: stringValue(authInfo.email),
    userId: stringValue(authInfo.userId) ?? stringValue(authInfo.authId),
  };
  if (!identity.email && !identity.userId) return { status: "missing" };
  return { status: "present", identity };
}

async function readKeychainAccessToken(
  path: string,
  identity: CursorCliIdentity,
): Promise<CursorCliCredentialState> {
  let secret: string;
  try {
    secret = await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        CURSOR_CLI_KEYCHAIN_ACCOUNT,
        "-w",
        "-s",
        CURSOR_CLI_KEYCHAIN_SERVICE,
      ],
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    return keychainFailureState(path, error);
  }
  writeKeychainAccessMarkerBestEffort(identity);
  const accessToken = secret.trim();
  if (accessToken.length === 0) {
    return {
      status: "invalid",
      source: {
        source: CURSOR_CLI_SOURCE,
        path,
        status: "invalid",
        error: "empty_credential",
      },
    };
  }
  return {
    status: "available",
    accessToken,
    identity,
    source: {
      source: CURSOR_CLI_SOURCE,
      path,
      status: "available",
      credentialPresent: true,
    },
  };
}

/** Presence check only: no `-w`, so it never prompts and never reads a value. */
async function readKeychainItemPresence(): Promise<KeychainItemPresence> {
  try {
    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        CURSOR_CLI_KEYCHAIN_ACCOUNT,
        "-s",
        CURSOR_CLI_KEYCHAIN_SERVICE,
      ],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return "present";
  } catch (error) {
    return isKeychainItemNotFound(error) ? "missing" : "unknown";
  }
}

function skippedKeychainState(
  path: string,
  presence: KeychainItemPresence,
): CursorCliCredentialState {
  if (presence === "missing") return missingState(path);
  return {
    status: "skipped",
    source: {
      source: CURSOR_CLI_SOURCE,
      path,
      status: "skipped",
      error:
        presence === "present"
          ? "keychain_prompt_required"
          : "keychain_presence_check_failed",
      ...(presence === "present" ? { credentialPresent: true } : {}),
    },
  };
}

function keychainFailureState(
  path: string,
  error: unknown,
): CursorCliCredentialState {
  const failure = error as {
    killed?: boolean;
    signal?: string | null;
    code?: number | string | null;
  };
  if (failure.killed || failure.signal) {
    return {
      status: "skipped",
      source: {
        source: CURSOR_CLI_SOURCE,
        path,
        status: "skipped",
        error: "keychain_prompt_timeout",
      },
    };
  }
  if (isKeychainItemNotFound(error)) return missingState(path);
  return {
    status: "skipped",
    source: {
      source: CURSOR_CLI_SOURCE,
      path,
      status: "skipped",
      error: "keychain_access_denied",
    },
  };
}

function missingState(path: string): CursorCliCredentialState {
  return {
    status: "missing",
    source: { source: CURSOR_CLI_SOURCE, path, status: "missing" },
  };
}

function hasKeychainAccessMarker(identity: CursorCliIdentity): boolean {
  return existsSync(cursorCliKeychainAccessMarkerPath(markerKey(identity)));
}

function writeKeychainAccessMarkerBestEffort(
  identity: CursorCliIdentity,
): void {
  try {
    const file = cursorCliKeychainAccessMarkerPath(markerKey(identity));
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "granted\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

/** Scopes the grant to the signed-in CLI account, never storing its raw value. */
function markerKey(identity: CursorCliIdentity): string {
  return identity.userId ?? identity.email ?? CURSOR_CLI_KEYCHAIN_ACCOUNT;
}

function isKeychainItemNotFound(error: unknown): boolean {
  return (
    (error as { code?: number | string | null }).code ===
    KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
