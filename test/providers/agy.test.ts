import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentUserProcessListArgs,
  type ExecFileTextOptions,
} from "../../src/lib/process.js";
import {
  readCachedProvider,
  readSnapshotProviders,
  writeCachedProviders,
} from "../../src/cache.js";
import { cacheFilePath } from "../../src/lib/fs.js";
import { annotateQuotaAdvice } from "../../src/advice.js";
import { quotaJsonReport, renderQuotaToon } from "../../src/render.js";
import {
  agyAdapter,
  fetchQuota,
  fetchQuotaWithRuntime,
  inspectAuthWithRuntime,
  normalizeAgyPrintUsage,
  normalizeAgyQuotaSummary,
  normalizeAgyUserStatus,
  portsFromLsof,
  processInfosFromPs,
  requestLoopbackJson,
  type AgyConnectionEndpoint,
  type AgyProbeRuntime,
} from "../../src/providers/agy.js";
import { providerPresence } from "../../src/lib/source-attempts.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { AGY_GROUPS, type ProviderQuota } from "../../src/types.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalPath = process.env.PATH;
const originalWorkingDirectory = process.cwd();
let tempDir: string | undefined;
const servers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
  useTempCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  process.chdir(originalWorkingDirectory);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

// The vendor names each bucket's window ("5h" or "weekly"), which fixes its
// cycle length; quota-axi derives pace from that length plus resetsAt.
const EXPECTED_WINDOW_SECONDS = [
  ["gemini_5h", 18_000],
  ["gemini_weekly", 604_800],
  ["claude_gpt_5h", 18_000],
  ["claude_gpt_weekly", 604_800],
];

