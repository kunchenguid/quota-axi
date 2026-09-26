import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import {
  ensurePrivateParent,
  museKeychainAccessMarkerPath,
} from "../lib/fs.js";
import { traceInput } from "../lib/input-trace.js";
import { execFileText } from "../lib/process.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type { ProviderOptions } from "../types.js";

/**
 * The Muse CLI's macOS credential store. On macOS the CLI's
 * `${XDG_CONFIG_HOME:-~/.config}/muse/auth.json` records
 * `providers.meta.storage: "keychain"` and the OAuth credential lives in the
 * login Keychain instead of the file: a generic-password item with service
 * `ai.meta.dev.credentials` and account `meta`, whose value is a JSON bundle
 * (`secret_schema_version`, the OAuth `access_token`, and the Model API key
 * the CLI last minted at startup).
 *
 * quota-axi reads only `access_token` out of that bundle: a JSON reviver
 * drops every other key while the value is parsed, so the minted API key
 * never reaches an object, an error, or any output. A sibling `refresh_token`
 * is checked for presence only. The value read follows the same
 * `--allow-keychain-prompt` gate as the Claude and Cursor CLI Keychain
 * sources: a plain quota call checks item presence only (no `-w`, never
 * prompts), and a successful value read records a non-secret marker so later
 * plain quota calls may reuse the existing grant. `auth` passes
 * `presenceOnly` when the flag is off so that leftover marker never triggers
 * a value read: the report only emits status, and the bundle carries the
 * minted API key.
 */
export const MUSE_KEYCHAIN_SOURCE = "cli-keychain";
export const MUSE_KEYCHAIN_SERVICE = "ai.meta.dev.credentials";
export const MUSE_KEYCHAIN_ACCOUNT = "meta";

const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;

/**
 * The only bundle keys that survive parsing. The minted Model API key the
 * bundle also carries is dropped while the JSON is parsed, so it is never
 * held, returned, or logged; `refresh_token` survives as `true` because its
 * presence alone decides soft expiry versus sign-out.
 */
const KEYCHAIN_BUNDLE_KEYS = new Set([
  "secret_schema_version",
  "access_token",
  "refresh_token",
]);

export type MuseKeychainResolution =
  | { status: "resolved"; credential: string; refreshable: boolean }
  | { status: "absent" }
  | { status: "structurally_invalid"; error: string }
  | { status: "skipped"; error: string };

type KeychainItemPresence = "present" | "missing" | "unknown";

export function isMuseKeychainSourceSupported(): boolean {
  return process.platform === "darwin";
}

/** Presence only for `auth`: never prompts and never reads the value. */
export async function museKeychainItemPresence(): Promise<KeychainItemPresence> {
  if (!isMuseKeychainSourceSupported()) return "missing";
  try {
    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        MUSE_KEYCHAIN_ACCOUNT,
        "-s",
        MUSE_KEYCHAIN_SERVICE,
      ],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return "present";
  } catch (error) {
    return isKeychainItemNotFound(error) ? "missing" : "unknown";
  }
}

export async function readMuseKeychainCredential(
  options: Pick<ProviderOptions, "allowKeychainPrompt">,
  presenceOnly = false,
): Promise<MuseKeychainResolution> {
  if (!isMuseKeychainSourceSupported()) return { status: "absent" };
  const presence = await museKeychainItemPresence();
  if (presence === "missing") return { status: "absent" };
  if (presenceOnly || !(options.allowKeychainPrompt || hasAccessMarker())) {
    return {
      status: "skipped",
      error:
        presence === "present"
          ? "keychain_prompt_required"
          : "keychain_presence_check_failed",
    };
  }

  let secret: string;
  try {
    secret = await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        MUSE_KEYCHAIN_ACCOUNT,
        "-w",
        "-s",
        MUSE_KEYCHAIN_SERVICE,
      ],
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    if (isKeychainItemNotFound(error)) return { status: "absent" };
    const failure = error as { killed?: boolean; signal?: string | null };
    return {
      status: "skipped",
      error:
        failure.killed || failure.signal
          ? "keychain_prompt_timeout"
          : "keychain_access_denied",
    };
  }
  writeAccessMarkerBestEffort();

  let bundle: unknown;
  try {
    bundle = JSON.parse(secret.trim(), (key, value: unknown) => {
      if (key === "" || KEYCHAIN_BUNDLE_KEYS.has(key))
        return key === "refresh_token" ? true : value;
      return undefined;
    });
  } catch {
    return { status: "structurally_invalid", error: "muse_keychain_invalid" };
  }
  const record =
    bundle !== null && typeof bundle === "object" && !Array.isArray(bundle)
      ? (bundle as Record<string, unknown>)
      : undefined;
  const credential = usableLiteralSecret(record?.access_token);
  if (credential === undefined)
    return { status: "structurally_invalid", error: "muse_keychain_invalid" };
  return {
    status: "resolved",
    credential,
    refreshable: record !== undefined && Object.hasOwn(record, "refresh_token"),
  };
}

function hasAccessMarker(): boolean {
  const marker = museKeychainAccessMarkerPath(
    MUSE_KEYCHAIN_SERVICE,
    MUSE_KEYCHAIN_ACCOUNT,
  );
  traceInput(marker);
  return existsSync(marker);
}

function writeAccessMarkerBestEffort(): void {
  try {
    const file = museKeychainAccessMarkerPath(
      MUSE_KEYCHAIN_SERVICE,
      MUSE_KEYCHAIN_ACCOUNT,
    );
    if (existsSync(file)) return;
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

function isKeychainItemNotFound(error: unknown): boolean {
  return (
    (error as { code?: number | string | null }).code ===
    KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE
  );
}
