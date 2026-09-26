/**
 * The cache identity the MiniMax reading this process produced belongs to, or
 * `undefined` when no reading has claimed one yet.
 *
 * The cache writer reads this rather than deriving an identity for itself: a
 * cached snapshot must name the credential source that produced it, and by
 * write time the resolution that answered is no longer visible to the writer.
 * MiniMax's identity is the answering source plus the deployment host its
 * resolution carries - the env variable, the Pi `minimax` entry, or the CLI
 * `config.json` credential with the base URL that config implies - so stale
 * fallback reuses a snapshot only for the source and deployment that recorded
 * it. Like the Kimi identifiers, it discriminates source and endpoint rather
 * than accounts, so it does not distinguish two credentials in one source.
 */
let readingContextId: string | undefined;

export function publishMiniMaxReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

export function miniMaxReadingContextId(): string | undefined {
  return readingContextId;
}
