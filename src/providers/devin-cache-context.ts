import { createHash } from "node:crypto";

/**
 * The cache identity the Devin reading this process produced belongs to, or
 * `undefined` when nothing has claimed one yet.
 *
 * A Devin slot is shared by whichever credential answered. The cache writer
 * reads this stamp rather than deriving an identity for itself, so a snapshot
 * is reused only for the source, host, and key that actually produced it.
 */
let readingContextId: string | undefined;

/**
 * Claims the identity a snapshot written from here on belongs to. Publish as
 * soon as a usable credential is resolved, so a failed read can still serve
 * that same credential's own stale snapshot and no other.
 */
export function publishDevinReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

/** Drop any previously published identity so a later reading cannot inherit it. */
export function clearDevinReadingContextId(): void {
  readingContextId = undefined;
}

export function devinReadingContextId(): string | undefined {
  return readingContextId;
}

/**
 * Opaque SHA-256 of the answering source, the first-party host it was sent to,
 * and a one-way digest of the key. The key never enters the cache, is never
 * rendered, and is never logged.
 *
 * A new login gets a new token, which is a cache miss rather than serving the
 * previous account's windows. Two keys, or the same key aimed at a different
 * host, get separate identities too.
 */
export function devinCacheContextId(
  source: string,
  origin: string,
  credential: string,
): string {
  const keyDigest = createHash("sha256")
    .update(`devin-key-v1\0${credential}`)
    .digest("hex");
  return createHash("sha256")
    .update(`devin\0${source}\0${origin}\0${keyDigest}`)
    .digest("hex");
}
