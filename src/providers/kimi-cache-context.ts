/**
 * The cache identity the Kimi reading this process produced belongs to, or
 * `undefined` when nothing has claimed one yet.
 *
 * The cache writer reads this rather than deriving an identity for itself, for
 * two reasons. By the time a snapshot is written, the file that names the Kimi
 * Code environment may describe a different one than the reading came from, so
 * a read taken there could file one deployment's numbers under the other's
 * identity. And the environment is not what every reading is scoped to at all:
 * a Pi-brokered reading records no Kimi Code deployment and always contacts the
 * default endpoint, so attributing it to whichever environment `config.toml`
 * happens to select would let its numbers be served back as that deployment's
 * stale reading.
 *
 * Publishing the identity of whatever actually produced the reading is the only
 * stamp that cannot make either mistake.
 */
let readingContextId: string | undefined;

/**
 * Claims the identity a snapshot written from here on belongs to. Selecting a
 * Kimi Code environment claims the identity a CLI reading would carry; a
 * reading then claims the identity of the source that actually produced it.
 */
export function publishKimiReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

export function kimiReadingContextId(): string | undefined {
  return readingContextId;
}
