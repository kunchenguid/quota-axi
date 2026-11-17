import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeClaudeApiUsage } from "../src/providers/claude.js";
import {
  readCachedProvider,
  stampClaudeReadingContext,
  writeCachedProviders,
} from "../src/cache.js";
import type { QuotaAxiResponse } from "../src/types.js";

const fixtures = join(import.meta.dirname, "fixtures", "claude");
const directories: string[] = [];
const shapes = [
  "two-grants",
  "empty",
  "ineligible",
  "missing",
  "unknown-type",
  "malformed",
] as const;
const outputModes = [
  { mode: "TOON", flags: [] },
  { mode: "full TOON", flags: ["--full"] },
  { mode: "JSON", flags: ["--json"] },
  { mode: "full JSON", flags: ["--json", "--full"] },
];
const jsonModes = outputModes
  .filter(({ flags }) => flags.includes("--json"))
  .map((mode) => ({ ...mode, full: mode.flags.includes("--full") }));

function fixture(name: (typeof shapes)[number]): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixtures, `resets-${name}.json`), "utf8"),
  ) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Claude manual reset inventory", () => {
  it("keeps only remaining counts, display kinds, and expiry dates", () => {
    expect(normalizeClaudeApiUsage(fixture("two-grants"))).toMatchObject({
      resetsAvailable: 2,
      resetGrants: [
        { kind: "fable", remaining: 1, expiresAt: "2027-03-09T07:59:00Z" },
        { kind: "weekly", remaining: 1, expiresAt: "2026-12-10T22:00:00Z" },
      ],
    });
    expect(
      Object.keys(
        normalizeClaudeApiUsage(fixture("two-grants"))!.resetGrants![0]!,
      ),
    ).toEqual(["kind", "remaining", "expiresAt"]);
  });

  it("reports a known empty inventory and an unknown display type", () => {
    expect(normalizeClaudeApiUsage(fixture("empty"))).toMatchObject({
      resetsAvailable: 0,
      resetGrants: [],
    });
    expect(normalizeClaudeApiUsage(fixture("unknown-type"))).toMatchObject({
      resetsAvailable: 1,
      resetGrants: [{ kind: "unknown", remaining: 1 }],
    });
  });

  it.each(["missing", "ineligible", "malformed"] as const)(
    "leaves the usage normalization identical for %s",
    (shape) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime("2026-11-17T09:00:00Z");
      expect(normalizeClaudeApiUsage(fixture(shape))).toEqual(
        normalizeClaudeApiUsage(fixture("missing")),
      );
    },
  );

  it.each([
    ["session", ["seven_day"], false, "session"],
    ["full", [], false, "full"],
    [undefined, ["five_hour"], false, "session"],
    [undefined, ["seven_day"], false, "weekly"],
    [undefined, ["five_hour", "seven_day"], false, "full"],
    [undefined, ["new_window"], false, "unknown"],
    ["", ["seven_day"], false, "weekly"],
    ["new_type", ["seven_day"], true, "fable"],
  ])(
    "derives kind from the client precedence (%s, %j, %s)",
    (type, clears, gives_back_weekly, kind) => {
      const raw = fixture("missing");
      raw.cedar_ember = {
        eligible: true,
        grants: [{ resets_left: 3, type, clears, gives_back_weekly }],
      };
      expect(normalizeClaudeApiUsage(raw)).toMatchObject({
        resetsAvailable: 3,
        resetGrants: [{ kind, remaining: 3 }],
      });
    },
  );

  it.each([
    null,
    [],
    {},
    { eligible: "true", grants: [] },
    { eligible: true, grants: {} },
    ...[-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2"].map(
      (resets_left) => ({ eligible: true, grants: [{ resets_left }] }),
    ),
    { eligible: true, grants: [null] },
    { eligible: true, grants: [{ resets_left: 1, type: 42 }] },
    { eligible: true, grants: [{ resets_left: 1, clears: "seven_day" }] },
    { eligible: true, grants: [{ resets_left: 1, clears: [42] }] },
    { eligible: true, grants: [{ resets_left: 1, gives_back_weekly: "true" }] },
    { eligible: true, grants: [{ resets_left: 1, ends_at: "invalid" }] },
    { eligible: true, grants: [{ resets_left: 1, ends_at: 123 }] },
    {
      eligible: true,
      grants: [{ resets_left: Number.MAX_SAFE_INTEGER }, { resets_left: 1 }],
    },
  ])(
    "ignores an invalid extension without changing windows (%j)",
    (cedar_ember) => {
      const result = normalizeClaudeApiUsage({
        ...fixture("missing"),
        cedar_ember,
      });
      expect(result?.windows).toHaveLength(2);
      expect(result).not.toHaveProperty("resetsAvailable");
      expect(result).not.toHaveProperty("resetGrants");
    },
  );

  it("omits spent grants and does not infer redemption eligibility", () => {
    const result = normalizeClaudeApiUsage({
      ...fixture("missing"),
      cedar_ember: {
        eligible: true,
        grants: [
          { resets_left: 0, type: "weekly" },
          {
            resets_left: 2,
            type: "session",
            paused: true,
            usable_now: false,
            use_requires_limit: true,
          },
        ],
      },
    });
    expect(result).toMatchObject({
      resetsAvailable: 2,
      resetGrants: [{ kind: "session", remaining: 2 }],
    });
  });

  it("never persists reset inventory in a quota cache snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-reset-cache-"));
    directories.push(root);
    vi.stubEnv("HOME", root);
    vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
    const normalized = normalizeClaudeApiUsage(fixture("two-grants"))!;
    const report: QuotaAxiResponse["providers"][number] = {
      ...normalized,
      provider: "claude",
      label: "Claude",
      source: "oauth",
      account: { accountId: "fixture-account", identityStatus: "verified" },
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: normalized.refreshedAt,
        sourcesTried: ["oauth-file"],
      },
    };
    stampClaudeReadingContext(report, "a".repeat(64));
    writeCachedProviders([report]);
    const cached = readCachedProvider("claude");
    expect(cached?.windows).toHaveLength(2);
    expect(cached).not.toHaveProperty("resetsAvailable");
    expect(cached).not.toHaveProperty("resetGrants");
    expect(
      readFileSync(join(root, "cache", "quota-axi", "quotas.json"), "utf8"),
    ).not.toMatch(/resetsAvailable|resetGrants|fixture-fable|event_props/);
  });
});

