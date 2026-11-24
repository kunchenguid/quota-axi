import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), "quota-axi-codex-homes-"));
  vi.stubEnv("CODEX_HOME", join(root, "selected"));
  vi.stubEnv("QUOTA_AXI_CODEX_HOMES", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "pi"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("authorization") ?? "";
      if (token.includes("broken")) return new Response(null, { status: 503 });
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          account_id: token.replace("Bearer ", "acct-"),
          rate_limit: {
            primary_window: {
              used_percent: token.includes("team") ? 70 : 10,
              reset_after_seconds: 3600,
            },
          },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function writeCodexHome(name: string, token: string): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: token } }),
  );
  return home;
}

describe("Codex home list", () => {
  it("parses absolute homes and ignores empty entries", async () => {
    const { codexListedHomes } = await import("../../src/lib/codex-home.js");
    expect(
      codexListedHomes({
        QUOTA_AXI_CODEX_HOMES: `${join("/home", "me", ".codex-work")}${delimiter}${delimiter}${join("/home", "me", ".codex-team")}`,
      }),
    ).toEqual({
      dirs: ["/home/me/.codex-work", "/home/me/.codex-team"],
      invalid: [],
    });
  });

  it("reports relative entries for validation", async () => {
    const { codexListedHomes } = await import("../../src/lib/codex-home.js");
    expect(codexListedHomes({ QUOTA_AXI_CODEX_HOMES: "codex-work" })).toEqual({
      dirs: [],
      invalid: ["codex-work"],
    });
  });

  it("rejects a relative home before reading credentials", async () => {
    vi.stubEnv("QUOTA_AXI_CODEX_HOMES", "codex-work");
    const { quotaCommand } = await import("../../src/commands.js");
    await expect(
      quotaCommand(["--provider", "codex", "--json"], undefined),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("reports each listed home independently and keeps sibling failures visible", async () => {
    const selected = writeCodexHome("selected", "selected-token");
    const work = writeCodexHome("work", "team-token");
    const broken = writeCodexHome("broken", "broken-token");
    vi.stubEnv("QUOTA_AXI_CODEX_HOMES", [work, broken].join(delimiter));

    const { quotaCommand } = await import("../../src/commands.js");
    const result = JSON.parse(
      await quotaCommand(
        ["--provider", "codex", "--full", "--json", "--no-credential-refresh"],
        undefined,
      ),
    );

    expect(result.providers).toHaveLength(3);
    expect(
      result.providers.map(
        (provider: { accountKey?: string }) => provider.accountKey,
      ),
    ).toEqual([
      "codex-home",
      expect.stringMatching(/^codex-home:/),
      expect.stringMatching(/^codex-home:/),
    ]);
    expect(result.providers[0].accountLocator.path).toBe(selected);
    expect(result.providers[1].accountLocator.path).toBe(work);
    expect(result.providers[1].windows[0].percentRemaining).toBe(30);
    expect(result.providers[2].accountLocator.path).toBe(broken);
    expect(result.providers[2].windows).toEqual([]);
    expect(result.providers[2].state.status).toBe("error");
    const authHeaders = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("authorization"),
      );
    expect(authHeaders).toEqual([
      "Bearer selected-token",
      "Bearer team-token",
      "Bearer broken-token",
      "Bearer broken-token",
    ]);
  });
});
