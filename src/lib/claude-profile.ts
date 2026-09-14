import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Mirrors Claude Code's configuration and secure-storage selectors. */
export function claudeProfileLocations(): {
  configDir: string;
  credentialDir: string;
  keychainService: string;
} {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const storage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const defaultDir = join(homedir(), ".claude");
  const configDir = (configured ?? defaultDir).normalize("NFC");
  const credentialDir =
    storage === undefined
      ? configDir
      : (storage || defaultDir).normalize("NFC");
  // An explicitly empty storage override selects the unsuffixed service even
  // when CLAUDE_CONFIG_DIR is set. Hash the raw NFC path, just as the vendor
  // does: resolving a relative path or expanding ~ would select another item.
  const suffixed =
    storage === undefined ? Boolean(configured) : Boolean(storage);
  const suffix = suffixed
    ? `-${createHash("sha256").update(credentialDir).digest("hex").slice(0, 8)}`
    : "";
  return {
    configDir,
    credentialDir,
    keychainService: `${CLAUDE_KEYCHAIN_SERVICE}${suffix}`,
  };
}
