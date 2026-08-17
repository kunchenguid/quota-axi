import { describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../src/interpretation.js";
import {
  SELECTION_SCALAR_KEY,
  type ProviderQuota,
  type QuotaWindow,
} from "../src/types.js";

const GENERATED_AT = "2026-07-15T12:00:00.000Z";
const WEEK_SECONDS = 604_800;

function provider(
  provider: ProviderQuota["provider"],
  windows: QuotaWindow[],
): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "api",
    windows,
    state: { status: "fresh", stale: false, sourcesTried: ["api"] },
  };
}

function window(
  id: string,
  kind: QuotaWindow["kind"],
  percentRemaining: number,
  extra: Partial<QuotaWindow> = {},
): QuotaWindow {
  return {
    id,
    label: id,
    kind,
    percentUsed: 100 - percentRemaining,
    percentRemaining,
    ...extra,
  };
}

function weeklyResetsAt(elapsedFraction: number): string {
  const remainingSeconds = WEEK_SECONDS * (1 - elapsedFraction);
  return new Date(
    Date.parse(GENERATED_AT) + remainingSeconds * 1000,
  ).toISOString();
}

function offsetFromGeneratedAt(seconds: number): string {
  return new Date(Date.parse(GENERATED_AT) + seconds * 1000).toISOString();
}

const MONTH_SECONDS = 30 * 24 * 60 * 60;

/** Halfway through a five-hour cycle with 40% of the token budget left. */
function zaiSessionWindow(): QuotaWindow {
  return window("five_hour", "session", 40, {
    windowSeconds: 18_000,
    resetsAt: offsetFromGeneratedAt(9_000),
  });
}

/** Halfway through the weekly cycle with 30% of the token budget left. */
function zaiWeeklyWindow(): QuotaWindow {
  return window("weekly", "weekly", 30, {
    windowSeconds: WEEK_SECONDS,
    resetsAt: offsetFromGeneratedAt(WEEK_SECONDS / 2),
  });
}

/** A quarter into the MCP month with only 10% of the tool budget left. */
function zaiToolWindow(): QuotaWindow {
  return window("mcp_month", "monthly", 10, {
    startsAt: offsetFromGeneratedAt(-MONTH_SECONDS * 0.25),
    resetsAt: offsetFromGeneratedAt(MONTH_SECONDS * 0.75),
  });
}

