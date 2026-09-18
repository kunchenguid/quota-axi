import type { ProviderQuota } from "../types.js";

const READING_CONTEXT = Symbol("kiroReadingContext");
type ContextualQuota = ProviderQuota & {
  [READING_CONTEXT]?: { id: string | undefined; retirementId: string };
};

export function withKiroReadingContext(
  report: ProviderQuota,
  contextId: string | undefined,
  retirementId: string,
): ProviderQuota {
  return {
    ...report,
    [READING_CONTEXT]: { id: contextId, retirementId },
  } as ContextualQuota;
}

export function kiroReadingContextId(
  report: ProviderQuota,
): string | undefined {
  return (report as ContextualQuota)[READING_CONTEXT]?.id;
}

export function kiroRetirementContextId(
  report: ProviderQuota,
): string | undefined {
  return (report as ContextualQuota)[READING_CONTEXT]?.retirementId;
}
