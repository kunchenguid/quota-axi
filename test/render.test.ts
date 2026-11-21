import { describe, expect, it } from "vitest";
import { quotaJsonReport, renderQuotaToon } from "../src/render.js";
import type { QuotaAxiResponse } from "../src/types.js";

const GENERATED_AT = "2026-11-20T00:00:00.000Z";
const ARGON = 99.64540004730225;
const GEMINI = 80.70518970489502;
const MONTHLY = 34.736000000000004;
const WHOLE = 48;

function response(): QuotaAxiResponse {
  return {
    generatedAt: GENERATED_AT,
    schemaVersion: 5,
    providers: [
      {
        provider: "agy",
        windows: [
          {
            id: "gemini_argon",
            label: "argon",
            kind: "weekly",
            percentRemaining: ARGON,
            pace: {
              status: "on_pace",
              timeRemainingPercent: 12.345678,
              reservePercentPoints: -1.2345,
              burnMultiple: 1.0102,
            },
          },
          {
            id: "gemini",
            label: "gemini",
            kind: "weekly",
            percentRemaining: GEMINI,
          },
        ],
        quotaSemantics: {
          status: "known",
          effectiveAvailability: [
            {
              scope: "gemini_argon",
              status: "known",
              effectivePercentRemaining: ARGON,
              boundedBy: ["gemini_argon"],
              limitingWindowIds: ["gemini_argon"],
              selection: { status: "known", spendPriority: -0.5102 },
              runway: {
                status: "projected_exhaustion",
                usableRunwaySeconds: 3661.125,
                limitingWindowId: "gemini_argon",
              },
            },
            {
              scope: "gemini",
              status: "known",
              effectivePercentRemaining: GEMINI,
              boundedBy: ["gemini"],
              selection: { status: "known", spendPriority: -0.5102 },
            },
          ],
        },
        state: { status: "fresh", stale: false },
      },
      {
        provider: "cursor",
        windows: [
          {
            id: "monthly",
            label: "month",
            kind: "monthly",
            percentRemaining: MONTHLY,
          },
        ],
        quotaSemantics: {
          status: "known",
          effectiveAvailability: [
            {
              scope: "all_models",
              status: "known",
              effectivePercentRemaining: MONTHLY,
              boundedBy: ["monthly"],
            },
          ],
        },
        state: { status: "fresh", stale: false },
      },
      {
        provider: "codex",
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentRemaining: WHOLE,
          },
          {
            id: "share",
            label: "share",
            kind: "unknown",
          },
        ],
        quotaSemantics: {
          status: "known",
          effectiveAvailability: [
            {
              scope: "all_models",
              status: "known",
              effectivePercentRemaining: WHOLE,
              boundedBy: ["weekly"],
            },
          ],
        },
        state: { status: "fresh", stale: false },
      },
    ],
  };
}

describe("percent-remaining output rounding", () => {
  it("rounds default TOON percent-remaining to at most two decimal places", () => {
    const source = response();
    const before = JSON.stringify(source);
    const toon = renderQuotaToon(source, "quota-axi", false);

    expect(toon).toContain("agy,gemini_argon,99.65,");
    expect(toon).toContain("agy,gemini,80.71,");
    expect(toon).toContain("cursor,all_models,34.74,");
    expect(toon).toContain("codex,all_models,48,");
    expect(toon).not.toContain("48.00");
    expect(toon).not.toContain(String(ARGON));
    expect(toon).not.toContain(String(GEMINI));
    expect(toon).not.toContain(String(MONTHLY));
    expect(toon).toContain("-0.5102");
    expect(toon).toContain("3661.125");
    expect(toon).not.toContain("windows[");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("rounds --full window percent-remaining and leaves pace and seconds exact", () => {
    const toon = renderQuotaToon(response(), "quota-axi", true);

    expect(toon).toContain("agy,gemini_argon,argon,99.65,");
    expect(toon).toContain("agy,gemini,gemini,80.71,");
    expect(toon).toContain("cursor,monthly,month,34.74,");
    expect(toon).toContain("codex,weekly,week,48,");
    expect(toon).toContain("codex,share,share,unknown,");
    expect(toon).toContain("12.345678");
    expect(toon).toContain("-1.2345");
    expect(toon).toContain("1.0102");
    expect(toon).toContain("3661.125");
    expect(toon).not.toContain(String(ARGON));
    expect(toon).not.toContain("48.00");
  });

  it.each([false, true])(
    "rounds --json percent-remaining as numbers when full is %s",
    (full) => {
      const source = response();
      const before = JSON.stringify(source);
      const json = quotaJsonReport(source, full);

      expect(json.schemaVersion).toBe(5);
      const agy = json.providers[0];
      const cursor = json.providers[1];
      const codex = json.providers[2];
      expect(
        agy?.quotaSemantics?.effectiveAvailability.map(
          (scope) => scope.effectivePercentRemaining,
        ),
      ).toEqual([99.65, 80.71]);
      expect(agy?.windows.map((window) => window.percentRemaining)).toEqual([
        99.65, 80.71,
      ]);
      expect(
        cursor?.quotaSemantics?.effectiveAvailability[0]
          ?.effectivePercentRemaining,
      ).toBe(34.74);
      expect(cursor?.windows[0]?.percentRemaining).toBe(34.74);
      expect(
        codex?.quotaSemantics?.effectiveAvailability[0]
          ?.effectivePercentRemaining,
      ).toBe(48);
      expect(codex?.windows.map((window) => window.percentRemaining)).toEqual([
        48,
        undefined,
      ]);
      expect(agy?.quotaSemantics?.effectiveAvailability[0]?.selection).toEqual({
        status: "known",
        spendPriority: -0.5102,
      });
      expect(
        agy?.quotaSemantics?.effectiveAvailability[0]?.runway
          ?.usableRunwaySeconds,
      ).toBe(3661.125);
      expect(agy?.windows[0]?.pace?.reservePercentPoints).toBe(-1.2345);
      expect(agy?.windows[0]?.pace?.burnMultiple).toBe(1.0102);
      if (full) {
        expect(agy?.windows[0]?.pace?.timeRemainingPercent).toBe(12.345678);
      } else {
        expect(agy?.windows[0]?.pace).not.toHaveProperty(
          "timeRemainingPercent",
        );
      }
      expect(JSON.stringify(json)).not.toMatch(/"(?:99\.65|80\.71|34\.74|48)"/);
      expect(JSON.stringify(json)).not.toContain(String(ARGON));
      expect(JSON.stringify(json)).not.toContain("48.00");
      expect(JSON.stringify(source)).toBe(before);
    },
  );
});
