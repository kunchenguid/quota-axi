import { describe, expect, it } from "vitest";
import {
  computeEffectiveRunway,
  computeWindowPace,
  PACE_EARLY_ELAPSED_PERCENT,
  PACE_ON_PACE_DEADBAND_PERCENT_POINTS,
  SELECTION_CLAMP_PERCENT_POINTS,
  SELECTION_MIN_TIME_REMAINING_PERCENT,
  summarizeEffectivePace,
  summarizeEffectiveSelection,
} from "../src/pace.js";
import { SELECTION_SCALAR_KEY } from "../src/types.js";
import type { QuotaPace, QuotaWindow } from "../src/types.js";

const GENERATED_AT = "2026-07-15T12:00:00.000Z";
const WEEK_SECONDS = 604_800;
const FIVE_HOURS_SECONDS = 18_000;

function window(
  partial: Partial<QuotaWindow> & Pick<QuotaWindow, "id">,
): QuotaWindow {
  return {
    label: partial.label ?? partial.id,
    kind: partial.kind ?? "weekly",
    ...partial,
  };
}

function resetsAfter(
  elapsedFraction: number,
  cycleSeconds = WEEK_SECONDS,
): string {
  const generatedAtMs = Date.parse(GENERATED_AT);
  const remainingSeconds = cycleSeconds * (1 - elapsedFraction);
  return new Date(generatedAtMs + remainingSeconds * 1000).toISOString();
}

function startsBefore(
  elapsedFraction: number,
  cycleSeconds = WEEK_SECONDS,
): string {
  const generatedAtMs = Date.parse(GENERATED_AT);
  return new Date(
    generatedAtMs - cycleSeconds * elapsedFraction * 1000,
  ).toISOString();
}

