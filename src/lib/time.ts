export function nowIso(): string {
  return new Date().toISOString();
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function percentRemaining(
  percentUsed: number | undefined,
): number | undefined {
  if (percentUsed === undefined) return undefined;
  return clampPercent(100 - percentUsed);
}

export function parseEpochOrIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
    return value;
  }
  return undefined;
}

export function retryAfterToIso(
  value: string | null,
  now = Date.now(),
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const date = new Date(now + seconds * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
