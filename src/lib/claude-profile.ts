import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Mirrors Claude Code's configuration and secure-storage selectors. The
 * credential directory is `CLAUDE_CONFIG_DIR` or `~/.claude`; a nonempty
 * secure-storage selector names the Keychain service instead.
 */
export function claudeProfileLocations(): {
  configDir: string;
  secureStorageSelected: boolean;
  keychainService: string;
  keychainServiceAlias?: string;
} {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const storage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const defaultDir = join(homedir(), ".claude").normalize("NFC");
  const configDir = (configured ?? defaultDir).normalize("NFC");
  // Hash the raw NFC path, just as the vendor does: resolving a relative path
  // or expanding ~ would select another item.
  const storageSelector = storage ? storage.normalize("NFC") : undefined;
  const selector = storageSelector ?? (configured ? configDir : undefined);
  return {
    configDir,
    secureStorageSelected: storageSelector !== undefined,
    keychainService: selector
      ? suffixedKeychainService(selector)
      : CLAUDE_KEYCHAIN_SERVICE,
    // A default selection names `~/.claude`, and so does the suffixed spelling
    // of that same directory, so that one item is this profile's too. Any other
    // suffix names a directory this process did not select.
    keychainServiceAlias: selector
      ? undefined
      : suffixedKeychainService(defaultDir),
  };
}

function suffixedKeychainService(selector: string): string {
  const suffix = createHash("sha256")
    .update(selector)
    .digest("hex")
    .slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}