describe("computeWindowPace", () => {
  it("classifies ahead, behind, and on_pace with signed reserve", () => {
    const ahead = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 50,
        percentRemaining: 50,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(0.25),
      }),
      GENERATED_AT,
    );
    expect(ahead.status).toBe("ahead");
    expect(ahead.reservePercentPoints).toBeCloseTo(50 - 75, 4);
    expect(ahead.burnMultiple).toBeCloseTo(2, 4);
    expect(ahead.cycleBasis).toBe("window_seconds");

    const behind = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 10,
        percentRemaining: 90,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(0.5),
      }),
      GENERATED_AT,
    );
    expect(behind.status).toBe("behind");
    expect(behind.reservePercentPoints).toBeCloseTo(40, 4);
    expect(behind.burnMultiple).toBeCloseTo(0.2, 4);

    const onPace = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 50,
        percentRemaining: 50,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(0.5),
      }),
      GENERATED_AT,
    );
    expect(onPace.status).toBe("on_pace");
    expect(onPace.reservePercentPoints).toBeCloseTo(0, 4);
    expect(Math.abs(onPace.reservePercentPoints ?? 99)).toBeLessThanOrEqual(
      PACE_ON_PACE_DEADBAND_PERCENT_POINTS,
    );
  });

  it("uses startsAt + resetsAt when both boundaries are present", () => {
    const elapsed = 0.4;
    const pace = computeWindowPace(
      window({
        id: "credits",
        kind: "credits",
        percentUsed: 20,
        percentRemaining: 80,
        startsAt: startsBefore(elapsed),
        resetsAt: resetsAfter(elapsed),
      }),
      GENERATED_AT,
    );

    expect(pace).toMatchObject({
      status: "behind",
      cycleBasis: "starts_at_resets_at",
      cycleSeconds: WEEK_SECONDS,
    });
    expect(pace.elapsedPercent).toBeCloseTo(40, 4);
    expect(pace.reservePercentPoints).toBeCloseTo(20, 4);
  });

  it("labels early-cycle projections and omits burn multiple at zero elapsed", () => {
    const earlyElapsed = (PACE_EARLY_ELAPSED_PERCENT - 1) / 100;
    const early = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 20,
        percentRemaining: 80,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(earlyElapsed),
      }),
      GENERATED_AT,
    );
    expect(early.status).toBe("ahead");
    expect(early.projectionConfidence).toBe("early");
    expect(early.projectedExhaustedAt).toEqual(expect.any(String));

    const zeroElapsed = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 0,
        percentRemaining: 100,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(0),
      }),
      GENERATED_AT,
    );
    expect(zeroElapsed.status).toBe("on_pace");
    expect(zeroElapsed.burnMultiple).toBeUndefined();
    expect(zeroElapsed.projectedExhaustedAt).toBeUndefined();

    const usedAtStart = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 5,
        percentRemaining: 95,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(0),
      }),
      GENERATED_AT,
    );
    expect(usedAtStart.status).toBe("ahead");
    expect(usedAtStart.burnMultiple).toBeUndefined();
    expect(usedAtStart.projectedExhaustedAt).toBeUndefined();
  });

  it("omits projections outside the representable timestamp range", () => {
    const pace = computeWindowPace(
      window({
        id: "credits",
        kind: "credits",
        percentUsed: 0.000001,
        percentRemaining: 99.999999,
        startsAt: startsBefore(1 / 7),
        resetsAt: resetsAfter(1 / 7),
      }),
      GENERATED_AT,
    );

    expect(pace.status).toBe("behind");
    expect(pace.burnMultiple).toBeDefined();
    expect(pace.projectedExhaustedAt).toBeUndefined();
    expect(pace.projectionConfidence).toBeUndefined();
  });

  it("returns unknown for stale, missing, expired, rolling, and invalid cycles", () => {
    expect(
      computeWindowPace(
        window({
          id: "weekly",
          percentUsed: 10,
          percentRemaining: 90,
          windowSeconds: WEEK_SECONDS,
          resetsAt: resetsAfter(0.2),
        }),
        GENERATED_AT,
        { stale: true },
      ),
    ).toEqual({ status: "unknown", reason: "stale" });

    expect(
      computeWindowPace(
        window({
          id: "weekly",
          windowSeconds: WEEK_SECONDS,
          resetsAt: resetsAfter(0.2),
        }),
        GENERATED_AT,
      ),
    ).toEqual({ status: "unknown", reason: "missing_usage" });

    expect(
      computeWindowPace(
        window({
          id: "weekly",
          percentUsed: 10,
          percentRemaining: 90,
          resetsAt: resetsAfter(0.2),
        }),
        GENERATED_AT,
      ),
    ).toEqual({ status: "unknown", reason: "missing_cycle" });

    expect(
      computeWindowPace(
        window({
          id: "weekly",
          percentUsed: 10,
          percentRemaining: 90,
          windowSeconds: WEEK_SECONDS,
          resetsAt: "2026-07-15T11:00:00.000Z",
        }),
        GENERATED_AT,
      ),
    ).toEqual({ status: "unknown", reason: "expired_reset" });

    expect(
      computeWindowPace(
        window({
          id: "weekly",
          percentUsed: 10,
          percentRemaining: 90,
          startsAt: "2026-07-16T12:00:00.000Z",
          resetsAt: "2026-07-23T12:00:00.000Z",
        }),
        GENERATED_AT,
      ),
    ).toEqual({ status: "unknown", reason: "future_cycle_start" });

    expect(
      computeWindowPace(
        window({
          id: "weekly",
          percentUsed: 10,
          percentRemaining: 90,
          windowSeconds: 0,
          resetsAt: resetsAfter(0.2),
        }),
        GENERATED_AT,
      ),
    ).toEqual({ status: "unknown", reason: "invalid_cycle" });

    expect(
      computeWindowPace(
        window({
          id: "weekly",
          percentUsed: 10,
          percentRemaining: 90,
          windowSeconds: Number.MAX_VALUE,
          resetsAt: resetsAfter(0.2),
        }),
        GENERATED_AT,
      ),
    ).toEqual({ status: "unknown", reason: "invalid_cycle" });

    expect(
      computeWindowPace(
        window({
          id: "monthly",
          kind: "monthly",
          percentUsed: 10,
          percentRemaining: 90,
          resetsAt: resetsAfter(0.2),
        }),
        GENERATED_AT,
      ),
    ).toEqual({ status: "unknown", reason: "missing_cycle" });
  });

  it("matches the deterministic live acceptance fixtures", () => {
    // Codex weekly: 6% used, ~1.16% elapsed, ahead ~4.84 points, early projection.
    const codexElapsed = 0.0116;
    const codex = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 6,
        percentRemaining: 94,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(codexElapsed),
      }),
      GENERATED_AT,
    );
    expect(codex.status).toBe("ahead");
    expect(codex.elapsedPercent).toBeCloseTo(1.16, 2);
    expect(codex.reservePercentPoints).toBeCloseTo(-4.84, 2);
    expect(codex.projectionConfidence).toBe("early");
    expect(codex.burnMultiple).toBeCloseTo(6 / 1.16, 2);

    // Kimi weekly: 57% used, ~50.09% elapsed, ahead ~6.91, projection ~20h before reset.
    const kimiElapsed = 0.5009;
    const kimiResetsAt = resetsAfter(kimiElapsed);
    const kimi = computeWindowPace(
      window({
        id: "weekly",
        percentUsed: 57,
        percentRemaining: 43,
        windowSeconds: WEEK_SECONDS,
        resetsAt: kimiResetsAt,
      }),
      GENERATED_AT,
    );
    expect(kimi.status).toBe("ahead");
    expect(kimi.elapsedPercent).toBeCloseTo(50.09, 2);
    expect(kimi.reservePercentPoints).toBeCloseTo(-6.91, 2);
    expect(kimi.projectionConfidence).toBe("established");
    expect(kimi.projectedExhaustedAt).toEqual(expect.any(String));
    const kimiExhaustLeadHours =
      (Date.parse(kimiResetsAt) - Date.parse(kimi.projectedExhaustedAt!)) /
      3_600_000;
    expect(kimiExhaustLeadHours).toBeCloseTo(20, 0);

    // Claude Fable weekly: ~59% used, ~37% elapsed, materially ahead.
    const fable = computeWindowPace(
      window({
        id: "model:fable",
        kind: "model",
        percentUsed: 59,
        percentRemaining: 41,
        windowSeconds: WEEK_SECONDS,
        resetsAt: resetsAfter(0.37),
      }),
      GENERATED_AT,
    );
    expect(fable.status).toBe("ahead");
    expect(fable.reservePercentPoints).toBeCloseTo(41 - 63, 2);
    expect(fable.reservePercentPoints ?? 0).toBeLessThan(-15);

    // Grok weekly credits: 2% used, ~5.55% elapsed, behind ~3.55 points.
    const grokElapsed = 0.0555;
    const grok = computeWindowPace(
      window({
        id: "credits",
        kind: "credits",
        percentUsed: 2,
        percentRemaining: 98,
        startsAt: startsBefore(grokElapsed),
        resetsAt: resetsAfter(grokElapsed),
      }),
      GENERATED_AT,
    );
    expect(grok.status).toBe("behind");
    expect(grok.elapsedPercent).toBeCloseTo(5.55, 2);
    expect(grok.reservePercentPoints).toBeCloseTo(3.55, 2);
    expect(grok.cycleBasis).toBe("starts_at_resets_at");
  });

  it("supports five-hour duration-based cycles", () => {
    const pace = computeWindowPace(
      window({
        id: "five_hour",
        kind: "session",
        percentUsed: 50,
        percentRemaining: 50,
        windowSeconds: FIVE_HOURS_SECONDS,
        resetsAt: resetsAfter(0.5, FIVE_HOURS_SECONDS),
      }),
      GENERATED_AT,
    );
    expect(pace.status).toBe("on_pace");
    expect(pace.cycleSeconds).toBe(FIVE_HOURS_SECONDS);
  });
});

