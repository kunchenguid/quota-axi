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

/**
 * The same UTC civil time `months` calendar months before `iso`, with the day
 * clamped into a shorter month so a 31 March reset steps back to 28/29
 * February rather than overflowing into early March. This is how a
 * renewal-dated subscription cycle maps a reported reset back to the cycle's
 * start; it is never a fixed day count. Returns `undefined` when `iso` is not
 * a date or the result is not strictly earlier.
 */
export function calendarMonthsBefore(
  iso: string,
  months: number,
): string | undefined {
  const reset = new Date(iso);
  const time = reset.getTime();
  if (!Number.isFinite(time)) return undefined;
  const day = reset.getUTCDate();
  const start = new Date(time);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const daysInMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, daysInMonth));
  const startTime = start.getTime();
  return Number.isFinite(startTime) && startTime < time
    ? start.toISOString()
    : undefined;
}