describe("Antigravity quota parsing", () => {
  it("normalizes quota summary groups into session and weekly windows", () => {
    const result = normalizeAgyQuotaSummary(fixture("quota-summary.json"));

    expect(result?.windows).toMatchObject([
      {
        id: "gemini_5h",
        label: "Gemini 5-hour",
        kind: "session",
        percentUsed: 9,
        percentRemaining: 91,
        resetsAt: "2026-06-15T11:39:34.000Z",
      },
      {
        id: "gemini_weekly",
        label: "Gemini weekly",
        kind: "weekly",
        percentUsed: 18,
        percentRemaining: 82,
        resetsAt: "2026-06-19T08:45:39.000Z",
      },
      {
        id: "claude_gpt_5h",
        label: "Claude/GPT 5-hour",
        kind: "session",
        percentUsed: 27,
        percentRemaining: 73,
        resetsAt: "2026-06-15T12:52:10.000Z",
      },
      {
        id: "claude_gpt_weekly",
        label: "Claude/GPT weekly",
        kind: "weekly",
        percentUsed: 36,
        percentRemaining: 64,
        resetsAt: "2026-06-20T00:39:54.000Z",
      },
    ]);
    expect(
      result?.windows.map(({ id, windowSeconds }) => [id, windowSeconds]),
    ).toEqual(EXPECTED_WINDOW_SECONDS);
  });

  it("normalizes the Antigravity CLI 1.2.2 quota summary shape", () => {
    const result = normalizeAgyQuotaSummary(
      fixture("quota-summary-v1.2.2.json"),
    );

    expect(result?.windows).toMatchObject([
      { id: "gemini_5h", kind: "session", percentRemaining: 88 },
      { id: "gemini_weekly", kind: "weekly", percentRemaining: 76 },
      { id: "claude_gpt_5h", kind: "session", percentRemaining: 64 },
      { id: "claude_gpt_weekly", kind: "weekly", percentRemaining: 52 },
    ]);
  });

  it("normalizes the exact Antigravity CLI 1.2.2 print envelope", () => {
    const result = normalizeAgyPrintUsage(fixture("usage-print-v1.2.2.json"));

    expect(result?.windows).toMatchObject([
      { id: "gemini_5h", kind: "session", percentRemaining: 88 },
      { id: "gemini_weekly", kind: "weekly", percentRemaining: 76 },
      { id: "claude_gpt_5h", kind: "session", percentRemaining: 64 },
      { id: "claude_gpt_weekly", kind: "weekly", percentRemaining: 52 },
    ]);
  });

  it.each(["window", "bucketId", "bucket_id", "displayName", "name"])(
    "leaves unfamiliar cycles in %s unmeasured",
    (field) => {
      for (const label of [
        "biweekly",
        "bi-weekly",
        "bi_weekly",
        "weekend",
        "15h",
        "five-day",
        "five-hourly",
      ]) {
        for (const groupName of ["Gemini Models", "Claude and GPT Models"]) {
          const result = normalizeAgyQuotaSummary({
            groups: [
              {
                displayName: groupName,
                buckets: [
                  {
                    [field === "bucket_id" ? "bucket_id" : "bucketId"]:
                      "unfamiliar",
                    [field]: label,
                    remainingFraction: 0.9,
                    resetTime: "2026-06-19T00:00:00.000Z",
                  },
                ],
              },
            ],
          });
          expect(result?.windows).toHaveLength(1);
          expect(result?.windows[0]?.kind).toBe("unknown");
          expect(result?.windows[0]?.windowSeconds).toBeUndefined();
        }
      }
    },
  );

  it("normalizes oneof remaining values", () => {
    const result = normalizeAgyQuotaSummary({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit",
              remaining: { case: "remainingFraction", value: 0.5 },
            },
          ],
        },
      ],
    });

    expect(result?.windows[0]).toMatchObject({
      id: "gemini_weekly",
      percentUsed: 50,
      percentRemaining: 50,
    });
    expect(result?.windows[0]?.windowSeconds).toBe(604_800);
  });

  it("normalizes the agy CLI /quota print envelope", () => {
    const result = normalizeAgyPrintUsage(fixture("cli-quota.json"));

    expect(result?.windows.map(({ id }) => id)).toEqual([
      "gemini_weekly",
      "claude_gpt_5h",
      "claude_gpt_weekly",
    ]);
    expect(result?.windows).toMatchObject([
      {
        id: "gemini_weekly",
        percentRemaining: 0,
      },
      {
        id: "claude_gpt_5h",
        percentRemaining: 100,
      },
      {
        id: "claude_gpt_weekly",
        percentRemaining: 90,
      },
    ]);
    expect(
      result?.windows.map(({ id, windowSeconds }) => [id, windowSeconds]),
    ).toEqual([
      ["gemini_weekly", 604_800],
      ["claude_gpt_5h", 18_000],
      ["claude_gpt_weekly", 604_800],
    ]);
  });

  describe("unused limits, groups and models (real /quota output)", () => {
    // Captured 2026-11-22T06:20:29Z. agy reported "now plus period" resets for
    // the Gemini and Argon limits and the Unix epoch for Claude and GPT.
    const NOW_MS = Date.parse("2026-11-22T06:20:29Z");
    const CATALOG = [
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
      "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
      "gemini-4-neon-low\tGemini 4 Neon (Low)",
      "gemini-4-neon-preview\tGemini 4 Neon (Low)",
      "gemini-4-neon-medium-alias-high\tGemini 4 Neon (Medium)",
      "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
      "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
      "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
      "gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
      "claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n");

    function windowById(
      windows: ReturnType<typeof normalizeAgyPrintUsage> & object,
      id: string,
    ) {
      const found = windows.windows.find((window) => window.id === id);
      expect(found, id).toBeDefined();
      return found!;
    }

    it("keeps 100% and drops the placeholder reset for unused limits", () => {
      const result = normalizeAgyPrintUsage(fixture("cli-quota-unused.json"), {
        nowMs: NOW_MS,
      })!;

      expect(result.windows.map(({ id }) => id)).toEqual([
        "gemini_5h",
        "gemini_weekly",
        "gemini_argon_weekly",
        "claude_gpt_5h",
        "claude_gpt_weekly",
      ]);
      for (const window of result.windows) {
        expect(window.percentRemaining).toBe(100);
        expect(window.notStarted).toBe(true);
        expect(window.resetsAt).toBeUndefined();
      }
    });

    it("reports not-started pace and a known scope for unused limits", () => {
      const fetched = normalizeAgyPrintUsage(fixture("cli-quota-unused.json"), {
        nowMs: NOW_MS,
      })!;
      const result = withQuotaSemantics(
        {
          provider: "agy",
          label: "Antigravity",
          source: "cli",
          ...fetched,
          state: { status: "fresh", stale: false, sourcesTried: ["cli"] },
        },
        new Date(NOW_MS).toISOString(),
      );

      expect(result.state.status).toBe("fresh");
      expect(result.windows.map(({ pace }) => pace)).toEqual(
        Array(5).fill({ status: "unknown", reason: "not_started" }),
      );
      expect(result.quotaSemantics?.status).toBe("known");
      expect(
        result.quotaSemantics?.effectiveAvailability.map(
          ({ scope, status, effectivePercentRemaining }) => [
            scope,
            status,
            effectivePercentRemaining,
          ],
        ),
      ).toEqual([
        ["gemini", "known", 100],
        ["gemini_argon", "known", 100],
        ["claude_gpt", "known", 100],
      ]);
    });

    it("gives Argon its own scope and keeps unknown groups as their own scope", () => {
      const raw = JSON.parse(
        JSON.stringify(fixture("cli-quota-unused.json")),
      ) as { command: { data: { groups: unknown[] } } };
      raw.command.data.groups.push({
        name: "Claude Enterprise",
        description: "Models within this group: Claude Enterprise",
        buckets: [
          {
            id: "enterprise-monthly",
            window: "monthly",
            remaining_fraction: 0.5,
            reset_time: "2026-11-25T00:00:00Z",
          },
        ],
      });
      const result = normalizeAgyPrintUsage(raw, { nowMs: NOW_MS })!;
      const enterprise = windowById(
        result,
        "group:Claude%20Enterprise:bucket:enterprise-monthly",
      );
      expect(enterprise).toMatchObject({
        kind: "unknown",
        percentRemaining: 50,
        resetsAt: "2026-11-25T00:00:00.000Z",
      });
      expect(enterprise.windowSeconds).toBeUndefined();
      const semantics = withQuotaSemantics(
        {
          provider: "agy",
          label: "Antigravity",
          source: "cli",
          ...result,
          state: { status: "fresh", stale: false, sourcesTried: ["cli"] },
        },
        new Date(NOW_MS).toISOString(),
      ).quotaSemantics;
      expect(semantics).toMatchObject({
        status: "partial",
        unresolvedWindowIds: [enterprise.id],
      });
      expect(semantics?.effectiveAvailability.at(-1)).toMatchObject({
        scope: "group:Claude%20Enterprise",
        status: "unknown",
        boundedBy: [],
        models: { status: "known", labels: ["Claude Enterprise"] },
      });
      expect(
        semantics?.effectiveAvailability.map(
          ({ scope, effectivePercentRemaining }) => [
            scope,
            effectivePercentRemaining,
          ],
        ),
      ).toEqual([
        ["gemini", 100],
        ["gemini_argon", 100],
        ["claude_gpt", 100],
        ["group:Claude%20Enterprise", undefined],
      ]);
    });

    it("keeps a synthetic used limit's real reset and pace", () => {
      const raw = JSON.parse(
        JSON.stringify(fixture("cli-quota-unused.json")),
      ) as {
        command: {
          data: {
            groups: Array<{
              buckets: Array<{
                id: string;
                remaining_fraction: number;
                reset_time: string;
              }>;
            }>;
          };
        };
      };
      const weekly = raw.command.data.groups[0]!.buckets[0]!;
      weekly.remaining_fraction = 0.62;
      weekly.reset_time = "2026-11-26T03:00:00Z";
      const fetched = normalizeAgyPrintUsage(raw, { nowMs: NOW_MS })!;

      expect(windowById(fetched, "gemini_weekly")).toMatchObject({
        percentRemaining: 62,
        resetsAt: "2026-11-26T03:00:00.000Z",
      });
      expect(windowById(fetched, "gemini_weekly").notStarted).toBeUndefined();
      expect(windowById(fetched, "gemini_5h").notStarted).toBe(true);

      const result = withQuotaSemantics(
        {
          provider: "agy",
          label: "Antigravity",
          source: "cli",
          ...fetched,
          state: { status: "fresh", stale: false, sourcesTried: ["cli"] },
        },
        new Date(NOW_MS).toISOString(),
      );
      expect(
        windowById({ ...fetched, windows: result.windows }, "gemini_weekly")
          .pace?.status,
      ).toBe("behind");
      expect(result.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
        scope: "gemini",
        status: "known",
        effectivePercentRemaining: 62,
      });
    });

    it.each([
      [0.999, "2026-11-29T06:19:29.000Z"],
      [0.999, "1970-01-01T00:00:00.000Z"],
      [0.9, "1970-01-01T00:00:00.000Z"],
      [1, "1969-12-31T23:59:59.000Z"],
    ])("keeps the reset for synthetic fraction %s at %s", (fraction, reset) => {
      const raw = JSON.parse(
        JSON.stringify(fixture("cli-quota-unused.json")),
      ) as {
        command: {
          data: {
            groups: Array<{
              buckets: Array<{
                remaining_fraction: number;
                reset_time: string;
              }>;
            }>;
          };
        };
      };
      const weekly = raw.command.data.groups[1]!.buckets[0]!;
      weekly.remaining_fraction = fraction;
      weekly.reset_time = reset;
      const result = normalizeAgyPrintUsage(raw, { nowMs: NOW_MS })!;
      const used = windowById(result, "claude_gpt_weekly");
      expect(used.resetsAt).toBe(reset);
      expect(used.notStarted).toBeUndefined();
    });

    it("lists each group's models and matches them to agy model ids", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW_MS);
      const fetched = await fetchQuotaWithRuntime(
        runtimeWith({
          cliQuota: JSON.stringify(fixture("cli-quota-unused.json")),
          cliModels: CATALOG,
        }),
      );
      const scopes = withQuotaSemantics(fetched, new Date(NOW_MS).toISOString())
        .quotaSemantics?.effectiveAvailability;
      const modelsFor = (scope: string) =>
        scopes?.find((entry) => entry.scope === scope)?.models;

      expect(modelsFor("gemini")).toEqual({
        status: "known",
        labels: [
          "Gemini 4 Neon",
          "Gemini 4 Hydrogen",
          "Orchestrator (Neon)",
          "Gemini 3.8 Flash",
        ],
        ids: [
          "gemini-4-neon-high",
          "gemini-4-neon-xhigh",
          "gemini-4-neon-medium",
          "gemini-4-neon-low",
          "gemini-4-hydrogen-medium",
          "gemini-pro-orchestrator-neon",
          "gemini-3.8-flash-medium",
        ],
      });
      expect(modelsFor("claude_gpt")).toMatchObject({
        status: "known",
        ids: [
          "claude-opus-5-5-low",
          "claude-sonnet-5-5-high",
          "gpt-oss-120b-medium",
        ],
      });
      // Argon's description is plan advice, not a model list.
      expect(modelsFor("gemini_argon")).toEqual({
        status: "unknown",
      });
    });

    it.each(["cli", "cli-rpc"] as const)(
      "keeps fresh %s quota when the model catalog times out",
      async (source) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW_MS);
        const onExec = vi.fn();
        const fetched = await fetchQuotaWithRuntime(
          runtimeWith({
            cliModels: Object.assign(new Error("agy models timed out"), {
              code: "ETIMEDOUT",
            }),
            onExec,
            ...(source === "cli"
              ? { cliQuota: JSON.stringify(fixture("cli-quota-unused.json")) }
              : {
                  cliQuota: "{}",
                  ps: "123 /Users/test/.local/bin/agy\n",
                  lsof: lsofFor(123, 64440),
                  responses: {
                    "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
                      fixture("quota-summary.json"),
                  },
                }),
          }),
        );
        expect(
          onExec.mock.calls.filter(([, args]) => args[0] === "models"),
        ).toHaveLength(1);
        expect(fetched).toMatchObject({
          source,
          state: { status: "fresh", stale: false },
        });
        const result = withQuotaSemantics(
          fetched,
          source === "cli"
            ? new Date(NOW_MS).toISOString()
            : "2026-06-15T09:00:00Z",
        );
        expect(result.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
          scope: "gemini",
          status: "known",
          effectivePercentRemaining: source === "cli" ? 100 : 82,
        });
        expect(result.quotaSemantics?.effectiveAvailability[0]?.models).toEqual(
          {
            status: "known",
            labels:
              source === "cli"
                ? [
                    "Gemini 4 Neon",
                    "Gemini 4 Hydrogen",
                    "Orchestrator (Neon)",
                    "Gemini 3.8 Flash",
                  ]
                : ["Gemini Flash", "Gemini Pro"],
          },
        );
      },
    );

    it("carries the model list onto the scope", () => {
      const fetched = normalizeAgyPrintUsage(fixture("cli-quota-unused.json"), {
        nowMs: NOW_MS,
      })!;
      const scopes = withQuotaSemantics(
        {
          provider: "agy",
          label: "Antigravity",
          source: "cli",
          ...fetched,
          state: { status: "fresh", stale: false, sourcesTried: ["cli"] },
        },
        new Date(NOW_MS).toISOString(),
      ).quotaSemantics?.effectiveAvailability;
      expect(
        scopes?.map(({ scope, models }) => [scope, models?.status]),
      ).toEqual([
        ["gemini", "known"],
        ["gemini_argon", "unknown"],
        ["claude_gpt", "known"],
      ]);
    });

    it("reports unused CLI quota when the vendor names no models", async () => {
      const cliQuota = JSON.stringify({
        command: {
          name: "quota",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    window: "weekly",
                    remaining_fraction: 1,
                    reset_time: 0,
                  },
                ],
              },
            ],
          },
        },
      });
      const onExec = vi.fn();
      const fetched = await fetchQuotaWithRuntime(
        runtimeWith({ cliQuota, onExec }),
      );
      expect(fetched.source).toBe("cli");
      expect(fetched.windows).toMatchObject([
        { id: "gemini_weekly", percentRemaining: 100, notStarted: true },
      ]);
      const result = withQuotaSemantics(
        fetched,
        new Date(NOW_MS).toISOString(),
      );
      expect(result.quotaSemantics?.effectiveAvailability).toMatchObject([
        {
          scope: "gemini",
          status: "known",
          effectivePercentRemaining: 100,
          models: { status: "unknown" },
        },
      ]);
      expect(onExec.mock.calls.map(([, args]) => args[0])).toEqual(["-p"]);
    });

    const disabledArgonGroup = {
      displayName: "Gemini 4 Argon",
      description: "Models within this group: Gemini 4 Argon",
      buckets: [
        {
          bucketId: "argon-weekly",
          window: "weekly",
          disabled: true,
          remainingFraction: 0.5,
        },
      ],
    };

    it.each([
      ["cli", false],
      ["cli-rpc", false],
      ["cli", true],
      ["cli-rpc", true],
    ] as const)(
      "keeps a disabled Argon group in %s quota and snapshots (group only: %s)",
      async (source, groupOnly) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW_MS);
        const groups = [disabledArgonGroup];
        if (!groupOnly)
          groups.unshift({
            displayName: "Gemini Models",
            description: "General quota",
            buckets: [
              {
                bucketId: "gemini-weekly",
                window: "weekly",
                disabled: false,
                remainingFraction: 0.8,
              },
            ],
          });
        const fresh = await fetchQuotaWithRuntime(
          runtimeWith({
            cliModels: "gemini-4-argon-high\tGemini 4 Argon (High)",
            ...(source === "cli-rpc"
              ? {
                  cliQuota: "{}",
                  ps: "123 /Users/test/.local/bin/agy\n",
                  lsof: lsofFor(123, 64440),
                  responses: {
                    "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
                      { groups },
                  },
                }
              : {
                  cliQuota: JSON.stringify({
                    command: { name: "quota", data: { groups } },
                  }),
                }),
          }),
        );
        expect(fresh).toMatchObject({
          source,
          state: { status: "fresh" },
        });
        writeCachedProviders([fresh]);
        expect(readCachedProvider("agy")?.[AGY_GROUPS]?.at(-1)).toEqual({
          id: "gemini_argon",
          name: "Gemini 4 Argon",
          models: {
            status: "known",
            labels: ["Gemini 4 Argon"],
            ids: ["gemini-4-argon-high"],
          },
          buckets: [{ id: "argon-weekly" }],
        });
        const snapshot = readSnapshotProviders(cacheFilePath(), "agy", NOW_MS);
        if (!Array.isArray(snapshot) || !snapshot[0])
          throw new Error("Expected an Antigravity snapshot");
        for (const reading of [fresh, snapshot[0]]) {
          const generatedAt = new Date(NOW_MS).toISOString();
          const report = annotateQuotaAdvice({
            generatedAt,
            providers: [withQuotaSemantics(reading, generatedAt)],
          });
          const json = quotaJsonReport(report, true).providers[0];
          expect(json?.windows.map(({ id }) => id)).toEqual(
            groupOnly ? [] : ["gemini_weekly"],
          );
          const argon = json?.quotaSemantics?.effectiveAvailability.find(
            ({ scope }) => scope === "gemini_argon",
          );
          expect(argon).toMatchObject({
            status: "unknown",
            boundedBy: [],
            models: { ids: ["gemini-4-argon-high"] },
          });
          expect(argon?.effectivePercentRemaining).toBeUndefined();
          for (const full of [false, true]) {
            expect(renderQuotaToon(report, "quota-axi", full)).toContain(
              "agy,gemini_argon,gemini-4-argon-high",
            );
          }
        }
      },
    );

    it.each(["CLI", "user status", "model configs", "later port"] as const)(
      "keeps Argon membership and finds fallback model quota after a group-only %s response",
      async (path) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.parse("2026-06-15T09:00:00Z"));
        const groups = [disabledArgonGroup];
        const rpc = "/exa.language_server_pb.LanguageServerService/";
        const result = await fetchQuotaWithRuntime(
          runtimeWith({
            cliQuota:
              path === "CLI"
                ? JSON.stringify({
                    command: { name: "quota", data: { groups } },
                  })
                : "{}",
            cliModels: "gemini-4-argon-high\tGemini 4 Argon (High)",
            ps: "123 /Users/test/.local/bin/agy\n",
            lsof:
              lsofFor(123, 64440) +
              (path === "later port" ? lsofFor(123, 64441) : ""),
            responses: {
              [`https:64440:${rpc}RetrieveUserQuotaSummary`]: {
                groups: path === "CLI" ? [] : groups,
              },
              [`https:${path === "later port" ? 64441 : 64440}:${rpc}${path === "model configs" ? "GetCommandModelConfigs" : "GetUserStatus"}`]:
                fixture("user-status.json"),
            },
          }),
        );
        expect(result).toMatchObject({
          source: "cli-rpc",
          state: { status: "fresh" },
        });
        expect(result.windows).toMatchObject([
          { id: "model:model_fixture_gemini_flash", percentRemaining: 100 },
          { id: "model:model_fixture_claude_sonnet", percentRemaining: 50 },
        ]);
        expect(
          withQuotaSemantics(result, new Date().toISOString()).quotaSemantics
            ?.effectiveAvailability,
        ).toMatchObject([
          {
            scope: "gemini_argon",
            status: "unknown",
            boundedBy: [],
            models: { ids: ["gemini-4-argon-high"] },
          },
        ]);
      },
    );

    it("drops stale windows at report time without losing group membership", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW_MS);
      const cached = cachedAgyQuota();
      const fresh = await fetchQuotaWithRuntime(
        runtimeWith({
          cliQuota: JSON.stringify(fixture("cli-quota-unused.json")),
          cliModels: "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
        }),
      );
      expect(
        fresh.windows.filter(({ id }) => id.startsWith("gemini_argon_")),
      ).toMatchObject([{ id: "gemini_argon_weekly" }]);
      cached[AGY_GROUPS] = fresh[AGY_GROUPS];
      cached.windows = fresh.windows.map((window) => ({
        ...window,
        percentUsed: 12,
        percentRemaining: 88,
        notStarted: undefined,
        resetsAt: new Date(
          NOW_MS +
            (window.id === "gemini_weekly"
              ? 3_600_000
              : window.id === "gemini_argon_weekly"
                ? 1_000
                : -60_000),
        ).toISOString(),
      }));
      writeCachedProviders([cached]);
      const onExec = vi.fn();
      const runtime = runtimeWith({
        agyPath: "agy",
        ps: "",
        onExec,
        cliQuota: Object.assign(new Error("agy timed out"), {
          code: "ETIMEDOUT",
        }),
      });
      const result = await fetchQuotaWithRuntime(runtime);
      expect(result.state.status).toBe("stale");
      expect(result.windows).toMatchObject([
        { id: "gemini_weekly", percentRemaining: 88 },
        { id: "gemini_argon_weekly", percentRemaining: 88 },
      ]);
      expect(onExec.mock.calls.map(([, args]) => args[0])).not.toContain(
        "models",
      );
      vi.setSystemTime(NOW_MS + 2_000);
      const generatedAt = new Date().toISOString();
      const report = annotateQuotaAdvice({
        generatedAt,
        providers: [withQuotaSemantics(result, generatedAt)],
      });
      const json = quotaJsonReport(report, false).providers[0];
      expect(json?.windows.map(({ id }) => id)).toEqual(["gemini_weekly"]);
      expect(quotaJsonReport(report, true).providers[0]?.windows).toMatchObject(
        [{ id: "gemini_weekly", percentRemaining: 88 }],
      );
      const scopes = json?.quotaSemantics?.effectiveAvailability;
      expect(scopes?.[0]).toMatchObject({
        scope: "gemini",
        status: "unknown",
        models: {
          status: "known",
          labels: [
            "Gemini 4 Neon",
            "Gemini 4 Hydrogen",
            "Orchestrator (Neon)",
            "Gemini 3.8 Flash",
          ],
        },
      });
      expect(scopes?.slice(1)).toMatchObject([
        {
          scope: "gemini_argon",
          status: "unknown",
          boundedBy: [],
          models: { status: "unknown" },
        },
        {
          scope: "claude_gpt",
          status: "unknown",
          boundedBy: [],
          models: {
            status: "known",
            ids: ["claude-opus-5-5-low"],
            unmatchedLabels: ["Claude Sonnet 5.5", "GPT-OSS 120B"],
          },
        },
      ]);
      expect(
        scopes?.map(
          ({ effectivePercentRemaining }) => effectivePercentRemaining,
        ),
      ).toEqual([undefined, undefined, undefined]);
      for (const full of [false, true]) {
        const toon = renderQuotaToon(report, "quota-axi", full);
        expect(toon).not.toContain("gemini_argon_weekly");
        expect(toon).toContain("agy,gemini_argon,unknown");
        expect(toon).toContain(
          "agy,claude_gpt,claude-opus-5-5-low + Claude Sonnet 5.5 + GPT-OSS 120B",
        );
      }

      vi.setSystemTime(NOW_MS + 3_600_000);
      const expired = await fetchQuotaWithRuntime(runtime);
      expect(expired.state).toMatchObject({
        status: "unavailable",
        stale: false,
      });
      expect(expired.windows).toEqual([]);
      const expiredAt = new Date().toISOString();
      const noStaleFallback = withQuotaSemantics(expired, expiredAt);
      expect(noStaleFallback.quotaSemantics?.effectiveAvailability).toEqual([]);
      expect(withQuotaSemantics(result, expiredAt)).toEqual(noStaleFallback);
    });
  });

  it("falls back to model windows from user status payloads", () => {
    const result = normalizeAgyUserStatus(fixture("user-status.json"));

    expect(result?.plan).toBe("Google AI Pro");
    expect(result?.account?.email).toBe("person@example.invalid");
    expect(result?.windows).toMatchObject([
      {
        id: "model:model_fixture_gemini_flash",
        label: "Gemini 3.5 Flash (Medium)",
        kind: "model",
        percentRemaining: 100,
      },
      {
        id: "model:model_fixture_claude_sonnet",
        label: "Claude Sonnet Fixture",
        kind: "model",
        percentRemaining: 50,
      },
    ]);
  });

  it("distinguishes exact and rounded full model resets at the epoch", () => {
    const result = normalizeAgyUserStatus({
      clientModelConfigs: [
        {
          label: "Atlas",
          quotaInfo: { remainingFraction: 0.999, resetTime: 0 },
        },
        { label: "Beacon", quotaInfo: { remainingFraction: 1, resetTime: 0 } },
      ],
    });
    expect(result?.windows).toMatchObject([
      {
        id: "model:atlas",
        percentRemaining: 100,
        resetsAt: "1970-01-01T00:00:00.000Z",
      },
      { id: "model:beacon", percentRemaining: 100, notStarted: true },
    ]);
    expect(result?.windows[0]?.notStarted).toBeUndefined();
    expect(result?.windows[1]?.resetsAt).toBeUndefined();
  });

  it("parses Antigravity processes and listening ports without matching prompt text", () => {
    const processes = processInfosFromPs(`
      101 /Users/test/.local/bin/agy
      102 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token token --extension_server_port 64123
      103 /usr/bin/node /opt/antigravity-cli/mcp-server.cjs --port 64124
      104 codex --prompt "antigravity-cli mcp-server.cjs language_server"
      105 /usr/bin/node /opt/runner.cjs --prompt "/opt/antigravity-cli/mcp-server.cjs"
      106 /usr/bin/codex --prompt "/Applications/Antigravity.app/Contents/bin/language_server --csrf_token fake"
      108 /usr/bin/node /Applications/Antigravity IDE.app/Contents/bin/language_server_macos_arm --csrf_token fake
    `);

    expect(processes).toMatchObject([
      { pid: 101, source: "agy" },
      {
        pid: 102,
        source: "app",
        csrfToken: "token",
        extensionPort: 64123,
      },
      { pid: 103, source: "agy" },
    ]);
    expect(
      portsFromLsof(`
COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
agy 101 test 8u IPv4 0x1 0t0 TCP 127.0.0.1:64440 (LISTEN)
agy 101 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64441 (LISTEN)
`),
    ).toEqual([64440, 64441]);
  });

  it("recognizes the Antigravity IDE app bundle when its name contains spaces", () => {
    const processes = processInfosFromPs(`
      107 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token ide-token --extension_server_port 56512
    `);

    expect(processes).toMatchObject([
      {
        pid: 107,
        source: "app",
        csrfToken: "ide-token",
        extensionPort: 56512,
      },
    ]);
  });
});

