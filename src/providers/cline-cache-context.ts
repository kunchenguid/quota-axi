import { createHash } from "node:crypto";

/**
 * The cache identity the Cline reading this process produced belongs to, or
 * `undefined` when nothing has claimed one yet.
 *
 * Cline is keyed by one Bearer token, and that token is the account: two
 * tokens in the same slot (an env override versus a re-authenticated
 * providers.json) can name different accounts or organizations. The cache
 * writer reads this stamp rather than deriving an identity for itself, so a
 * snapshot is reused only for the token that actually produced it.
 */
let readingContextId: string | undefined;

/**
 * Claims the identity a snapshot written from here on belongs to. Publish as
 * soon as a usable token is resolved, so a failed read can still serve that
 * same token's own stale snapshot and no other.
 */
export function publishClineReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

/** Drop any previously published identity so a later reading cannot inherit it. */
export function clearClineReadingContextId(): void {
  readingContextId = undefined;
}

export function clineReadingContextId(): string | undefined {
  return readingContextId;
}

/**
 * Opaque SHA-256 of the answering source plus a one-way digest of the token it
 * answered with. The token never enters the cache, is never rendered, and is
 * never logged: only this digest is, and it cannot be reversed to the token.
 *
 * Rotating the token (or switching between the env override and
 * providers.json) produces a different identity, so a different account or
 * organization's stale balance is never served in its place.
 */
export function clineCacheContextId(
  source: string,
  credential: string,
): string {
  const tokenDigest = createHash("sha256")
    .update(`cline-token-v1\0${credential}`)
    .digest("hex");
  return createHash("sha256")
    .update(`cline\0${source}\0${tokenDigest}`)
    .digest("hex");
}
