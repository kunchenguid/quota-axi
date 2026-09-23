import type {
  DegradedSource,
  ProviderAdapter,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";

/**
 * A credential source that was not genuinely absent and did not yield a reading.
 *
 * The default is derived from the attempt itself - a source that was tried and
 * errored, or one that was skipped after resolving beyond absence - so a new
 * provider inherits the correct answer without restating it. A provider whose
 * non-success attempt is not a credential problem (a live model-auth probe
 * that simply carries no quota, an identity lookup that is not a source at all)
 * sets `degraded: false` on that attempt to say so explicitly, and a provider
 * whose skipped source was itself unreadable - so presence could not be
 * established either way - sets `degraded: true`.
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
    if (attempt.status === "success" || attempt.degraded === false) {
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

/**
 * How present a provider is on this machine, as the human report groups it.
 *
 * - `live`: a fresh or stale reading, so there is something to draw.
 * - `attention`: no reading, but a source found something - a credential
 *   (expired, rejected, or waiting on a prompt), an installed tool that
 *   failed, or a request that failed - so the user has this provider and it is
 *   broken. A provider that recorded no attempts at all lands here too:
 *   absence was never shown.
 * - `absent`: every source was skipped as genuinely absent. This positive
 *   evidence is the only thing that lets a report fold a provider away.
 */
export type ProviderPresence = "live" | "attention" | "absent";

/**
 * Classify a provider reading by the evidence its own attempts carry. A skip
 * without a present credential or a degraded store is absence, however the
 * adapter words it; the adapter that owns a source declares the two
 * exceptions.
 *
 * - `isUncertainSkip`: a skip the adapter reads as establishing nothing either
 *   way (Copilot's CLI configuration that names no confirmable account, an
 *   installed Antigravity CLI that timed out) keeps the provider in view.
 * - `incidentalSources`: a sibling tool's login is not evidence of this
 *   provider (a GitHub CLI login is not Copilot access), so a skip there that
 *   read the store, or a request through it that was definitively refused,
 *   counts as absence. A store that could not be read, or a request that
 *   failed transiently, proves nothing and keeps the provider in view.
 */
export function providerPresence(
  provider: Pick<ProviderQuota, "state" | "attempts">,
  declarations: Pick<
    ProviderAdapter,
    "incidentalSources" | "isUncertainSkip"
  > = {},
): ProviderPresence {
  if (provider.state.status === "fresh" || provider.state.status === "stale") {
    return "live";
  }
  const attempts = provider.attempts ?? [];
  if (attempts.length === 0) return "attention";
  const incidental = new Set(declarations.incidentalSources ?? []);
  const showsAbsence = (attempt: SourceAttempt): boolean => {
    if (incidental.has(attempt.source)) {
      return (
        (attempt.status === "skipped" && attempt.degraded !== true) ||
        (attempt.status === "failed" &&
          provider.state.status === "auth_required")
      );
    }
    return (
      attempt.status === "skipped" &&
      attempt.credentialPresent !== true &&
      attempt.degraded !== true &&
      declarations.isUncertainSkip?.(attempt) !== true
    );
  };
  return attempts.every(showsAbsence) ? "absent" : "attention";
}