describe("computeEffectiveRunway", () => {
  function pacedWindow(
    id: string,
    percentRemaining: number,
    elapsedFraction: number,
    extra: Partial<QuotaWindow> = {},
  ): QuotaWindow {
    const value = window({
      id,
      percentUsed: 100 - percentRemaining,
      percentRemaining,
      windowSeconds: WEEK_SECONDS,
      resetsAt: resetsAfter(elapsedFraction),
      ...extra,
    });
    return { ...value, pace: computeWindowPace(value, GENERATED_AT) };
  }

  it("uses the earliest projected exhaustion across joint authoritative bounds", () => {
    const first = pacedWindow("weekly", 50, 0.25);
    const second = pacedWindow("five_hour", 50, 0.4);

    expect(computeEffectiveRunway([first, second], GENERATED_AT)).toMatchObject(
      {
        status: "projected_exhaustion",
        usableRunwaySeconds: 151_200,
        limitingWindowId: "weekly",
        projectionConfidence: "established",
        projectedExhaustedAt: first.pace?.projectedExhaustedAt,
      },
    );
  });

  it("reports zero remaining as exhausted now without requiring a cycle projection", () => {
    expect(
      computeEffectiveRunway(
        [
          window({
            id: "weekly",
            percentUsed: 100,
            percentRemaining: 0,
          }),
        ],
        GENERATED_AT,
      ),
    ).toEqual({
      status: "exhausted_now",
      usableRunwaySeconds: 0,
      projectedExhaustedAt: GENERATED_AT,
      limitingWindowId: "weekly",
    });
  });

  it("reports through_reset when every bound reaches its own reset", () => {
    const zeroUse = pacedWindow("five_hour", 100, 0.5);
    const sustainable = pacedWindow("weekly", 90, 0.5);

    expect(
      computeEffectiveRunway([zeroUse, sustainable], GENERATED_AT),
    ).toEqual({
      status: "through_reset",
      projectionConfidence: "established",
    });
  });

  it("preserves uncertainty when a bounding projection is stale or malformed", () => {
    const projected = pacedWindow("weekly", 50, 0.25);
    const stale = pacedWindow("five_hour", 50, 0.25);
    stale.pace = { status: "unknown", reason: "stale" };

    expect(computeEffectiveRunway([projected, stale], GENERATED_AT)).toEqual({
      status: "unknown",
      unmeasurableWindowIds: ["five_hour"],
    });

    const invalidTimestamp = pacedWindow("invalid", 50, 0.25, {
      resetsAt: "not-a-timestamp",
    });
    expect(computeEffectiveRunway([invalidTimestamp], GENERATED_AT)).toEqual({
      status: "unknown",
      unmeasurableWindowIds: ["invalid"],
    });
  });

  it("treats a not-yet-triggered window (missing resetsAt) as fully available, not unmeasurable", () => {
    const fiveHour = window({
      id: "five_hour",
      kind: "session",
      percentUsed: 0,
      percentRemaining: 100,
      windowSeconds: FIVE_HOURS_SECONDS,
      // No resetsAt: the clock has not started.
    });
    fiveHour.pace = computeWindowPace(fiveHour, GENERATED_AT);
    expect(fiveHour.pace).toEqual({
      status: "unknown",
      reason: "missing_cycle",
    });

    const sevenDay = pacedWindow("seven_day", 90, 0.5);

    const runway = computeEffectiveRunway([fiveHour, sevenDay], GENERATED_AT);
    expect(runway.status).not.toBe("unknown");
    expect(runway.unmeasurableWindowIds).toBeUndefined();
    expect(["through_reset", "projected_exhaustion"]).toContain(runway.status);
  });

  it("reports through_reset when every window in scope has not yet triggered", () => {
    const fiveHour = window({
      id: "five_hour",
      kind: "session",
      percentUsed: 0,
      percentRemaining: 100,
      windowSeconds: FIVE_HOURS_SECONDS,
    });
    fiveHour.pace = computeWindowPace(fiveHour, GENERATED_AT);
    const sevenDay = window({
      id: "seven_day",
      percentUsed: 0,
      percentRemaining: 100,
      windowSeconds: WEEK_SECONDS,
    });
    sevenDay.pace = computeWindowPace(sevenDay, GENERATED_AT);

    expect(computeEffectiveRunway([fiveHour, sevenDay], GENERATED_AT)).toEqual({
      status: "through_reset",
      projectionConfidence: "established",
    });
  });

  it("still fails closed when a not-yet-triggered window also lacks usable percentRemaining", () => {
    const broken = window({
      id: "five_hour",
      kind: "session",
      windowSeconds: FIVE_HOURS_SECONDS,
      // No resetsAt and no percentRemaining: a genuine data gap, not merely
      // "not yet triggered".
    });
    const sevenDay = pacedWindow("seven_day", 90, 0.5);

    expect(computeEffectiveRunway([broken, sevenDay], GENERATED_AT)).toEqual({
      status: "unknown",
      unmeasurableWindowIds: ["five_hour"],
    });
  });

  it("fails closed for a malformed resetsAt even at 100% remaining (not merely missing)", () => {
    const malformed = window({
      id: "five_hour",
      kind: "session",
      percentUsed: 0,
      percentRemaining: 100,
      windowSeconds: FIVE_HOURS_SECONDS,
      resetsAt: "not-a-timestamp",
    });
    malformed.pace = computeWindowPace(malformed, GENERATED_AT);
    const sevenDay = pacedWindow("seven_day", 90, 0.5);

    expect(computeEffectiveRunway([malformed, sevenDay], GENERATED_AT)).toEqual(
      {
        status: "unknown",
        unmeasurableWindowIds: ["five_hour"],
      },
    );
  });

  it("keeps early confidence and exact snapshot-clock edges deterministic", () => {
    const early = pacedWindow("weekly", 50, 0.05);
    expect(computeEffectiveRunway([early], GENERATED_AT)).toMatchObject({
      status: "projected_exhaustion",
      projectionConfidence: "early",
      usableRunwaySeconds: 30_240,
    });

    const resetAtSnapshot = window({
      id: "weekly",
      percentUsed: 0,
      percentRemaining: 100,
      windowSeconds: WEEK_SECONDS,
      resetsAt: GENERATED_AT,
    });
    resetAtSnapshot.pace = computeWindowPace(resetAtSnapshot, GENERATED_AT);
    expect(computeEffectiveRunway([resetAtSnapshot], GENERATED_AT)).toEqual({
      status: "unknown",
      unmeasurableWindowIds: ["weekly"],
    });
  });
});

