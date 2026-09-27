import { createHash } from "node:crypto";

/**
 * The cache identity the Muse reading this process produced belongs to, or
 * `undefined` when nothing has claimed one yet.
 *
 * A Muse reading is produced by one credential - the Muse CLI's stored OAuth
 * access token or an explicitly exported `META_API_KEY` - and that credential
 * is the only local thing naming the account. The cache writer reads this stamp
 * rather than deriving an identity for itself, so a snapshot is reused only for
 * the credential that actually produced it.
 */
let readingContextId: string | undefined;

/** Claims the identity a snapshot written from here on belongs to. */
export function publishMuseReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

/** Drop any previously published identity so a later reading cannot inherit it. */
export function clearMuseReadingContextId(): void {
  readingContextId = undefined;
}

export function museReadingContextId(): string | undefined {
  return readingContextId;
}

/**
 * Opaque SHA-256 of the answering source plus a one-way digest of the
 * credential it answered with. The credential never enters the cache or the
 * attempt ledger, is never rendered, and is never logged: only this digest is,
 * and it cannot be reversed to the credential.
 *
 * Interval replay and stale fallback require this identity to match, so a
 * token the Muse CLI has since refreshed is a cache miss, never a
 * cross-attribution between accounts. Muse is excluded from `--max-age`
 * fresh reuse, which cannot see a Keychain login switch.
 */
export function museCacheContextId(source: string, credential: string): string {
  const credentialDigest = createHash("sha256")
    .update(`muse-credential-v1\0${credential}`)
    .digest("hex");
  return createHash("sha256")
    .update(`muse\0${source}\0${credentialDigest}`)
    .digest("hex");
}