describe("built public Claude CLI with a rejecting mock transport", () => {
  const run = (
    shape: (typeof shapes)[number],
    flags: string[] = [],
    profileOnly = true,
    expanded = false,
    siblingShape: (typeof shapes)[number] = shape,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "quota-claude-resets-"));
    directories.push(root);
    const profile = join(root, "profile");
    mkdirSync(profile);
    writeFileSync(
      join(profile, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fixture-only" } }),
      { mode: 0o600 },
    );
    const sibling = join(root, "sibling");
    if (expanded) {
      mkdirSync(sibling);
      writeFileSync(
        join(sibling, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "fixture-sibling" } }),
        { mode: 0o600 },
      );
    }
    const log = join(root, "requests.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(fixtures, "reset-transport.mjs"),
        resolve("dist/bin/quota-axi.js"),
        "--provider",
        "claude",
        ...(profileOnly && !expanded
          ? ["--profile-only"]
          : ["--no-credential-refresh"]),
        ...flags,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          HOME: root,
          USERPROFILE: root,
          PATH: "",
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_DATA_HOME: join(root, "data"),
          CLAUDE_CONFIG_DIR: profile,
          ...(expanded ? { QUOTA_AXI_CLAUDE_PROFILES: sibling } : {}),
          RESET_USAGE_FIXTURE: join(fixtures, `resets-${shape}.json`),
          RESET_SIBLING_USAGE_FIXTURE: join(
            fixtures,
            `resets-${siblingShape}.json`,
          ),
          RESET_REQUEST_LOG: log,
        },
      },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(
      Array.from({ length: expanded ? 2 : 1 }, () => [
        {
          method: "GET",
          url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
        },
        { method: "GET", url: "https://api.anthropic.com/api/oauth/profile" },
      ]).flat(),
    );
    if (!profileOnly || expanded)
      expect(
        readFileSync(join(root, "cache", "quota-axi", "quotas.json"), "utf8"),
      ).not.toMatch(/resetsAvailable|resetGrants|fixture-fable|private_event/);
    return result.stdout.replaceAll(
      resolve("dist/bin/quota-axi.js"),
      "quota-axi",
    );
  };

  it.each(
    shapes.flatMap((shape) => outputModes.map((mode) => ({ shape, ...mode }))),
  )("renders $shape in $mode", ({ shape, flags }) => {
    const output = run(shape, flags);
    if (shape === "missing" || shape === "two-grants")
      expect(output).toMatchSnapshot();
  });

  it.each(
    (["ineligible", "malformed"] as const).flatMap((shape) =>
      outputModes.map((mode) => ({
        shape,
        ...mode,
      })),
    ),
  )(
    "preserves before/after output byte-for-byte for $shape in $mode",
    ({ shape, flags }) => {
      expect(run(shape, flags)).toBe(run("missing", flags));
    },
  );

  it("publishes the count in compact JSON", () => {
    const compact = JSON.parse(
      run("two-grants", ["--json"]),
    ) as QuotaAxiResponse;
    expect(compact.providers[0]?.resetsAvailable).toBe(2);
    expect(compact.providers[0]).not.toHaveProperty("resetGrants");
  });

  it("publishes normalized grant details in full JSON", () => {
    const full = JSON.parse(
      run("two-grants", ["--json", "--full"]),
    ) as QuotaAxiResponse;
    expect(full.providers[0]?.resetGrants).toHaveLength(2);
    expect(JSON.stringify(full)).not.toMatch(
      /fixture-fable|fixture-weekly|event_props|private_event|percent_used|fixture-only/,
    );
  });

  it("names the available inventory in compact TOON", () => {
    expect(run("two-grants")).toContain("claude,all,resets,available 2,none");
  });

  it("renders an unknown grant kind in full TOON", () => {
    expect(run("unknown-type", ["--full"])).toContain(
      'claude,unknown,1,"2026-12-10T22:00:00Z"',
    );
  });

  it("also publishes inventory through ordinary selected-profile discovery", () => {
    const output = JSON.parse(
      run("two-grants", ["--json", "--full"], false),
    ) as QuotaAxiResponse;
    expect(output.providers[0]).toMatchObject({
      resetsAvailable: 2,
      resetGrants: [{ kind: "fable" }, { kind: "weekly" }],
      state: { status: "fresh" },
    });
  });

  it("keeps a known empty inventory distinct from missing data in JSON", () => {
    const output = JSON.parse(
      run("empty", ["--json", "--full"]),
    ) as QuotaAxiResponse;
    expect(output.providers[0]).toMatchObject({
      resetsAvailable: 0,
      resetGrants: [],
    });
  });

  it("omits an empty inventory attention row in compact TOON", () => {
    expect(run("empty")).not.toContain(",resets,");
  });

  it.each(
    shapes.flatMap((shape) =>
      [false, true].flatMap((expanded) =>
        jsonModes.map((mode) => ({ shape, expanded, ...mode })),
      ),
    ),
  )(
    "versions $shape inventory with expanded=$expanded in $mode",
    ({ shape, expanded, flags, full }) => {
      const count =
        shape === "two-grants"
          ? 2
          : shape === "empty"
            ? 0
            : shape === "unknown-type"
              ? 1
              : undefined;
      const output = JSON.parse(
        run(shape, flags, false, expanded),
      ) as QuotaAxiResponse;
      expect(output.schemaVersion).toBe(
        count === undefined ? (expanded ? 6 : 5) : expanded ? 8 : 7,
      );
      expect(output.providers).toHaveLength(expanded ? 2 : 1);
      for (const provider of output.providers) {
        expect(provider.state.status).toBe("fresh");
        expect(provider.accountKey !== undefined).toBe(expanded);
        if (count === undefined) {
          expect(provider).not.toHaveProperty("resetsAvailable");
          expect(provider).not.toHaveProperty("resetGrants");
        } else {
          expect(provider.resetsAvailable).toBe(count);
          if (full)
            expect(provider.resetGrants).toHaveLength(
              shape === "two-grants" ? 2 : count === 0 ? 0 : 1,
            );
          else expect(provider).not.toHaveProperty("resetGrants");
        }
      }
    },
  );

  it.each(
    (["two-grants", "empty"] as const).flatMap((shape) =>
      (
        [
          ["missing", shape],
          [shape, "missing"],
        ] as const
      ).flatMap(([selected, sibling]) =>
        jsonModes.map((mode) => ({ selected, sibling, ...mode })),
      ),
    ),
  )(
    "versions mixed selected=$selected sibling=$sibling inventory in $mode",
    ({ selected, sibling, flags }) => {
      const output = JSON.parse(
        run(selected, flags, false, true, sibling),
      ) as QuotaAxiResponse;
      expect(output.schemaVersion).toBe(8);
      expect(output.providers).toHaveLength(2);
      expect(
        output.providers.filter(
          (provider) => provider.resetsAvailable !== undefined,
        ),
      ).toHaveLength(1);
    },
  );
});