describe("Antigravity provider", () => {
  it("fetches quota from an already-running loopback endpoint and merges identity", async () => {
    const runtime = runtimeWith({
      ps: "123 /Users/test/.local/bin/agy\n",
      lsof: lsofFor(123, 64440),
      responses: {
        "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
          fixture("quota-summary.json"),
        "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
          fixture("user-status.json"),
      },
    });

    const result = await fetchQuotaWithRuntime(runtime);

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("cli-rpc");
    expect(result.plan).toBe("Google AI Pro");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(result.windows.map((window) => window.id)).toEqual([
      "gemini_5h",
      "gemini_weekly",
      "claude_gpt_5h",
      "claude_gpt_weekly",
    ]);
  });

  it("resolves loopback model labels after a failed CLI read", async () => {
    const onExec = vi.fn();
    const fetched = await fetchQuotaWithRuntime(
      runtimeWith({
        cliQuota: "{}",
        cliModels:
          "gemini-flash-low\tGemini Flash (Low)\ngemini-flash-high\tGemini Flash (High)\ngemini-pro-low\tGemini Pro (Medium)",
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, 64440),
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            fixture("quota-summary.json"),
        },
        onExec,
      }),
    );
    expect(fetched.source).toBe("cli-rpc");
    expect(
      onExec.mock.calls.filter(([, args]) => args[0] === "models"),
    ).toHaveLength(1);
    const result = withQuotaSemantics(fetched, "2026-06-15T09:00:00Z");
    expect(result.quotaSemantics?.effectiveAvailability[0]?.models).toEqual({
      status: "known",
      labels: ["Gemini Flash", "Gemini Pro"],
      ids: ["gemini-flash-low", "gemini-flash-high"],
      unmatchedLabels: ["Gemini Pro"],
    });
  });

  it("skips the model catalog when a usable CLI quota names no models", async () => {
    const onExec = vi.fn();
    const fetched = await fetchQuotaWithRuntime(
      runtimeWith({
        cliQuota: JSON.stringify(fixture("cli-quota.json")),
        onExec,
      }),
    );
    expect(fetched.state.status).toBe("fresh");
    expect(onExec.mock.calls.map(([, args]) => args[0])).toEqual(["-p"]);
  });

  it("probes app language-server endpoints with CSRF before quota requests", async () => {
    const calls: Array<{ endpoint: AgyConnectionEndpoint; path: string }> = [];
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token token --extension_server_port 64123 --extension_server_csrf_token extension-token\n",
        lsof: lsofFor(123, 64440),
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUnleashData":
            {},
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            fixture("quota-summary.json"),
        },
        onRequest(endpoint, path) {
          calls.push({ endpoint, path });
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(calls[0]?.path).toBe(
      "/exa.language_server_pb.LanguageServerService/GetUnleashData",
    );
    expect(calls[0]?.endpoint).toMatchObject({
      csrfToken: "token",
      requiresCsrfToken: true,
      requiresUnleashProbe: true,
    });
    expect(calls.every((call) => call.endpoint.port !== 64123)).toBe(true);
  });

  it("uses an extension port only when the app process owns its listener", async () => {
    const calls: AgyConnectionEndpoint[] = [];
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token main-token --extension_server_port 64123 --extension_server_csrf_token extension-token\n",
        lsof: `${lsofFor(123, 64440)}agy 123 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64123 (LISTEN)\n`,
        requestJson: async (endpoint, path) => {
          calls.push(endpoint);
          if (
            endpoint.port === 64123 &&
            endpoint.csrfToken === "extension-token"
          ) {
            if (path.endsWith("GetUnleashData")) return {};
            if (path.endsWith("RetrieveUserQuotaSummary"))
              return fixture("quota-summary.json");
          }
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(calls).toContainEqual(
      expect.objectContaining({
        port: 64123,
        csrfToken: "extension-token",
      }),
    );
  });

  it("reports unavailable without trying HTTP when Antigravity is not running", async () => {
    const requestJson = vi.fn();
    const result = await fetchQuotaWithRuntime(
      runtimeWith({ ps: "", lsof: "", requestJson }),
    );

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("Antigravity/agy is not running");
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("reports unavailable when discovered loopback endpoints are absent", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, 64440),
        requestJson: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:64440");
        },
      }),
    );

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("connect ECONNREFUSED 127.0.0.1:64440");
  });

  it("preserves sanitized process and port discovery failures", async () => {
    const processResult = await fetchQuotaWithRuntime(
      runtimeWith({ psError: new Error("ps failed at /Users/private") }),
    );
    const portResult = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsofError: new Error("lsof denied for private-host"),
      }),
    );

    expect(processResult.state).toMatchObject({
      status: "error",
      error: "Antigravity process discovery failed",
    });
    expect(portResult.state).toMatchObject({
      status: "error",
      error: "Antigravity port discovery failed",
    });
  });

  it("preserves sanitized discovery failures during auth inspection", async () => {
    const processResult = await inspectAuthWithRuntime(
      runtimeWith({ psError: new Error("ps failed at /Users/private") }),
    );
    const portResult = await inspectAuthWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsofError: new Error("lsof denied for private-host"),
      }),
    );

    expect(processResult.sources).toEqual([
      {
        source: "loopback",
        status: "error",
        error: "Antigravity process discovery failed",
      },
    ]);
    expect(portResult.sources).toEqual([
      {
        source: "loopback",
        status: "error",
        error: "Antigravity port discovery failed",
      },
    ]);
  });

  it("continues discovery when another verified process has listening ports", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n124 /Users/test/.local/bin/agy\n",
        lsofByPid: {
          123: new Error("permission denied"),
          124: lsofFor(124, 64441),
        },
        responses: {
          "https:64441:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            fixture("quota-summary.json"),
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
  });

  it("falls back to model quotas when the quota summary has no named groups", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, 64440),
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            fixture("user-status.json"),
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(result.windows.map((window) => window.id)).toEqual([
      "model:model_fixture_gemini_flash",
      "model:model_fixture_claude_sonnet",
    ]);
  });

  it("continues past a malformed endpoint to a later valid port", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: `${lsofFor(123, 64440)}agy 123 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64441 (LISTEN)\n`,
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs":
            { response: { groups: [] } },
          "https:64441:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            fixture("quota-summary.json"),
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(result.windows[0]?.id).toBe("gemini_5h");
  });

  it("bounds probing across all discovered endpoints", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const resultPromise = fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: `${lsofFor(123, 64440)}agy 123 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64441 (LISTEN)\n`,
        requestJson: async (endpoint, path) => {
          calls.push(`${endpoint.scheme}:${endpoint.port}:${path}`);
          return new Promise<never>(() => undefined);
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("Antigravity probe timed out");
    expect(calls).toHaveLength(4);
    vi.useRealTimers();
  });

  it("reports malformed loopback responses as errors", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, 64440),
        responses: {
          "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            { response: { groups: [] } },
          "https:64440:/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs":
            { response: { groups: [] } },
          "http:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
            { response: { groups: [] } },
          "http:64440:/exa.language_server_pb.LanguageServerService/GetUserStatus":
            { response: { groups: [] } },
          "http:64440:/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs":
            { response: { groups: [] } },
        },
      }),
    );

    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("Antigravity quota summary malformed");
  });

  it.skipIf(process.platform === "win32")(
    "does not serve cached quota when Antigravity is uninstalled",
    async () => {
      writeCachedProviders([cachedAgyQuota()]);

      const result = await fetchQuotaWithRuntime(runtimeWith({ ps: "" }));

      expect(result.state.status).toBe("unavailable");
      expect(result.state.error).toBe("Antigravity/agy is not running");
      expect(result.source).not.toBe("cache");
      expect(providerPresence(result, agyAdapter)).toBe("absent");
      expect(readCachedProvider("agy")).toBeUndefined();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "keeps cached quota when Windows cannot confirm Antigravity absence",
    async () => {
      const runtime = runtimeWith({ ps: "" });
      const withoutCache = await fetchQuotaWithRuntime(runtime);

      expect(providerPresence(withoutCache, agyAdapter)).toBe("absent");

      writeCachedProviders([cachedAgyQuota()]);
      const result = await fetchQuotaWithRuntime(runtime);

      expect(result.state.status).toBe("stale");
      expect(result.source).toBe("cache");
      expect(providerPresence(result, agyAdapter)).toBe("stale");
      expect(readCachedProvider("agy")).toBeDefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports attention and preserves cache when agy process is running but has no accessible port",
    async () => {
      const runtime = runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: "",
        cliQuota: Object.assign(new Error("agy missing"), { code: "ENOENT" }),
      });
      const withoutCache = await fetchQuotaWithRuntime(runtime);

      expect(providerPresence(withoutCache, agyAdapter)).toBe("attention");

      writeCachedProviders([cachedAgyQuota()]);
      const result = await fetchQuotaWithRuntime(runtime);

      expect(result.state.status).toBe("stale");
      expect(result.source).toBe("cache");
      expect(readCachedProvider("agy")).toBeDefined();
    },
  );

  it("preserves cache when language-server process is running without a CSRF token", async () => {
    writeCachedProviders([cachedAgyQuota()]);
    const port = 64440;

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: `123 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server\n`,
        lsofByPid: { 123: lsofFor(123, port) },
        cliQuota: Object.assign(new Error("agy missing"), { code: "ENOENT" }),
      }),
    );

    expect(result.state.status).toBe("stale");
    expect(result.source).toBe("cache");
    expect(readCachedProvider("agy")).toBeDefined();
  });

  it("preserves authentication failures and retires stale cache", async () => {
    writeCachedProviders([cachedAgyQuota()]);
    const port = await startServer((_response) => {
      _response.writeHead(401, { "content-type": "application/json" });
      _response.end(JSON.stringify({ error: "secret-account@example.test" }));
    });

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, port),
        requestJson: requestLoopbackJson,
      }),
    );

    expect(result.state).toMatchObject({
      status: "auth_required",
      error: "Antigravity sign-in required",
    });
    expect(JSON.stringify(result)).not.toContain("secret-account");
    expect(readCachedProvider("agy")).toBeUndefined();
  });

  it("prefers agy CLI /quota over loopback when both are available", async () => {
    writeCachedProviders([cachedAgyQuota()]);
    const commands: Array<{
      command: string;
      args: string[];
      timeoutMs: number;
      path?: string;
    }> = [];
    let loopbackCalled = false;
    const port = await startServer((response) => {
      loopbackCalled = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(fixture("quota-summary-v1.2.2.json")));
    });

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, port),
        agyPath: "/Users/test/.local/bin/agy",
        agyOutput: JSON.stringify(fixture("usage-print-v1.2.2.json")),
        requestJson: requestLoopbackJson,
        onExec(command, args, timeoutMs, options) {
          commands.push({
            command,
            args,
            timeoutMs,
            path: options?.env?.PATH,
          });
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("cli");
    expect(result.account).toBeUndefined();
    expect(result.windows.map((window) => window.id)).toEqual([
      "gemini_5h",
      "gemini_weekly",
      "claude_gpt_5h",
      "claude_gpt_weekly",
    ]);
    const quotaCommand = commands.find(({ args }) => args[0] === "-p");
    expect(quotaCommand).toMatchObject({
      command: "/Users/test/.local/bin/agy",
      args: ["-p", "/quota", "--output-format", "json"],
      timeoutMs: 15_000,
    });
    expect(quotaCommand?.path?.split(delimiter).slice(1).join(delimiter)).toBe(
      process.env.PATH ?? "",
    );
    expect(loopbackCalled).toBe(false);
  });

  it.skipIf(process.platform === "win32").each([
    ["xdg-open", "inherited PATH"],
    ["xdg-open", "working directory"],
    ["open", "inherited PATH"],
    ["open", "working directory"],
  ] as const)(
    "prevents a signed-out agy quota probe from invoking %s in the %s",
    async (opener, openerLocation) => {
      const bin = join(tempDir as string, "bin");
      const workingDirectory = join(tempDir as string, "working");
      const marker = join(tempDir as string, "browser-opened");
      mkdirSync(bin);
      mkdirSync(workingDirectory);
      writeFileSync(
        join(bin, "agy"),
        `#!/bin/sh
${opener} 'https://accounts.example.invalid/oauth'
exit 1
`,
      );
      const openerDirectory =
        openerLocation === "inherited PATH" ? bin : workingDirectory;
      writeFileSync(
        join(openerDirectory, opener),
        `#!/bin/sh
printf opened > '${marker}'
`,
      );
      chmodSync(join(bin, "agy"), 0o700);
      chmodSync(join(openerDirectory, opener), 0o700);
      process.env.PATH = bin;
      process.chdir(workingDirectory);

      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state).toMatchObject({
        status: "error",
        error: "Antigravity CLI /quota failed",
      });
      expect(existsSync(marker)).toBe(false);
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each([
      "#!/usr/bin/env node",
      "#!/usr/bin/env -S node --enable-source-maps",
      ...(existsSync("/bin/env") ? ["#!/bin/env node"] : []),
    ])(
    "runs an authenticated agy CLI with the %s shebang when PATH has no node",
    async (shebang) => {
      const bin = join(tempDir as string, "bin");
      const payload = JSON.stringify(fixture("usage-print-v1.2.2.json"));
      mkdirSync(bin);
      writeFileSync(
        join(bin, "agy"),
        `${shebang}
process.stdout.write(${JSON.stringify(payload)});
`,
      );
      chmodSync(join(bin, "agy"), 0o700);
      process.env.PATH = bin;

      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state.status).toBe("fresh");
      expect(result.source).toBe("cli");
      expect(result.windows.map((window) => window.id)).toEqual([
        "gemini_5h",
        "gemini_weekly",
        "claude_gpt_5h",
        "claude_gpt_weekly",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves runtime lookup in an authenticated shell launcher",
    async () => {
      const bin = join(tempDir as string, "bin");
      const script = join(bin, "agy-cli.js");
      const payload = JSON.stringify(fixture("usage-print-v1.2.2.json"));
      mkdirSync(bin);
      writeFileSync(
        join(bin, "agy"),
        `#!/bin/sh
exec node "$0-cli.js" "$@"
`,
      );
      writeFileSync(
        script,
        `process.stdout.write(${JSON.stringify(payload)});
`,
      );
      chmodSync(join(bin, "agy"), 0o700);
      process.env.PATH = bin;

      const result = await fetchQuota({
        allowKeychainPrompt: false,
        refreshCredentials: false,
      });

      expect(result.state.status).toBe("fresh");
      expect(result.source).toBe("cli");
    },
  );

  it("does not serve stale quota when protected loopback and print usage fail", async () => {
    writeCachedProviders([cachedAgyQuota()]);
    const port = await startServer((response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: "unauthenticated",
          message: "missing CSRF token",
        }),
      );
    });

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, port),
        requestJson: requestLoopbackJson,
      }),
    );

    expect(result.state).toMatchObject({
      status: "unavailable",
      error:
        "Antigravity CLI quota unavailable because its runtime CSRF token is not exposed; use Antigravity /quota",
    });
    expect(result.windows).toEqual([]);
    expect(readCachedProvider("agy")).toBeDefined();
  });

  it("sanitizes failures from agy CLI /quota", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "",
        agyPath: "/Users/test/.local/bin/agy",
        agyError: Object.assign(new Error("private-account@example.test"), {
          code: "EFAIL",
        }),
      }),
    );

    expect(result.state).toMatchObject({
      status: "error",
      error: "Antigravity CLI /quota failed",
    });
    expect(JSON.stringify(result)).not.toContain("private-account");
  });

  it("sends the CLI 1.2.2 read-only request envelope without a token", async () => {
    let receivedBody: unknown;
    let receivedCsrfToken: string | undefined;
    const port = await startServer((response, request) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url?.endsWith("RetrieveUserQuotaSummary")) {
          receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          receivedCsrfToken = request.headers["x-codeium-csrf-token"] as
            | string
            | undefined;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(fixture("quota-summary-v1.2.2.json")));
      });
    });

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, port),
        requestJson: requestLoopbackJson,
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(receivedBody).toEqual({ request: {}, forceRefresh: false });
    expect(receivedCsrfToken).toBeUndefined();
  });

  it("preserves rate limits over protocol failures", async () => {
    const port = await startServer((response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "private diagnostic" }));
    });

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "123 /Users/test/.local/bin/agy\n",
        lsof: lsofFor(123, port),
        requestJson: requestLoopbackJson,
      }),
    );

    expect(result.state).toMatchObject({
      status: "rate_limited",
      error: "Antigravity quota endpoint rate limited",
    });
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });

  it("terminates trickling and oversized loopback responses", async () => {
    const tricklePort = await startServer((response) => {
      const interval = setInterval(() => response.write(" "), 5);
      response.on("close", () => clearInterval(interval));
    });
    const trickleRequest = requestLoopbackJson(
      endpointAt(tricklePort),
      "/quota",
      50,
    );

    await expect(trickleRequest).rejects.toThrow(
      "Antigravity loopback timed out",
    );

    const oversizedPort = await startServer((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`"${"x".repeat(1024 * 1024)}"`);
    });

    await expect(
      requestLoopbackJson(endpointAt(oversizedPort), "/quota", 1_000),
    ).rejects.toThrow("Antigravity loopback response too large");
  });

  it("does not launch agy when loopback quota succeeds", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runtime = runtimeWith({
      ps: "123 /Users/test/.local/bin/agy\n",
      lsof: lsofFor(123, 64440),
      responses: {
        "https:64440:/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary":
          fixture("quota-summary.json"),
      },
      onExec(command, args) {
        commands.push({ command, args });
      },
    });

    const result = await fetchQuotaWithRuntime(runtime);

    expect(result.state.status).toBe("fresh");
    expect(commands).toEqual([
      {
        command: "ps",
        args: currentUserProcessListArgs(process.geteuid() as number),
      },
      {
        command: "lsof",
        args: ["-nP", "-a", "-p", "123", "-iTCP", "-sTCP:LISTEN"],
      },
    ]);
    expect(commands.map((call) => call.command)).not.toContain("agy");
  });

  it("reads agy CLI /quota when loopback is down", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "",
        cliQuota: JSON.stringify(fixture("cli-quota.json")),
        onExec(command, args) {
          commands.push({ command, args });
        },
      }),
    );

    expect(result.state.status).toBe("fresh");
    expect(result.source).toBe("cli");
    expect(result.windows.map(({ id }) => id)).toEqual([
      "gemini_weekly",
      "claude_gpt_5h",
      "claude_gpt_weekly",
    ]);
    expect(result.attempts).toEqual([{ source: "cli", status: "success" }]);
    expect(commands).toContainEqual({
      command: "agy",
      args: ["-p", "/quota", "--output-format", "json"],
    });
  });

  it("surfaces a genuine CLI failure over the skipped loopback error", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "",
        cliQuota: "not json",
      }),
    );

    expect(result.state).toMatchObject({
      status: "error",
      error: "agy /quota returned invalid JSON",
    });
    expect(result.attempts).toEqual([
      {
        source: "cli",
        status: "failed",
        error: "agy /quota returned invalid JSON",
        degraded: false,
      },
      {
        source: "loopback",
        status: "skipped",
        error: "Antigravity/agy is not running",
        degraded: false,
      },
    ]);
  });

  it("keeps stale cache for an installed but stopped Antigravity CLI", async () => {
    writeCachedProviders([cachedAgyQuota()]);

    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "",
        agyPath: "/Users/test/.local/bin/agy",
        cliQuota: Object.assign(new Error("agy timed out"), {
          code: "ETIMEDOUT",
        }),
      }),
    );

    expect(result.state.status).toBe("stale");
    expect(result.source).toBe("cache");
    expect(result.windows[0]).toMatchObject({
      id: "gemini_5h",
      percentRemaining: 88,
    });
    expect(readCachedProvider("agy")).toBeDefined();
  });

  it("does not treat a missing agy CLI as remaining quota", async () => {
    const result = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "",
        cliQuota: Object.assign(new Error("agy missing"), { code: "ENOENT" }),
      }),
    );

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("Antigravity/agy is not running");
    expect(result.attempts).toEqual([
      {
        source: "cli",
        status: "skipped",
        error: "agy CLI is not installed",
        degraded: false,
      },
      {
        source: "loopback",
        status: "skipped",
        error: "Antigravity/agy is not running",
        degraded: false,
      },
    ]);
  });

  it("keeps the Gemini 4 Argon bucket out of the Gemini bound", async () => {
    const nowIso = "2026-10-20T00:00:00.000Z";
    const fetched = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "",
        cliQuota: JSON.stringify(fixture("cli-quota-argon.json")),
      }),
    );
    expect(fetched.state.status).toBe("fresh");
    expect(fetched.windows.map(({ id }) => id)).toEqual([
      "gemini_weekly",
      "gemini_argon_weekly",
      "claude_gpt_weekly",
    ]);

    const result = withQuotaSemantics(fetched, nowIso);

    expect(result.quotaSemantics?.status).toBe("known");
    expect(result.quotaSemantics?.unresolvedWindowIds).toBeUndefined();
    expect(result.quotaSemantics?.effectiveAvailability).toMatchObject([
      {
        scope: "gemini",
        boundedBy: ["gemini_weekly"],
        effectivePercentRemaining: 99,
      },
      {
        scope: "gemini_argon",
        boundedBy: ["gemini_argon_weekly"],
      },
      {
        scope: "claude_gpt",
        boundedBy: ["claude_gpt_weekly"],
        effectivePercentRemaining: 90,
      },
    ]);
  });

  it("does not mark the whole reading stale when one limit's reset has passed", async () => {
    const nowIso = "2026-09-15T12:00:00.000Z";
    const pastReset = new Date(Date.parse(nowIso) - 60_000).toISOString();
    const quotaData = fixture("cli-quota.json") as {
      command: {
        data: {
          groups: Array<{ buckets: Array<{ reset_time?: string }> }>;
        };
      };
    };
    const modified = JSON.parse(JSON.stringify(quotaData));
    modified.command.data.groups[0].buckets[0].reset_time = pastReset;

    const fetched = await fetchQuotaWithRuntime(
      runtimeWith({
        ps: "",
        cliQuota: JSON.stringify(modified),
      }),
    );
    expect(fetched.state.status).toBe("fresh");

    const result = withQuotaSemantics(fetched, nowIso);

    expect(result.state.status).toBe("fresh");
    expect(result.state.stale).toBeFalsy();
    const scopes = result.quotaSemantics?.effectiveAvailability ?? [];
    expect(scopes.find(({ scope }) => scope === "gemini")?.status).toBe(
      "unknown",
    );
  });
});