describe("summarizeEffectivePace", () => {
  it("flags a non-limiting bounding window that is ahead", () => {
    const fiveHour = window({
      id: "five_hour",
      kind: "session",
      percentUsed: 10,
      percentRemaining: 90,
      pace: {
        status: "behind",
        reservePercentPoints: 20,
      },
    });
    const weekly = window({
      id: "weekly",
      percentUsed: 60,
      percentRemaining: 40,
      pace: {
        status: "ahead",
        reservePercentPoints: -15,
      },
    });

    expect(summarizeEffectivePace([fiveHour, weekly])).toEqual({
      status: "mixed",
      aheadWindowIds: ["weekly"],
      behindWindowIds: ["five_hour"],
      worstReservePercentPoints: -15,
      worstReserveWindowId: "weekly",
    });
  });

  it("reports mixed and unknown aggregates", () => {
    expect(
      summarizeEffectivePace([
        window({
          id: "a",
          pace: { status: "ahead", reservePercentPoints: -2 },
        }),
        window({
          id: "b",
          pace: { status: "behind", reservePercentPoints: 4 },
        }),
      ]),
    ).toMatchObject({
      status: "mixed",
      aheadWindowIds: ["a"],
      behindWindowIds: ["b"],
      worstReservePercentPoints: -2,
      worstReserveWindowId: "a",
    });

    expect(
      summarizeEffectivePace([
        window({
          id: "x",
          pace: { status: "unknown", reason: "missing_cycle" },
        }),
      ]),
    ).toEqual({
      status: "unknown",
      unknownWindowIds: ["x"],
    });
  });

  it("does not let a not-yet-triggered window's unknown pace poison a mixed aggregate", () => {
    const fiveHour = window({
      id: "five_hour",
      pace: { status: "unknown", reason: "missing_cycle" },
    });
    const weekly = window({
      id: "weekly",
      pace: { status: "on_pace", reservePercentPoints: 0.4 },
    });

    expect(summarizeEffectivePace([fiveHour, weekly])).toEqual({
      status: "on_pace",
      onPaceWindowIds: ["weekly"],
      unknownWindowIds: ["five_hour"],
      worstReservePercentPoints: 0.4,
      worstReserveWindowId: "weekly",
    });
  });
});

