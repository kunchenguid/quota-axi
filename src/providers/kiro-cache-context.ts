import type { ProviderQuota } from "../types.js";

const READING_CONTEXT = Symbol("kiroReadingContext");
type ContextualQuota = ProviderQuota & { [READING_CONTEXT]?: string };

export function withKiroReadingContext(
  report: ProviderQuota,
  contextId: string | undefined,
): ProviderQuota {
  return { ...report, [READING_CONTEXT]: contextId } as ContextualQuota;
}

export function kiroReadingContextId(
  report: ProviderQuota,
): string | undefined {
  return (report as ContextualQuota)[READING_CONTEXT];
}
