import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeAccountAndLimits,
  normalizeCodexUsage,
} from "../../src/providers/codex.js";

const fixtureDir = join(import.meta.dirname, "..", "fixtures", "codex");

describe("Codex quota parsing", () => {
  it("normalizes snake-case OAuth usage responses", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-snake.json"), "utf8"),
    ) as unknown;
    const result = normalizeCodexUsage(raw);

    expect(result?.plan).toBe("plus");
    expect(result?.account).toMatchObject({
      email: "person@example.invalid",
      accountId: "acct_fixture",
    });
    expect(result?.credits).toEqual({
      remaining: 12,
      unlimited: false,
      unit: "credits",
    });
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        label: "session",
        percentUsed: 29,
        percentRemaining: 71,
        windowSeconds: 18000,
      },
      { id: "weekly", label: "week", percentUsed: 57, percentRemaining: 43 },
    ]);
  });

  it("normalizes camel-case OAuth usage responses", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-camel.json"), "utf8"),
    ) as unknown;
    const result = normalizeCodexUsage(raw);

    expect(result?.plan).toBe("team");
    expect(result?.account).toMatchObject({
      email: "person@example.invalid",
      accountId: "acct_fixture",
    });
    expect(result?.credits).toEqual({
      remaining: 5,
      unlimited: true,
      unit: "credits",
    });
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        label: "session",
        percentUsed: 10,
        percentRemaining: 90,
        resetsAt: "2026-07-06T21:45:00.000Z",
        windowSeconds: 18000,
      },
      { id: "weekly", label: "week", percentUsed: 90, percentRemaining: 10 },
    ]);
  });

  it("merges app-server account and rate limit RPC responses", () => {
    const merged = mergeAccountAndLimits(
      { account: { email: "person@example.invalid", planType: "pro" } },
      { rate_limit: { primary_window: { used_percent: 20 } } },
    );
    const result = normalizeCodexUsage(merged);

    expect(result?.plan).toBe("pro");
    expect(result?.account?.email).toBe("person@example.invalid");
    expect(result?.windows[0]).toMatchObject({
      id: "five_hour",
      percentRemaining: 80,
    });
  });

  it("classifies known base durations independently of slot and presence", () => {
    const cases = [
      {
        rateLimits: {
          primary: { usedPercent: 0, windowDurationMins: 10_080 },
          secondary: null,
        },
        ids: ["weekly"],
      },
      {
        rateLimits: {
          primary: null,
          secondary: { usedPercent: 20, windowDurationMins: 10_080 },
        },
        ids: ["weekly"],
      },
      {
        rateLimits: {
          primary: { usedPercent: 20, windowDurationMins: 10_080 },
          secondary: { usedPercent: 40, windowDurationMins: 300 },
        },
        ids: ["weekly", "five_hour"],
      },
    ];

    for (const { rateLimits, ids } of cases) {
      const result = normalizeCodexUsage({ rateLimits });
      expect(result?.windows.map(({ id }) => id)).toEqual(ids);
      expect(result?.windows).toEqual(
        expect.arrayContaining(
          ids.map((id) =>
            expect.objectContaining(
              id === "weekly"
                ? {
                    id,
                    label: "week",
                    kind: "weekly",
                    windowSeconds: 604_800,
                  }
                : {
                    id,
                    label: "session",
                    kind: "session",
                    windowSeconds: 18_000,
                  },
            ),
          ),
        ),
      );
    }
  });

  it("keeps cautious positional identities when duration is absent", () => {
    const result = normalizeCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 20 },
        secondary_window: { used_percent: 40 },
      },
    });

    expect(result?.windows).toMatchObject([
      { id: "five_hour", label: "session", kind: "session" },
      { id: "weekly", label: "week", kind: "weekly" },
    ]);
  });

  it("classifies named HTTP and RPC limits from exact duration", () => {
    const result = normalizeCodexUsage({
      additional_rate_limits: [
        {
          metered_feature: "codex_previewfeature",
          limit_name: "GPT-Preview-Spark",
          rate_limit: {
            primary_window: {
              used_percent: 33,
              limit_window_seconds: 604_800,
            },
          },
        },
      ],
      rateLimitsByLimitId: {
        codex_reviewfeature: {
          limitName: "GPT-Review",
          primary: { usedPercent: 10, windowDurationMins: 300 },
        },
      },
    });

    expect(result?.windows).toMatchObject([
      {
        id: "model:codex_previewfeature:7d",
        label: "GPT-Preview-Spark week",
        kind: "model",
        windowSeconds: 604_800,
      },
      {
        id: "model:codex_reviewfeature:5h",
        label: "GPT-Review session",
        kind: "model",
        windowSeconds: 18_000,
      },
    ]);
  });

  it("preserves unfamiliar periods honestly instead of thresholding them", () => {
    const result = normalizeCodexUsage({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 600_000,
        },
      },
    });

    expect(result?.windows[0]).toMatchObject({
      id: "window:166.67h",
      label: "166.67h window",
      kind: "unknown",
      windowSeconds: 600_000,
    });
  });

  it("uses the same duration classifier for code-review windows", () => {
    const result = normalizeCodexUsage({
      code_review_rate_limit: {
        primary: { usedPercent: 10, windowDurationMins: 10_080 },
        secondary: { usedPercent: 20, windowDurationMins: 300 },
      },
    });

    expect(result?.windows.map(({ id }) => id)).toEqual([
      "code_review_weekly",
      "code_review_five_hour",
    ]);
  });

  it("suffixes duplicate derived identities without dropping windows", () => {
    const result = normalizeCodexUsage({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 604_800,
        },
        secondary_window: {
          used_percent: 40,
          limit_window_seconds: 604_800,
        },
      },
    });

    expect(result?.windows.map(({ id }) => id)).toEqual(["weekly", "weekly_2"]);
  });

  it("surfaces code-review and additional per-feature windows from snake_case responses", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-additional-limits.json"), "utf8"),
    ) as unknown;
    const result = normalizeCodexUsage(raw);

    expect(result?.windows).toMatchObject([
      { id: "five_hour", label: "session", percentUsed: 15 },
      { id: "weekly", label: "week", percentUsed: 48 },
      {
        id: "code_review_five_hour",
        label: "code review session",
        percentUsed: 5,
      },
      {
        id: "code_review_weekly",
        label: "code review week",
        percentUsed: 12,
      },
      {
        id: "model:codex_previewfeature:5h",
        label: "GPT-Preview-Spark session",
        kind: "model",
        percentUsed: 33,
      },
      {
        id: "model:codex_previewfeature:7d",
        label: "GPT-Preview-Spark week",
        kind: "model",
        percentUsed: 70,
      },
    ]);
  });

  it("surfaces named per-model limits and nested credits from app-server RPC responses", () => {
    const merged = mergeAccountAndLimits(
      { account: { email: "person@example.invalid", planType: "pro" } },
      {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 18, windowDurationMins: 300 },
          secondary: { usedPercent: 52, windowDurationMins: 10080 },
          credits: { hasCredits: true, unlimited: false, balance: "3" },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            primary: { usedPercent: 18 },
            secondary: { usedPercent: 52 },
          },
          codex_previewfeature: {
            limitId: "codex_previewfeature",
            limitName: "GPT-Preview-Spark",
            primary: { usedPercent: 33 },
            secondary: { usedPercent: 70 },
          },
        },
      },
    );
    const result = normalizeCodexUsage(merged);

    expect(result?.credits).toEqual({
      remaining: 3,
      unlimited: false,
      unit: "credits",
    });
    expect(result?.windows).toMatchObject([
      { id: "five_hour", percentUsed: 18 },
      { id: "weekly", label: "week", percentUsed: 52 },
      {
        id: "model:codex_previewfeature:5h",
        label: "GPT-Preview-Spark session",
        kind: "model",
        percentUsed: 33,
      },
      {
        id: "model:codex_previewfeature:7d",
        label: "GPT-Preview-Spark week",
        kind: "model",
        percentUsed: 70,
      },
    ]);
  });
});