describe("summarizeEffectiveSelection", () => {
  function bounded(
    id: string,
    percentRemaining: number,
    pace: Partial<QuotaPace> & Pick<QuotaPace, "timeRemainingPercent">,
  ): QuotaWindow {
    return window({
      id,
      percentUsed: 100 - percentRemaining,
      percentRemaining,
      pace: {
        status: "on_pace",
        cycleSeconds: WEEK_SECONDS,
        burnMultiple: 1,
        elapsedPercent: 100 - pace.timeRemainingPercent!,
        ...pace,
      },
    });
  }

  it("is positive when allowance is projected to reach reset unused", () => {
    expect(
      summarizeEffectiveSelection([
        bounded("weekly", 80, { timeRemainingPercent: 40, burnMultiple: 1 }),
      ]),
    ).toEqual({ status: "known", [SELECTION_SCALAR_KEY]: 1 });
  });

  it("is exactly zero at perfect utilization", () => {
    expect(
      summarizeEffectiveSelection([
        bounded("weekly", 50, { timeRemainingPercent: 50, burnMultiple: 1 }),
      ]),
    ).toEqual({ status: "known", [SELECTION_SCALAR_KEY]: 0 });
  });

  it("is negative when the scope is overdrawn against its reset clock", () => {
    expect(
      summarizeEffectiveSelection([
        bounded("weekly", 10, { timeRemainingPercent: 50, burnMultiple: 2 }),
      ]),
    ).toEqual({ status: "known", [SELECTION_SCALAR_KEY]: -1.8 });
  });

  it("clamps the scalar at both ends", () => {
    expect(
      summarizeEffectiveSelection([
        bounded("weekly", 100, { timeRemainingPercent: 0.02, burnMultiple: 0 }),
      ])[SELECTION_SCALAR_KEY],
    ).toBe(SELECTION_CLAMP_PERCENT_POINTS);

    expect(
      summarizeEffectiveSelection([
        bounded("weekly", 0, { timeRemainingPercent: 50, burnMultiple: 500 }),
      ])[SELECTION_SCALAR_KEY],
    ).toBe(-SELECTION_CLAMP_PERCENT_POINTS);
  });

  it("weights each bounding window by its own cycle length", () => {
    const session = bounded("five_hour", 90, {
      timeRemainingPercent: 60,
      burnMultiple: 0.25,
      cycleSeconds: FIVE_HOURS_SECONDS,
    });
    const weekly = bounded("seven_day", 80, {
      timeRemainingPercent: 50,
      burnMultiple: 0.7,
      cycleSeconds: WEEK_SECONDS,
    });
    const sessionGap = 90 / 60 - 0.25;
    const weeklyGap = 80 / 50 - 0.7;
    const weighted =
      (sessionGap * FIVE_HOURS_SECONDS + weeklyGap * WEEK_SECONDS) /
      (FIVE_HOURS_SECONDS + WEEK_SECONDS);

    const summary = summarizeEffectiveSelection([session, weekly]);
    expect(summary.status).toBe("known");
    expect(summary[SELECTION_SCALAR_KEY]).toBeCloseTo(weighted, 4);
    // The unweighted mean would over-credit the short session window.
    expect(summary[SELECTION_SCALAR_KEY]).not.toBeCloseTo(
      (sessionGap + weeklyGap) / 2,
      4,
    );
  });

  it("makes the whole scope unmeasurable when any bound has unknown pace", () => {
    expect(
      summarizeEffectiveSelection([
        bounded("seven_day", 80, { timeRemainingPercent: 50 }),
        window({
          id: "five_hour",
          percentRemaining: 90,
          pace: { status: "unknown", reason: "missing_cycle" },
        }),
      ]),
    ).toEqual({ status: "unknown", unmeasurableWindowIds: ["five_hour"] });
  });

  it("treats a near-zero or absent remaining cycle as unmeasurable", () => {
    for (const timeRemainingPercent of [
      0,
      SELECTION_MIN_TIME_REMAINING_PERCENT / 10,
      -5,
    ]) {
      expect(
        summarizeEffectiveSelection([
          bounded("weekly", 100, { timeRemainingPercent, burnMultiple: 0 }),
        ]),
      ).toEqual({ status: "unknown", unmeasurableWindowIds: ["weekly"] });
    }

    expect(
      summarizeEffectiveSelection([
        window({
          id: "weekly",
          pace: {
            status: "on_pace",
            timeRemainingPercent: 50,
            elapsedPercent: 50,
            burnMultiple: 1,
            cycleSeconds: WEEK_SECONDS,
          },
        }),
      ]),
    ).toEqual({ status: "unknown", unmeasurableWindowIds: ["weekly"] });
  });

  it("reads an untouched zero-elapsed window as zero burn, not as unknown", () => {
    expect(
      summarizeEffectiveSelection([
        window({
          id: "five_hour",
          percentUsed: 0,
          percentRemaining: 100,
          pace: {
            status: "behind",
            timeRemainingPercent: 100,
            elapsedPercent: 0,
            cycleSeconds: FIVE_HOURS_SECONDS,
          },
        }),
      ]),
    ).toEqual({ status: "known", [SELECTION_SCALAR_KEY]: 1 });
  });

  it("fails closed when burnMultiple is missing after time has elapsed", () => {
    expect(
      summarizeEffectiveSelection([
        window({
          id: "weekly",
          percentUsed: 40,
          percentRemaining: 60,
          pace: {
            status: "behind",
            timeRemainingPercent: 50,
            elapsedPercent: 50,
            cycleSeconds: WEEK_SECONDS,
          },
        }),
      ]),
    ).toEqual({ status: "unknown", unmeasurableWindowIds: ["weekly"] });
  });

  it("fails closed when the weighted sum overflows to a non-finite value", () => {
    expect(
      summarizeEffectiveSelection([
        bounded("weekly", 100, {
          timeRemainingPercent: 25,
          burnMultiple: 0,
          cycleSeconds: Number.MAX_VALUE,
        }),
      ]),
    ).toEqual({ status: "unknown", unmeasurableWindowIds: ["weekly"] });
  });

  it("reports unknown without inventing bounds for an empty scope", () => {
    expect(summarizeEffectiveSelection([])).toEqual({ status: "unknown" });
  });
});
