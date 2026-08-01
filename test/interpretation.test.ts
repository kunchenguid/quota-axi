import { describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../src/interpretation.js";
import type { ProviderQuota, QuotaWindow } from "../src/types.js";

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

describe("quota semantics", () => {
  it("keeps every stale provider's effective availability unknown", () => {
    const cases: Array<[ProviderQuota["provider"], QuotaWindow[]]> = [
      ["claude", [window("five_hour", "session", 66)]],
      ["codex", [window("weekly", "weekly", 38)]],
      ["grok", [window("credits", "credits", 44)]],
      ["kimi", [window("weekly", "weekly", 59)]],
      ["agy", [window("gemini_weekly", "weekly", 98)]],
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
        projectionBasis: "cycle_average",
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
        },
      ],
      unresolvedWindowIds: ["limit:2"],
    });
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
    const cursor = withQuotaSemantics(
      provider("cursor", [window("included_usage", "monthly", 100)]),
      GENERATED_AT,
    );
    expect(cursor.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: ["included_usage"],
    });

    const agy = withQuotaSemantics(
      provider("agy", [
        window("gemini_5h", "session", 100),
        window("gemini_weekly", "weekly", 98),
      ]),
      GENERATED_AT,
    );
    expect(agy.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: ["gemini_5h", "gemini_weekly"],
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
