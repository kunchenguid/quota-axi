export type PiAuthEntryResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "present"; entry: Record<string, unknown> };

export function classifyPiAuthEntry(
  parsed: unknown,
  providerId: string,
): PiAuthEntryResult {
  if (!isObject(parsed)) return { status: "invalid" };
  if (!Object.hasOwn(parsed, providerId)) return { status: "missing" };
  const entry = parsed[providerId];
  return isObject(entry) ? { status: "present", entry } : { status: "invalid" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
