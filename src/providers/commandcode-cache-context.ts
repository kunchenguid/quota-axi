import { createHash } from "node:crypto";

/**
 * The cache identity the Command Code reading this process produced belongs
 * to, or `undefined` when nothing has claimed one yet.
 *
 * Command Code has several local sources that can point at different
 * accounts. The cache writer reads this stamp rather than deriving an identity
 * for itself, so a snapshot is reused only for the source and account the
 * current `whoami` actually identified.
 */
let readingContextId: string | undefined;

/**
 * Claims the identity a snapshot written from here on belongs to. Publish
 * only after `whoami` identifies the current account.
 */
export function publishCommandCodeReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

/** Drop any previously published identity so a later reading cannot inherit it. */
export function clearCommandCodeReadingContextId(): void {
  readingContextId = undefined;
}

export function commandCodeReadingContextId(): string | undefined {
  return readingContextId;
}

/**
 * Opaque SHA-256 of the winning source plus the current-account identity.
 * The hash input never enters the cache.
 */
export function commandCodeCacheContextId(
  source: string,
  accountIdentity: string,
): string {
  return createHash("sha256")
    .update(`commandcode\0${source}\0${accountIdentity}`)
    .digest("hex");
}
