import { createHash } from "node:crypto";

/**
 * The cache identity the Bob reading this process produced belongs to, or
 * `undefined` when nothing has claimed one yet.
 *
 * Bob is keyed by one API key, and only that key names the account: the profile
 * fields that could identify it are dropped while the response is parsed. The
 * cache writer reads this stamp rather than deriving an identity for itself, so
 * a snapshot is reused only for the key that actually produced it.
 */
let readingContextId: string | undefined;

/**
 * Claims the identity a snapshot written from here on belongs to. Publish as
 * soon as a usable key is resolved, so a failed read can still serve that same
 * key's own stale snapshot and no other.
 */
export function publishBobReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

/** Drop any previously published identity so a later reading cannot inherit it. */
export function clearBobReadingContextId(): void {
  readingContextId = undefined;
}

export function bobReadingContextId(): string | undefined {
  return readingContextId;
}

/**
 * Opaque SHA-256 of the answering source plus a one-way digest of the key it
 * answered with. The key never enters the cache, is never rendered, and is
 * never logged: only this digest is, and it cannot be reversed to the key.
 *
 * Rotating the key produces a different identity, so the previous account's
 * budget is never served for the new one. Two keys belonging to the same
 * account get separate slots too - a cache miss, never a cross-attribution.
 */
export function bobCacheContextId(source: string, credential: string): string {
  const keyDigest = createHash("sha256")
    .update(`bob-key-v1\0${credential}`)
    .digest("hex");
  return createHash("sha256")
    .update(`bob\0${source}\0${keyDigest}`)
    .digest("hex");
}
