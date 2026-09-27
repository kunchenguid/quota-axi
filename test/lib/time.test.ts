import { describe, expect, it } from "vitest";
import { calendarMonthsBefore } from "../../src/lib/time.js";

describe("calendarMonthsBefore", () => {
  it("keeps the day and UTC time of day one calendar month earlier", () => {
    expect(calendarMonthsBefore("2026-10-10T07:30:15.250Z", 1)).toBe(
      "2026-09-10T07:30:15.250Z",
    );
  });

  it("clamps the day into a shorter month instead of overflowing", () => {
    expect(calendarMonthsBefore("2026-03-31T00:00:00.000Z", 1)).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(calendarMonthsBefore("2028-03-31T00:00:00.000Z", 1)).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(calendarMonthsBefore("2026-10-31T12:00:00.000Z", 1)).toBe(
      "2026-09-30T12:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    expect(calendarMonthsBefore("2027-01-15T00:00:00.000Z", 1)).toBe(
      "2026-12-15T00:00:00.000Z",
    );
  });

  it("steps back several months", () => {
    expect(calendarMonthsBefore("2027-05-31T00:00:00.000Z", 3)).toBe(
      "2027-02-28T00:00:00.000Z",
    );
    expect(calendarMonthsBefore("2027-05-31T00:00:00.000Z", 12)).toBe(
      "2026-05-31T00:00:00.000Z",
    );
  });

  it("returns undefined for a value that is not a date", () => {
    expect(calendarMonthsBefore("not a date", 1)).toBeUndefined();
  });

  it("returns undefined when the result is not strictly earlier", () => {
    expect(calendarMonthsBefore("2026-10-10T00:00:00.000Z", 0)).toBeUndefined();
  });
});