function runtimeWith(options: {
  agyPath?: string;
  agyOutput?: string;
  agyError?: Error;
  ps?: string;
  lsof?: string;
  psError?: Error;
  lsofError?: Error;
  lsofByPid?: Record<number, string | Error>;
  cliQuota?: string | Error;
  cliModels?: string | Error;
  requestJson?: AgyProbeRuntime["requestJson"];
  responses?: Record<string, unknown>;
  onExec?: (
    command: string,
    args: string[],
    timeoutMs: number,
    options?: ExecFileTextOptions,
  ) => void;
  onRequest?: (endpoint: AgyConnectionEndpoint, path: string) => void;
}): AgyProbeRuntime {
  return {
    async findCommandPath(command) {
      if (command !== "agy") throw new Error(`unexpected command: ${command}`);
      return (
        options.agyPath ?? (options.cliQuota !== undefined ? "agy" : undefined)
      );
    },
    async execFileText(command, args, timeoutMs, execOptions) {
      options.onExec?.(command, args, timeoutMs, execOptions);
      if (command === "ps") {
        if (options.psError) throw options.psError;
        return options.ps ?? "";
      }
      if (command === "lsof") {
        if (options.lsofError) throw options.lsofError;
        const pid = Number(args[args.indexOf("-p") + 1]);
        const output = options.lsofByPid?.[pid];
        if (output instanceof Error) throw output;
        return output ?? options.lsof ?? "";
      }
      if (
        command === "agy" ||
        (options.agyPath && command === options.agyPath)
      ) {
        if (args[0] === "models") {
          if (options.cliModels instanceof Error) throw options.cliModels;
          return options.cliModels ?? "";
        }
        if (options.agyError) throw options.agyError;
        if (options.cliQuota instanceof Error) throw options.cliQuota;
        if (typeof options.cliQuota === "string") return options.cliQuota;
        return options.agyOutput ?? "";
      }
      throw new Error(`unexpected command: ${command}`);
    },
    async requestJson(
      endpoint: AgyConnectionEndpoint,
      path: string,
      timeoutMs: number,
    ) {
      options.onRequest?.(endpoint, path);
      if (options.requestJson)
        return options.requestJson(endpoint, path, timeoutMs);
      const key = `${endpoint.scheme}:${endpoint.port}:${path}`;
      if (options.responses && key in options.responses)
        return options.responses[key];
      throw new Error(`unexpected request: ${key}`);
    },
  };
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join("test", "fixtures", "agy", name), "utf8"),
  ) as unknown;
}

function lsofFor(pid: number, port: number): string {
  return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
agy ${pid} test 8u IPv4 0x1 0t0 TCP 127.0.0.1:${port} (LISTEN)
`;
}

async function startServer(
  handler: (response: ServerResponse, request: IncomingMessage) => void,
): Promise<number> {
  const server = createServer((request, response) =>
    handler(response, request),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function endpointAt(port: number): AgyConnectionEndpoint {
  return {
    scheme: "http",
    port,
    source: "agy",
    pid: process.pid,
    requiresCsrfToken: false,
    requiresUnleashProbe: false,
  };
}

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-agy-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

function cachedAgyQuota(): ProviderQuota {
  return {
    provider: "agy",
    label: "Antigravity",
    source: "cli-rpc",
    windows: [
      {
        id: "gemini_5h",
        label: "Gemini 5-hour",
        kind: "session",
        percentUsed: 12,
        percentRemaining: 88,
        // Still ahead, so a stale fallback may serve it.
        resetsAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-06-15T11:39:34.000Z",
      sourcesTried: ["loopback"],
    },
  };
}
