import { describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../src/interpretation.js";
import type { ProviderQuota, QuotaWindow } from "../src/types.js";

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
): QuotaWindow {
  return {
    id,
    label: id,
    kind,
    percentUsed: 100 - percentRemaining,
    percentRemaining,
  };
}

describe("quota semantics", () => {
  it("reports a model's effective headroom from its bounding account and model windows", () => {
    const result = withQuotaSemantics(
      provider("claude", [
        window("five_hour", "session", 91),
        window("seven_day", "weekly", 3),
        window("model:fable", "model", 19),
      ]),
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
  });

  it("applies Codex base windows to named model windows", () => {
    const result = withQuotaSemantics(
      provider("codex", [
        window("weekly", "weekly", 38),
        window("code_review_five_hour", "session", 80),
        window("code_review_weekly", "weekly", 70),
        window("model:codex_bengalfox:7d", "model", 99),
      ]),
    );

    expect(result.quotaSemantics?.effectiveAvailability).toContainEqual({
      scope: "code_review",
      status: "known",
      effectivePercentRemaining: 70,
      boundedBy: ["code_review_five_hour", "code_review_weekly"],
      limitingWindowIds: ["code_review_weekly"],
    });
    expect(result.quotaSemantics?.effectiveAvailability).toContainEqual({
      scope: "model:codex_bengalfox",
      status: "known",
      effectivePercentRemaining: 38,
      boundedBy: ["weekly", "model:codex_bengalfox:7d"],
      limitingWindowIds: ["weekly"],
    });
  });

  it("marks unfamiliar Codex windows partial instead of ignoring them", () => {
    const result = withQuotaSemantics(
      provider("codex", [
        window("weekly", "weekly", 38),
        window("future_monthly", "monthly", 10),
      ]),
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
    );

    expect(result.quotaSemantics?.effectiveAvailability).toEqual([
      {
        scope: "all_models",
        status: "known",
        effectivePercentRemaining: 50,
        boundedBy: ["weekly", "five_hour"],
        limitingWindowIds: ["five_hour"],
      },
    ]);
  });

  it("keeps valid Kimi bounds while marking unparsed limits partial", () => {
    const kimi = provider("kimi", [window("weekly", "weekly", 59)]);
    kimi.state.untrustedWindowIds = ["limit:2"];

    const result = withQuotaSemantics(kimi);

    expect(result.quotaSemantics).toEqual({
      status: "partial",
      description:
        "Kimi's valid weekly and five-hour account windows are known bounds, but unrecognized or unparsed limits may add bounds, so effective remaining is unknown.",
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

  it("applies Grok shared credits to product windows", () => {
    const result = withQuotaSemantics(
      provider("grok", [
        window("credits", "credits", 1),
        window("product:grok_build", "credits", 88),
      ]),
    );

    expect(result.quotaSemantics?.effectiveAvailability).toContainEqual({
      scope: "product:grok_build",
      status: "known",
      effectivePercentRemaining: 1,
      boundedBy: ["credits", "product:grok_build"],
      limitingWindowIds: ["credits"],
    });
  });

  it("labels unknown and unfamiliar relationships instead of inventing an answer", () => {
    const cursor = withQuotaSemantics(
      provider("cursor", [window("included_usage", "monthly", 100)]),
    );
    expect(cursor.quotaSemantics).toMatchObject({
      status: "unknown",
      effectiveAvailability: [],
      unresolvedWindowIds: ["included_usage"],
    });

    const kimi = withQuotaSemantics(
      provider("kimi", [
        window("weekly", "weekly", 59),
        window("limit:2", "unknown", 80),
      ]),
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
});
