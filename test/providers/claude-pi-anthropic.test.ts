import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runRefreshDelegate = vi.hoisted(() => vi.fn());
vi.mock("../../src/providers/delegated-refresh.js", async (original) => ({
  ...(await original<
    typeof import("../../src/providers/delegated-refresh.js")
  >()),
  runRefreshDelegate,
}));

const PI_TOKEN = "pi-anthropic-token";
const OAUTH_TOKEN = "claude-oauth-token";
let home: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  vi.resetModules();
  runRefreshDelegate.mockReset();
  home = mkdtempSync(join(tmpdir(), "quota-axi-claude-pi-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  Object.defineProperty(process, "platform", { value: "linux" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(process, "platform", platform);
  rmSync(home, { recursive: true, force: true });
});

describe("Claude Pi Anthropic adapter", () => {
  it("uses a healthy Pi Anthropic OAuth entry as the quota source", async () => {
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    mockAnthropic({ token: PI_TOKEN });

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.source).toBe("oauth");
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual(
      expect.arrayContaining([{ source: "pi:anthropic", status: "success" }]),
    );
    expect(runRefreshDelegate).not.toHaveBeenCalled();
  });

  it("keeps Claude's OAuth file ahead of a healthy Pi sibling", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    const calls = mockStatuses({ [OAUTH_TOKEN]: 200, [PI_TOKEN]: 200 });

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.state.status).toBe("fresh");
    expect(calls).toEqual([OAUTH_TOKEN]);
    expect(report.attempts).toContainEqual({
      source: "oauth-file",
      status: "success",
    });
  });

  it("keeps the explicit Claude environment token ahead of Pi", async () => {
    const envToken = "synthetic-env-token";
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", envToken);
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    const calls = mockStatuses({ [envToken]: 200, [PI_TOKEN]: 200 });

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.state.status).toBe("fresh");
    expect(calls).toEqual([envToken]);
    expect(report.attempts).toContainEqual({
      source: "env",
      status: "success",
    });
  });

  it("hands over an expired rejected OAuth file to a healthy Pi sibling", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: 1,
      refreshToken: "synthetic-refresh",
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    const calls = mockStatuses({ [OAUTH_TOKEN]: 401, [PI_TOKEN]: 200 });

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: true });

    expect(report.state.status).toBe("fresh");
    expect(calls).toEqual([OAUTH_TOKEN, PI_TOKEN]);
    expect(report.attempts).toContainEqual({
      source: "pi:anthropic",
      status: "success",
    });
    expect(runRefreshDelegate).not.toHaveBeenCalled();
  });

  it("keeps an expired rejected Pi entry soft and never sends it to Claude's refresh delegate", async () => {
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: 1,
      refresh: "synthetic-refresh",
    });
    const calls = mockStatuses({ [PI_TOKEN]: 401 });

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: true });

    expect(calls).toEqual([PI_TOKEN]);
    expect(report.state).toMatchObject({
      status: "unavailable",
      authStatus: "expired_refreshable",
    });
    expect(runRefreshDelegate).not.toHaveBeenCalled();
  });

  it("does not use a Pi cache snapshot when an earlier OAuth failure wins", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: 1,
      refreshToken: "synthetic-refresh",
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    const calls = mockStatuses({ [OAUTH_TOKEN]: 401, [PI_TOKEN]: 401 });

    const { stampClaudePiContext } =
      await import("../../src/providers/claude-cache-context.js");
    const { writeCachedProviders } = await import("../../src/cache.js");
    const cached = {
      provider: "claude" as const,
      label: "Claude",
      source: "oauth" as const,
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session" as const,
          percentUsed: 12,
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
      state: {
        status: "fresh" as const,
        stale: false,
        refreshedAt: new Date(Date.now() - 60_000).toISOString(),
        sourcesTried: ["pi:anthropic"],
      },
    };
    stampClaudePiContext(cached, PI_TOKEN);
    writeCachedProviders([cached]);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(calls).toEqual([OAUTH_TOKEN, PI_TOKEN]);
    expect(report.state.status).toBe("unavailable");
    expect(report.state.authStatus).toBe("expired_refreshable");
    expect(report.windows).toEqual([]);
  });

  it("uses the OAuth cache when its rejected expired credential supplies the failure", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: 1,
      refreshToken: "synthetic-refresh",
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    mockStatuses({ [OAUTH_TOKEN]: 401, [PI_TOKEN]: 401 });
    const { writeCachedProviders } = await import("../../src/cache.js");
    writeCachedProviders([cachedClaude(37)]);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.state.status).toBe("stale");
    expect(report.state.authStatus).toBe("expired_refreshable");
    expect(report.windows[0]?.percentUsed).toBe(37);
  });

  it("uses the Pi cache only when the Pi transient failure supplies the verdict", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: 1,
      refreshToken: "synthetic-refresh",
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    const calls = mockStatuses({ [OAUTH_TOKEN]: 401, [PI_TOKEN]: 503 });
    const { stampClaudePiContext } =
      await import("../../src/providers/claude-cache-context.js");
    const { writeCachedProviders } = await import("../../src/cache.js");
    const cached = cachedClaude(19);
    stampClaudePiContext(cached, PI_TOKEN);
    writeCachedProviders([cached]);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(calls).toEqual([OAUTH_TOKEN, PI_TOKEN]);
    expect(report.state.status).toBe("stale");
    expect(report.windows[0]?.percentUsed).toBe(19);
    expect(report.state.authStatus).not.toBe("expired_refreshable");
  });

  it("withholds a previous Pi token's cache after the selected Pi token fails transiently", async () => {
    const otherToken = "synthetic-other-pi-token";
    writePi({
      type: "oauth",
      access: otherToken,
      expires: 1,
      refresh: "synthetic-refresh",
    });
    const calls = mockStatuses({ [otherToken]: 503 });
    const { stampClaudePiContext } =
      await import("../../src/providers/claude-cache-context.js");
    const { writeCachedProviders } = await import("../../src/cache.js");
    const cached = cachedClaude(19);
    stampClaudePiContext(cached, PI_TOKEN);
    writeCachedProviders([cached]);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: true });

    expect(calls).toEqual([otherToken]);
    expect(report.state.status).toBe("error");
    expect(report.state.stale).toBe(false);
    expect(runRefreshDelegate).not.toHaveBeenCalled();
  });

  it("does not hand over a transient stored-source failure to Pi", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get("authorization");
        expect(authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
        return new Response(null, { status: 503 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.state.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function writePi(value: unknown): void {
  const directory = join(home, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({ anthropic: value }),
  );
}

function writeClaude(value: unknown): void {
  const directory = join(home, ".claude");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: value }),
  );
}

function mockAnthropic({ token }: { token: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe(`Bearer ${token}`);
      const url = String(_input);
      if (url.endsWith("/usage"))
        return new Response(JSON.stringify({ five_hour: { utilization: 2 } }));
      return new Response(JSON.stringify({ account: { uuid: "pi-account" } }));
    }),
  );
}

function mockStatuses(statuses: Record<string, number>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const token = new Headers(init?.headers)
        .get("authorization")
        ?.replace(/^Bearer /, "");
      if (!token || !(token in statuses))
        throw new Error("unexpected synthetic bearer");
      if (String(input).endsWith("/profile"))
        return new Response(
          JSON.stringify({ account: { uuid: "synthetic-account" } }),
        );
      calls.push(token);
      const status = statuses[token]!;
      return status === 200
        ? new Response(JSON.stringify({ five_hour: { utilization: 2 } }))
        : new Response(null, { status });
    }),
  );
  return calls;
}

function cachedClaude(percentUsed: number) {
  return {
    provider: "claude" as const,
    label: "Claude",
    source: "oauth" as const,
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session" as const,
        percentUsed,
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
    state: {
      status: "fresh" as const,
      stale: false,
      refreshedAt: new Date(Date.now() - 60_000).toISOString(),
      sourcesTried: ["oauth-file"],
    },
  };
}
