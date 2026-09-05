import type { DegradedSource, SourceAttempt } from "../types.js";

/**
 * A source that held a credential and did not yield a reading.
 *
 * The default is derived from the attempt itself - a source that was tried and
 * errored, or one that was skipped while still holding a credential - so a new
 * provider inherits the correct answer without restating it. A provider whose
 * non-success attempt is not a credential problem (a live model-auth probe
 * that simply carries no quota, an identity lookup that is not a source at all)
 * sets `degraded: false` on that attempt to say so explicitly.
 */
export function isDegradedSourceAttempt(attempt: SourceAttempt): boolean {
  if (attempt.degraded !== undefined) return attempt.degraded;
  if (attempt.status === "failed") return true;
  return attempt.status === "skipped" && attempt.credentialPresent === true;
}

/**
 * The degraded sources behind a report, in the order they were consulted and
 * one entry per source, so a source retried across credentials or a delegated
 * refresh is named once rather than once per attempt.
 */
export function degradedSources(
  attempts: SourceAttempt[] | undefined,
): DegradedSource[] {
  const bySource = new Map<string, DegradedSource>();
  for (const attempt of attempts ?? []) {
    if (attempt.status === "success") {
      bySource.delete(attempt.source);
      continue;
    }
    if (!isDegradedSourceAttempt(attempt)) continue;
    if (bySource.has(attempt.source)) continue;
    bySource.set(attempt.source, {
      source: attempt.source,
      ...(attempt.error ? { error: attempt.error } : {}),
    });
  }
  return [...bySource.values()];
}