describe("quota semantics", () => {
  it("keeps every stale provider's effective availability unknown", () => {
    const cases: Array<[ProviderQuota["provider"], QuotaWindow[]]> = [
      ["claude", [window("five_hour", "session", 66)]],
      ["codex", [window("weekly", "weekly", 38)]],
      ["grok", [window("credits", "credits", 44)]],
      ["kimi", [window("weekly", "weekly", 59)]],
      ["zai", [window("weekly", "weekly", 42)]],
      ["cursor", [window("included_usage", "monthly", 72)]],
      ["copilot", [window("premium_interactions", "monthly", 81)]],
    ];

    for (const [providerId, windows] of cases) {
      const stale = provider(providerId, windows);
      stale.state = {
        status: "stale",
        stale: true,
        refreshedAt: "2026-07-06T18:10:00Z",
        sourcesTried: ["api", "cache"],
      };

      const semantics = withQuotaSemantics(stale, GENERATED_AT).quotaSemantics;
      expect(semantics?.status, providerId).not.toBe("known");
      expect(
        semantics?.effectiveAvailability.every(
          (availability) =>
            availability.status === "unknown" &&
            availability.effectivePercentRemaining === undefined,
        ),
        providerId,
      ).toBe(true);
      expect(
        stale.windows.every(() => true) &&
          withQuotaSemantics(stale, GENERATED_AT).windows.every(
            (item) =>
              item.pace?.status === "unknown" && item.pace.reason === "stale",
          ),
        providerId,
      ).toBe(true);
    }
  });

  it("reports a model's effective headroom from its bounding account and model windows", () => {
    const result = withQuotaSemantics(
      provider("claude", [
        window("five_hour", "session", 91, {
          windowSeconds: 18_000,
          resetsAt: weeklyResetsAt(0.2),
        }),
        window("seven_day", "weekly", 3, {
          windowSeconds: WEEK_SECONDS,
          resetsAt: weeklyResetsAt(0.2),
        }),
        window("model:fable", "model", 19, {
          windowSeconds: WEEK_SECONDS,
          resetsAt: weeklyResetsAt(0.2),
        }),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics).toMatchObject({
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: 3,
          boundedBy: ["five_hour", "seven_day"],
          limitingWindowIds: ["seven_day"],
        },
        {
          scope: "model:fable",
          status: "known",
          effectivePercentRemaining: 3,
          boundedBy: ["five_hour", "seven_day", "model:fable"],
          limitingWindowIds: ["seven_day"],
        },
      ],
    });
    expect(
      result.windows.every((item) => item.pace?.status !== undefined),
    ).toBe(true);
  });

  it("does not block Claude effective runway when five_hour has not been triggered yet (no resetsAt)", () => {
    const result = withQuotaSemantics(
      provider("claude", [
        window("five_hour", "session", 100, {
          percentUsed: 0,
          windowSeconds: 18_000,
          // No resetsAt: the 5h clock has not started (first request not
          // yet made this window). This must not make runway `unknown`.
        }),
        window("seven_day", "weekly", 90, {
          windowSeconds: WEEK_SECONDS,
          resetsAt: weeklyResetsAt(0.5),
        }),
      ]),
      GENERATED_AT,
    );

    const allModels = result.quotaSemantics?.effectiveAvailability.find(
      (item) => item.scope === "all_models",
    );
    expect(allModels?.status).toBe("known");
    expect(allModels?.effectivePercentRemaining).toBe(90);
    expect(allModels?.runway?.status).not.toBe("unknown");
    expect(["through_reset", "projected_exhaustion"]).toContain(
      allModels?.runway?.status,
    );
    expect(allModels?.runway?.unmeasurableWindowIds).toBeUndefined();

    const fiveHour = result.windows.find((item) => item.id === "five_hour");
    expect(fiveHour?.pace).toEqual({
      status: "unknown",
      reason: "missing_cycle",
    });
  });

  it("surfaces pace on a non-currently-limiting bounding window that is ahead", () => {
    const result = withQuotaSemantics(
      provider("claude", [
        window("five_hour", "session", 80, {
          windowSeconds: 18_000,
          resetsAt: new Date(
            Date.parse(GENERATED_AT) + 9_000 * 1000,
          ).toISOString(),
        }),
        window("seven_day", "weekly", 40, {
          windowSeconds: WEEK_SECONDS,
          // 20% of the week elapsed, 60% used -> ahead, but not the lowest remaining
          resetsAt: weeklyResetsAt(0.2),
        }),
      ]),
      GENERATED_AT,
    );

    const allModels = result.quotaSemantics?.effectiveAvailability.find(
      (availability) => availability.scope === "all_models",
    );
    expect(allModels).toMatchObject({
      status: "known",
      effectivePercentRemaining: 40,
      limitingWindowIds: ["seven_day"],
      pace: {
        status: "mixed",
        aheadWindowIds: ["seven_day"],
        worstReserveWindowId: "seven_day",
      },
    });
    expect(allModels?.pace?.aheadWindowIds).toContain("seven_day");
    expect(allModels?.pace?.worstReservePercentPoints ?? 0).toBeLessThan(0);
    expect(
      result.windows.find((item) => item.id === "seven_day")?.pace?.status,
    ).toBe("ahead");
  });

  it("uses a model-specific bound when it projects earlier exhaustion than its account bounds", () => {
    const fiveHourResetsAt = new Date(
      Date.parse(GENERATED_AT) + 0.75 * 18_000 * 1000,
    ).toISOString();
    const result = withQuotaSemantics(
      provider("claude", [
        window("five_hour", "session", 90, {
          windowSeconds: 18_000,
          resetsAt: fiveHourResetsAt,
        }),
        window("seven_day", "weekly", 50, {
          windowSeconds: WEEK_SECONDS,
          resetsAt: weeklyResetsAt(0.25),
        }),
        window("model:fable", "model", 25, {
          windowSeconds: WEEK_SECONDS,
          resetsAt: weeklyResetsAt(0.25),
        }),
      ]),
      GENERATED_AT,
    );

    expect(
      result.quotaSemantics?.effectiveAvailability.find(
        ({ scope }) => scope === "model:fable",
      ),
    ).toMatchObject({
      status: "known",
      boundedBy: ["five_hour", "seven_day", "model:fable"],
      runway: {
        status: "projected_exhaustion",
        limitingWindowId: "model:fable",
        usableRunwaySeconds: 50_400,
        projectionConfidence: "established",
      },
    });
  });

  it("applies Codex base windows to named model windows", () => {
    const result = withQuotaSemantics(
      provider("codex", [
        window("weekly", "weekly", 38),
        window("code_review_five_hour", "session", 80),
        window("code_review_weekly", "weekly", 70),
        window("model:codex_bengalfox:7d", "model", 99),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.effectiveAvailability).toContainEqual(
      expect.objectContaining({
        scope: "code_review",
        status: "known",
        effectivePercentRemaining: 70,
        boundedBy: ["code_review_five_hour", "code_review_weekly"],
        limitingWindowIds: ["code_review_weekly"],
      }),
    );
    expect(result.quotaSemantics?.effectiveAvailability).toContainEqual(
      expect.objectContaining({
        scope: "model:codex_bengalfox",
        status: "known",
        effectivePercentRemaining: 38,
        boundedBy: ["weekly", "model:codex_bengalfox:7d"],
        limitingWindowIds: ["weekly"],
      }),
    );
  });

  it("marks unfamiliar Codex windows partial instead of ignoring them", () => {
    const result = withQuotaSemantics(
      provider("codex", [
        window("weekly", "weekly", 38),
        window("future_monthly", "monthly", 10),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics).toMatchObject({
      status: "partial",
      effectiveAvailability: [],
      unresolvedWindowIds: ["future_monthly"],
    });
  });

  it("computes all-model Kimi headroom from both account windows", () => {
    const result = withQuotaSemantics(
      provider("kimi", [
        window("weekly", "weekly", 59),
        window("five_hour", "session", 50),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.effectiveAvailability).toEqual([
      expect.objectContaining({
        scope: "all_models",
        status: "known",
        effectivePercentRemaining: 50,
        boundedBy: ["weekly", "five_hour"],
        limitingWindowIds: ["five_hour"],
        pace: expect.objectContaining({ status: "unknown" }),
      }),
    ]);
  });

  it("keeps valid Kimi bounds while marking unparsed limits partial", () => {
    const kimi = provider("kimi", [window("weekly", "weekly", 59)]);
    kimi.state.untrustedWindowIds = ["limit:2"];

    const result = withQuotaSemantics(kimi, GENERATED_AT);

    expect(result.quotaSemantics).toEqual({
      status: "partial",
      description:
        "Kimi's valid weekly and five-hour account windows are known bounds, but unrecognized or unparsed limits may add bounds, so effective remaining is unknown.",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "unknown",
          boundedBy: ["weekly"],
          pace: {
            status: "unknown",
            unknownWindowIds: ["weekly"],
          },
          runway: {
            status: "unknown",
            unmeasurableWindowIds: ["weekly", "limit:2"],
          },
          selection: {
            status: "unknown",
            unmeasurableWindowIds: ["weekly", "limit:2"],
          },
        },
      ],
      unresolvedWindowIds: ["limit:2"],
    });
  });

  it("reports Z.AI token and tool headroom as separate resources", () => {
    const result = withQuotaSemantics(
      provider("zai", [zaiSessionWindow(), zaiWeeklyWindow(), zaiToolWindow()]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.status).toBe("known");
    expect(result.quotaSemantics?.effectiveAvailability).toEqual([
      expect.objectContaining({
        scope: "all_models",
        status: "known",
        effectivePercentRemaining: 30,
        boundedBy: ["five_hour", "weekly"],
        limitingWindowIds: ["weekly"],
        pace: expect.objectContaining({
          status: "ahead",
          aheadWindowIds: ["five_hour", "weekly"],
          worstReserveWindowId: "weekly",
          worstReservePercentPoints: -20,
        }),
      }),
      expect.objectContaining({
        scope: "tools",
        status: "known",
        effectivePercentRemaining: 10,
        boundedBy: ["mcp_month"],
        limitingWindowIds: ["mcp_month"],
        pace: expect.objectContaining({
          status: "ahead",
          worstReserveWindowId: "mcp_month",
          worstReservePercentPoints: -65,
        }),
      }),
    ]);
  });

  it("keeps the Z.AI tool window out of the all-models bound when limits are unresolved", () => {
    const zai = provider("zai", [
      zaiSessionWindow(),
      zaiWeeklyWindow(),
      zaiToolWindow(),
      window("limit:3", "unknown", 50),
    ]);
    zai.state.untrustedWindowIds = ["limit:3", "limit:4"];

    const result = withQuotaSemantics(zai, GENERATED_AT);

    expect(result.quotaSemantics?.status).toBe("partial");
    expect(result.quotaSemantics?.unresolvedWindowIds).toEqual([
      "limit:3",
      "limit:4",
    ]);
    expect(result.quotaSemantics?.effectiveAvailability).toEqual([
      {
        scope: "all_models",
        status: "unknown",
        boundedBy: ["five_hour", "weekly"],
        pace: expect.objectContaining({
          status: "ahead",
          aheadWindowIds: ["five_hour", "weekly"],
          worstReserveWindowId: "weekly",
          worstReservePercentPoints: -20,
        }),
        runway: {
          status: "unknown",
          unmeasurableWindowIds: ["five_hour", "weekly", "limit:3", "limit:4"],
        },
        selection: {
          status: "unknown",
          unmeasurableWindowIds: ["five_hour", "weekly", "limit:3", "limit:4"],
        },
      },
      {
        scope: "tools",
        status: "unknown",
        boundedBy: ["mcp_month"],
        pace: expect.objectContaining({
          status: "ahead",
          worstReserveWindowId: "mcp_month",
          worstReservePercentPoints: -65,
        }),
        runway: {
          status: "unknown",
          unmeasurableWindowIds: ["mcp_month", "limit:3", "limit:4"],
        },
        selection: {
          status: "unknown",
          unmeasurableWindowIds: ["mcp_month", "limit:3", "limit:4"],
        },
      },
    ]);
  });

  it("applies Grok shared credits to product windows", () => {
    const result = withQuotaSemantics(
      provider("grok", [
        window("credits", "credits", 1),
        window("product:grok_build", "credits", 88),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.effectiveAvailability).toContainEqual(
      expect.objectContaining({
        scope: "product:grok_build",
        status: "known",
        effectivePercentRemaining: 1,
        boundedBy: ["credits", "product:grok_build"],
        limitingWindowIds: ["credits"],
      }),
    );
  });

  it("labels unknown and unfamiliar relationships instead of inventing an answer", () => {
    const copilot = withQuotaSemantics(
      provider("copilot", [window("premium_interactions", "monthly", 100)]),
      GENERATED_AT,
    );
    expect(copilot.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: ["premium_interactions"],
    });

    const kimi = withQuotaSemantics(
      provider("kimi", [
        window("weekly", "weekly", 59),
        window("limit:2", "unknown", 80),
      ]),
      GENERATED_AT,
    );
    expect(kimi.quotaSemantics).toMatchObject({
      status: "partial",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "unknown",
          boundedBy: ["weekly"],
        },
      ],
      unresolvedWindowIds: ["limit:2"],
    });
  });

  it("bounds Cursor by its lowest recognized window across all models", () => {
    const result = withQuotaSemantics(
      provider("cursor", [
        window("included_usage", "monthly", 58),
        window("auto_usage", "monthly", 88),
        window("api_usage", "monthly", 21),
        window("spend_limit", "credits", 40),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.status).toBe("known");
    expect(result.quotaSemantics?.unresolvedWindowIds).toBeUndefined();
    expect(result.quotaSemantics?.effectiveAvailability).toEqual([
      expect.objectContaining({
        scope: "all_models",
        status: "known",
        effectivePercentRemaining: 21,
        boundedBy: ["included_usage", "auto_usage", "api_usage", "spend_limit"],
        limitingWindowIds: ["api_usage"],
      }),
    ]);
  });

  it("bounds Cursor on the recognized windows it actually reports", () => {
    const result = withQuotaSemantics(
      provider("cursor", [
        window("included_usage", "monthly", 58),
        window("auto_usage", "monthly", 88),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
      scope: "all_models",
      status: "known",
      effectivePercentRemaining: 58,
      boundedBy: ["included_usage", "auto_usage"],
      limitingWindowIds: ["included_usage"],
    });
  });

  it("keeps an unfamiliar Cursor window unresolved and out of the bound", () => {
    const recognized = [
      window("included_usage", "monthly", 58),
      window("auto_usage", "monthly", 88),
      window("api_usage", "monthly", 21),
    ];
    const withoutUnfamiliar = withQuotaSemantics(
      provider("cursor", recognized),
      GENERATED_AT,
    );
    const result = withQuotaSemantics(
      provider("cursor", [
        ...recognized,
        window("mystery_limit", "unknown", 3),
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.status).toBe("partial");
    expect(result.quotaSemantics?.unresolvedWindowIds).toEqual([
      "mystery_limit",
    ]);
    // The unfamiliar window is the lowest of all, so folding it in would move
    // the bound; the recognized-only minimum must survive untouched.
    expect(result.quotaSemantics?.effectiveAvailability).toEqual(
      withoutUnfamiliar.quotaSemantics?.effectiveAvailability,
    );
    expect(
      result.quotaSemantics?.effectiveAvailability[0]
        ?.effectivePercentRemaining,
    ).toBe(21);
  });

  it("does not fabricate a Cursor bound from an unmeasured window", () => {
    const result = withQuotaSemantics(
      provider("cursor", [
        window("included_usage", "monthly", 58),
        {
          id: "spend_limit",
          label: "spend limit",
          kind: "credits",
          limitUsd: 20,
        },
      ]),
      GENERATED_AT,
    );

    expect(result.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
      scope: "all_models",
      status: "unknown",
      boundedBy: ["included_usage", "spend_limit"],
    });
    expect(result.quotaSemantics?.effectiveAvailability[0]).not.toHaveProperty(
      "effectivePercentRemaining",
    );
  });

  it("still fails Claude effective runway closed when a triggered window's reset already expired", () => {
    const result = withQuotaSemantics(
      provider("claude", [
        window("five_hour", "session", 91, {
          windowSeconds: 18_000,
          // Present but already in the past: a real, expired reset - unlike
          // an absent resetsAt this is genuine unmeasurability.
          resetsAt: new Date(Date.parse(GENERATED_AT) - 1_000).toISOString(),
        }),
        window("seven_day", "weekly", 90, {
          windowSeconds: WEEK_SECONDS,
          resetsAt: weeklyResetsAt(0.5),
        }),
      ]),
      GENERATED_AT,
    );

    const allModels = result.quotaSemantics?.effectiveAvailability.find(
      (item) => item.scope === "all_models",
    );
    expect(allModels?.runway).toEqual({
      status: "unknown",
      unmeasurableWindowIds: ["five_hour"],
    });
  });

  it("does not invent provider or model routing recommendations", () => {
    const result = withQuotaSemantics(
      provider("claude", [
        window("five_hour", "session", 10, {
          windowSeconds: 18_000,
          resetsAt: new Date(
            Date.parse(GENERATED_AT) + 3_600_000,
          ).toISOString(),
        }),
        window("seven_day", "weekly", 90, {
          windowSeconds: WEEK_SECONDS,
          resetsAt: weeklyResetsAt(0.1),
        }),
      ]),
      GENERATED_AT,
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/recommend|prefer|switch to|route to/i);
    expect(result.quotaSemantics?.description).not.toMatch(
      /recommend|prefer|switch|route/i,
    );
  });
});

describe("per-scope selection signal", () => {
  const HOUR_SECONDS = 3_600;
  const FIVE_HOURS_SECONDS = 18_000;
  const DAY_SECONDS = 86_400;

  function after(seconds: number): string {
    return new Date(Date.parse(GENERATED_AT) + seconds * 1000).toISOString();
  }

  function before(seconds: number): string {
    return after(-seconds);
  }

  function scopes(provider: ProviderQuota): Map<string, number | undefined> {
    const semantics = withQuotaSemantics(provider, GENERATED_AT).quotaSemantics;
    return new Map(
      (semantics?.effectiveAvailability ?? []).map((availability) => [
        availability.scope,
        availability.selection?.[SELECTION_SCALAR_KEY],
      ]),
    );
  }

  // Claude is under-consuming both account windows; Cursor is tracking its
  // billing cycle almost exactly; Codex is nearly empty and well ahead of pace.
  const claude = provider("claude", [
    window("five_hour", "session", 90, {
      windowSeconds: FIVE_HOURS_SECONDS,
      resetsAt: after(3 * HOUR_SECONDS),
    }),
    window("seven_day", "weekly", 80, {
      windowSeconds: WEEK_SECONDS,
      resetsAt: after(5 * DAY_SECONDS),
    }),
    window("model:fable", "model", 95, {
      windowSeconds: WEEK_SECONDS,
      resetsAt: after(5 * DAY_SECONDS),
    }),
  ]);
  const cursor = provider("cursor", [
    window("included_usage", "monthly", 35, {
      startsAt: before(20 * DAY_SECONDS),
      resetsAt: after(10 * DAY_SECONDS),
    }),
  ]);
  const codex = provider("codex", [
    window("five_hour", "session", 5, {
      windowSeconds: FIVE_HOURS_SECONDS,
      resetsAt: after(4 * HOUR_SECONDS),
    }),
    window("weekly", "weekly", 10, {
      windowSeconds: WEEK_SECONDS,
      resetsAt: after(6 * DAY_SECONDS),
    }),
  ]);

  it("scores an under-consuming subscription above a fully-utilized one", () => {
    const claudeAllModels = scopes(claude).get("all_models");
    const cursorAllModels = scopes(cursor).get("all_models");

    expect(claudeAllModels).toBeCloseTo(0.444, 3);
    expect(cursorAllModels).toBeCloseTo(0.075, 3);
    expect(claudeAllModels!).toBeGreaterThan(0);
    expect(claudeAllModels!).toBeGreaterThan(cursorAllModels!);
  });

  it("scores the least-consumed model scope highest within a provider", () => {
    const claudeScopes = scopes(claude);
    const fable = claudeScopes.get("model:fable");

    expect(fable).toBeCloseTo(0.794, 3);
    for (const [scope, value] of claudeScopes) {
      if (scope === "model:fable") continue;
      expect(fable!).toBeGreaterThan(value!);
    }
  });

  it("scores a near-empty provider that is ahead of pace negative", () => {
    const codexAllModels = scopes(codex).get("all_models");

    expect(codexAllModels).toBeCloseTo(-6.14, 2);
    expect(codexAllModels!).toBeLessThan(0);
    expect(codexAllModels!).toBeLessThan(scopes(cursor).get("all_models")!);
  });

  it("keeps every stale scope's selection unknown with its bounds named", () => {
    const stale: ProviderQuota = {
      ...claude,
      state: {
        status: "stale",
        stale: true,
        refreshedAt: "2026-07-06T18:10:00Z",
        sourcesTried: ["api"],
      },
    };

    for (const availability of withQuotaSemantics(stale, GENERATED_AT)
      .quotaSemantics!.effectiveAvailability) {
      expect(availability.selection).toEqual({
        status: "unknown",
        unmeasurableWindowIds: availability.boundedBy,
      });
    }
  });

  it("makes a scope unmeasurable when a bounding window has no known pace", () => {
    const missingCycle = provider("claude", [
      window("five_hour", "session", 90, {
        windowSeconds: FIVE_HOURS_SECONDS,
        resetsAt: after(3 * HOUR_SECONDS),
      }),
      window("seven_day", "weekly", 80),
    ]);

    expect(
      withQuotaSemantics(missingCycle, GENERATED_AT).quotaSemantics
        ?.effectiveAvailability[0]?.selection,
    ).toEqual({ status: "unknown", unmeasurableWindowIds: ["seven_day"] });
  });
});
