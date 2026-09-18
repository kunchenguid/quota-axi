import type { ProviderQuota } from "./types.js";

// Enumerable symbols survive the report's immutable spread transforms, but
// JSON/TOON cannot publish them. Stamp the selection before any remote read.
const CACHE_CONTEXT = Symbol("quota-axi.cache-context");
type ContextualQuota = ProviderQuota & { [CACHE_CONTEXT]?: string };

export function withCacheContext(
  report: ProviderQuota,
  contextId: string,
): ProviderQuota {
  return { ...report, [CACHE_CONTEXT]: contextId } as ContextualQuota;
}

export function readingCacheContext(report: ProviderQuota): string | undefined {
  return (report as ContextualQuota)[CACHE_CONTEXT];
}
