import { describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "../src/model-kb.js";
import {
  compareModelsByRunway,
  createModelsResponse,
  validateModelCatalog,
} from "../src/models.js";
import type {
  EffectiveRunway,
  ModelCatalog,
  ModelQuotaRecord,
  QuotaAxiResponse,
} from "../src/types.js";

const generatedAt = "2026-08-05T12:00:00.000Z";

describe("model catalog", () => {
  it("is a valid native-provider catalog with unique entries and coarse buckets", () => {
    expect(() => validateModelCatalog(MODEL_CATALOG)).not.toThrow();
    expect(
      new Set(MODEL_CATALOG.entries.map((entry) => entry.provider)),
    ).toEqual(new Set(["claude", "codex", "grok", "kimi"]));
    expect(
      new Set(MODEL_CATALOG.entries.map((entry) => entry.intelligence)),
    ).toEqual(new Set(["high", "medium", "low"]));
  });

  it("rejects malformed catalog data before it can be joined", () => {
    const invalid: ModelCatalog = {
      ...MODEL_CATALOG,
      version: "not-a-date",
      entries: [MODEL_CATALOG.entries[0]!, MODEL_CATALOG.entries[0]!],
    };
    expect(() => validateModelCatalog(invalid)).toThrow(
      "model catalog version must be an ISO calendar date",
    );
  });

  it("rejects calendar dates whose day overflows into another month", () => {
    expect(() =>
      validateModelCatalog({ ...MODEL_CATALOG, version: "2026-02-31" }),
    ).toThrow("model catalog version must be an ISO calendar date");
  });
});

describe("model quota join", () => {
  it("uses the specific scope when known, falls back to account evidence, and discloses unmapped windows", () => {
    const response = createModelsResponse(quotaResponse(), {
      catalog: testCatalog(),
    });

    expect(
      response.models.map((model) => `${model.provider}/${model.id}`),
    ).toEqual(["claude/account-only", "claude/scoped", "codex/codex-model"]);
    expect(response.models[0]).toMatchObject({
      quotaScopes: ["all_models"],
      effective: { scope: "all_models", effectivePercentRemaining: 70 },
    });
    expect(response.models[1]).toMatchObject({
      quotaScopes: ["model:fable"],
      effective: { scope: "model:fable", effectivePercentRemaining: 30 },
    });
    expect(response.models[2]).toMatchObject({
      quotaScopes: [],
      state: { status: "stale", stale: true },
    });
    expect(response.unmatchedWindowIds).toEqual(["claude/model:unmapped"]);
  });

  it("filters intelligence without inventing availability for failed providers", () => {
    const response = createModelsResponse(quotaResponse(), {
      catalog: testCatalog(),
      intelligence: "high",
    });

    expect(response.models).toHaveLength(1);
    expect(response.models[0]).toMatchObject({
      id: "scoped",
      intelligence: "high",
      quotaScopes: ["model:fable"],
    });
  });

  it("sorts runway evidence only and exposes equal evidence as ties", () => {
    const response = createModelsResponse(quotaResponseWithRunways(), {
      catalog: testCatalogWithRunways(),
      sort: "runway",
    });

    expect(response.models.map((model) => model.id)).toEqual([
      "longer",
      "same-a",
      "same-b",
      "reset",
      "empty",
      "unknown",
    ]);
    expect(response.sort).toEqual({
      key: "runway",
      tieGroups: [
        [
          { provider: "claude", id: "same-a" },
          { provider: "claude", id: "same-b" },
        ],
      ],
    });
  });

  it("exports a comparator that treats unknown evidence as last rather than zero", () => {
    expect(
      compareModelsByRunway(
        runwayRecord("unknown"),
        runwayRecord("finite", 10),
      ),
    ).toBeGreaterThan(0);
  });
});

function quotaResponse(): QuotaAxiResponse {
  return {
    generatedAt,
    schemaVersion: 5,
    providers: [
      {
        provider: "claude",
        label: "Claude",
        source: "oauth",
        windows: [
          { id: "five_hour", label: "session", kind: "session" },
          { id: "model:fable", label: "Fable", kind: "model" },
          { id: "model:unmapped:5h", label: "Unmapped 5h", kind: "model" },
          { id: "model:unmapped:7d", label: "Unmapped 7d", kind: "model" },
        ],
        quotaSemantics: {
          status: "known",
          description: "test",
          effectiveAvailability: [
            {
              scope: "all_models",
              status: "known",
              effectivePercentRemaining: 70,
              boundedBy: ["five_hour"],
              runway: { status: "through_reset" },
            },
            {
              scope: "model:fable",
              status: "known",
              effectivePercentRemaining: 30,
              boundedBy: ["five_hour", "model:fable"],
              runway: {
                status: "projected_exhaustion",
                usableRunwaySeconds: 100,
              },
            },
          ],
        },
        state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
      },
      {
        provider: "codex",
        label: "Codex",
        source: "cache",
        windows: [],
        quotaSemantics: {
          status: "unknown",
          description: "stale",
          effectiveAvailability: [],
        },
        state: { status: "stale", stale: true, sourcesTried: ["cache"] },
      },
    ],
  };
}

function testCatalog(): ModelCatalog {
  return {
    version: "2026-08-05",
    provenance: "test catalog",
    entries: [
      {
        provider: "claude",
        id: "scoped",
        label: "Scoped",
        intelligence: "high",
        windowIds: ["model:fable"],
      },
      {
        provider: "claude",
        id: "account-only",
        label: "Account only",
        intelligence: "medium",
      },
      {
        provider: "codex",
        id: "codex-model",
        label: "Codex model",
        intelligence: "low",
      },
    ],
  };
}

function testCatalogWithRunways(): ModelCatalog {
  const records = [
    ["longer", "high"],
    ["same-a", "high"],
    ["same-b", "high"],
    ["reset", "medium"],
    ["empty", "medium"],
    ["unknown", "low"],
  ] as const;
  return {
    version: "2026-08-05",
    provenance: "test catalog",
    entries: records.map(([id, intelligence]) => ({
      provider: "claude",
      id,
      label: id,
      intelligence,
      windowIds: [`model:${id}`],
    })),
  };
}

function quotaResponseWithRunways(): QuotaAxiResponse {
  const availability: Array<[string, EffectiveRunway]> = [
    ["longer", { status: "projected_exhaustion", usableRunwaySeconds: 100 }],
    ["same-a", { status: "projected_exhaustion", usableRunwaySeconds: 50 }],
    ["same-b", { status: "projected_exhaustion", usableRunwaySeconds: 50 }],
    ["reset", { status: "through_reset" }],
    ["empty", { status: "exhausted_now", usableRunwaySeconds: 0 }],
    ["unknown", { status: "unknown" }],
  ];
  return {
    generatedAt,
    schemaVersion: 5,
    providers: [
      {
        provider: "claude",
        label: "Claude",
        source: "oauth",
        windows: availability.map(([id]) => ({
          id: `model:${id}`,
          label: id,
          kind: "model" as const,
        })),
        quotaSemantics: {
          status: "known",
          description: "test",
          effectiveAvailability: availability.map(([id, runway]) => ({
            scope: `model:${id}`,
            status:
              runway.status === "unknown"
                ? ("unknown" as const)
                : ("known" as const),
            boundedBy: [`model:${id}`],
            runway,
          })),
        },
        state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
      },
    ],
  };
}

function runwayRecord(
  kind: "unknown" | "finite",
  usableRunwaySeconds?: number,
): ModelQuotaRecord {
  return {
    provider: "claude",
    id: kind,
    label: kind,
    intelligence: "high",
    quotaScopes: ["all_models"],
    effective:
      kind === "finite"
        ? {
            scope: "all_models",
            status: "known",
            boundedBy: [],
            runway: {
              status: "projected_exhaustion",
              usableRunwaySeconds,
            },
          }
        : { scope: "all_models", status: "unknown", boundedBy: [] },
    state: { status: "fresh", stale: false },
  };
}
