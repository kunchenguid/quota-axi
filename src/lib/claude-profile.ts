import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Mirrors Claude Code's configuration and secure-storage selectors. The vendor
 * derives one storage directory from `CLAUDE_SECURESTORAGE_CONFIG_DIR`, falling
 * back to `CLAUDE_CONFIG_DIR` and then `~/.claude`, and builds both its
 * plaintext `.credentials.json` path and its Keychain service name from it, so
 * the storage override moves the file as well as the service.
 */
export function claudeProfileLocations(): {
  configDir: string;
  credentialDir: string;
  keychainService: string;
  keychainServiceAliases: string[];
} {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const storage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const defaultDir = join(homedir(), ".claude").normalize("NFC");
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
  const keychainService = suffixed
    ? suffixedKeychainService(credentialDir)
    : CLAUDE_KEYCHAIN_SERVICE;
  // The unsuffixed service is exactly what the vendor writes for `~/.claude`,
  // so when that is the selected credential directory both spellings name this
  // same profile: a session that set CLAUDE_CONFIG_DIR to the default path
  // stores the suffixed item for it. Any other suffix names a directory this
  // process did not select and stays another profile's item.
  const alias =
    credentialDir !== defaultDir
      ? undefined
      : suffixed
        ? CLAUDE_KEYCHAIN_SERVICE
        : suffixedKeychainService(credentialDir);
  return {
    configDir,
    credentialDir,
    keychainService,
    keychainServiceAliases: alias ? [alias] : [],
  };
}

function suffixedKeychainService(credentialDir: string): string {
  const suffix = createHash("sha256")
    .update(credentialDir)
    .digest("hex")
    .slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}
