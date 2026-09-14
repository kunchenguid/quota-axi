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
  acceptsOpaqueDefaultItem: boolean;
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
    // A default selection cannot re-derive the suffix Claude Code gave its own
    // item, so a suffixed item may still be this profile's. An explicit
    // selector names one exact item and must never fall through to another.
    acceptsOpaqueDefaultItem: selector === undefined,
  };
}

/** The `Claude Code-credentials-<8 lowercase hex>` shape the vendor writes. */
export function isOpaqueSuffixedKeychainService(service: string): boolean {
  return (
    service.startsWith(`${CLAUDE_KEYCHAIN_SERVICE}-`) &&
    /^[0-9a-f]{8}$/.test(service.slice(CLAUDE_KEYCHAIN_SERVICE.length + 1))
  );
}

function suffixedKeychainService(selector: string): string {
  const suffix = createHash("sha256")
    .update(selector)
    .digest("hex")
    .slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}
