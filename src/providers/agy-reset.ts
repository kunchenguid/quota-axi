const RESET_TIMESTAMP =
  /^(\d{4}|[+-]\d{6})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

export function agyResetTimestamp(value: string): number {
  const parts = RESET_TIMESTAMP.exec(value);
  if (!parts) return Number.NaN;
  const [, yearText, monthText, dayText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(dayText) > days[month - 1]) return Number.NaN;
  return Date.parse(value);
}
