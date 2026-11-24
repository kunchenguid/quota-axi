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
  vi.doMock("../../src/lib/process.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/lib/process.js")>()),
    findCommandPath: vi.fn(async () => undefined),
    terminateChild: vi.fn(),
  }));
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
  vi.doUnmock("../../src/lib/process.js");
  rmSync(root, { recursive: true, force: true });
});

function writeCodexHome(
  name: string,
  token: string,
  accountId?: string,
): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: token,
        ...(accountId ? { account_id: accountId } : {}),
      },
    }),
  );
  return home;
}

function writePiAccounts(
  accounts: Record<string, { token: string; accountId: string }>,
): void {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(accounts).map(([id, account]) => [
          id,
          {
            type: "oauth",
            access: account.token,
            accountId: account.accountId,
            expires: Date.now() + 3_600_000,
          },
        ]),
      ),
    ),
  );
}

async function readCodex(args: string[] = ["--provider", "codex", "--json"]) {
  const { quotaCommand } = await import("../../src/commands.js");
  return JSON.parse(await quotaCommand(args, undefined));
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

  it("keeps a rejected native account separate from healthy Pi accounts", async () => {
    writeCodexHome("selected", "native-rejected", "acct-native");
    writePiAccounts({
      "openai-codex": { token: "pi-personal", accountId: "acct-personal" },
      "openai-codex-team": { token: "pi-team", accountId: "acct-team" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const token = new Headers(init.headers).get("authorization") ?? "";
        if (token.includes("native-rejected"))
          return new Response(null, { status: 401 });
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            account_id: token.replace("Bearer ", "acct-"),
            rate_limit: {
              primary_window: { used_percent: 30, reset_after_seconds: 3600 },
            },
          }),
        );
      }),
    );

    const result = await readCodex(["--provider", "codex", "--full", "--json"]);
    expect(result.providers).toHaveLength(3);
    expect(result.providers[0].state.status).toBe("auth_required");
    expect(result.providers[0].accountKeys).toEqual(["codex-home"]);
    expect(
      result.providers
        .slice(1)
        .every(
          (p: { state: { status: string } }) => p.state.status === "fresh",
        ),
    ).toBe(true);
    expect(
      result.providers
        .slice(1)
        .every(
          (p: { accountKeys: string[] }) =>
            !p.accountKeys.includes("codex-home"),
        ),
    ).toBe(true);
  });

  it("appends listed homes without hiding existing Pi lanes", async () => {
    writeCodexHome("selected", "native-token", "acct-native");
    const listed = writeCodexHome("listed", "listed-token", "acct-listed");
    writePiAccounts({
      "openai-codex": { token: "pi-personal", accountId: "acct-personal" },
      "openai-codex-team": { token: "pi-team", accountId: "acct-team" },
    });
    vi.stubEnv("QUOTA_AXI_CODEX_HOMES", listed);

    const result = await readCodex(["--provider", "codex", "--full", "--json"]);
    expect(result.providers).toHaveLength(4);
    expect(
      result.providers.map(
        (p: { account: { accountId?: string } }) => p.account?.accountId,
      ),
    ).toEqual([
      "acct-native-token",
      "acct-pi-personal",
      "acct-pi-team",
      "acct-listed-token",
    ]);
  });

  it("serves each home's own cached windows after a transient failure", async () => {
    const selected = writeCodexHome(
      "selected",
      "selected-token",
      "acct-selected",
    );
    const listed = writeCodexHome("listed", "listed-token", "acct-listed");
    vi.stubEnv("QUOTA_AXI_CODEX_HOMES", listed);
    await readCodex(["--provider", "codex", "--full", "--json"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    const result = await readCodex(["--provider", "codex", "--full", "--json"]);
    expect(result.providers[0].accountLocator.path).toBe(selected);
    expect(result.providers[0].state.status).toBe("stale");
    expect(result.providers[0].windows[0].percentRemaining).toBe(90);
    expect(result.providers[1].accountLocator.path).toBe(listed);
    expect(result.providers[1].state.status).toBe("stale");
    expect(result.providers[1].windows[0].percentRemaining).toBe(90);
  });

  it("deduplicates filesystem aliases and keeps the first locator spelling", async () => {
    const selected = writeCodexHome(
      "selected",
      "selected-token",
      "acct-selected",
    );
    const listed = writeCodexHome("listed", "listed-token");
    const alias = join(root, "listed-alias");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(listed, alias);
    vi.stubEnv(
      "QUOTA_AXI_CODEX_HOMES",
      [listed, `${listed}/.`, alias].join(delimiter),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const token = new Headers(init.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            ...(token.includes("selected")
              ? { account_id: "acct-selected" }
              : {}),
            rate_limit: {
              primary_window: { used_percent: 10, reset_after_seconds: 3600 },
            },
          }),
        );
      }),
    );

    const result = await readCodex(["--provider", "codex", "--full", "--json"]);
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0].accountLocator.path).toBe(selected);
    expect(result.providers[1].accountLocator.path).toBe(listed);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
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
