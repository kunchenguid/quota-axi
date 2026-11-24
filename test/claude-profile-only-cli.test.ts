import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { QuotaAxiResponse } from "../src/types.js";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("built Claude --profile-only CLI soft-expiry classification", () => {
  it("reports an expired refreshable profile as soft expiry without attempting renewal", () => {
    const accessSentinel = "synthetic-expired-refreshable-access";
    const refreshSentinel = "refresh-token-presence-only";
    const fixture = createProfileFixture({
      accessToken: accessSentinel,
      refreshToken: refreshSentinel,
      expiresAt: "2000-01-01T00:00:00.000Z",
      usageStatus: 401,
    });

    const jsonRun = fixture.run("--json");
    expect(jsonRun.status).toBe(1);
    expect(jsonRun.stderr).toBe("");
    const jsonReport = JSON.parse(jsonRun.stdout) as QuotaAxiResponse;
    expect(jsonReport.providers).toHaveLength(1);
    expect(jsonReport.providers[0]).toMatchObject({
      provider: "claude",
      windows: [],
      state: {
        status: "unavailable",
        stale: false,
        error: "Claude access token expired",
        authStatus: "expired_refreshable",
      },
    });
    expect(jsonReport.providers[0]?.state.reason).toBeUndefined();
    expect(jsonReport.providers[0]?.state.remedyCommand).toBeUndefined();
    expect(jsonReport.providers[0]?.notSetUp).toBeUndefined();
    expect(jsonReport.help).toBeUndefined();

    const fullRun = fixture.run("--full", "--json");
    expect(fullRun.status).toBe(1);
    expect(fullRun.stderr).toBe("");
    const fullReport = JSON.parse(fullRun.stdout) as QuotaAxiResponse;
    expect(fullReport.providers[0]).toMatchObject({
      provider: "claude",
      source: "unavailable",
      windows: [],
      state: {
        status: "unavailable",
        stale: false,
        error: "Claude access token expired",
        authStatus: "expired_refreshable",
        sourcesTried: ["oauth-file"],
      },
      attempts: [
        {
          source: "oauth-file",
          status: "failed",
          error: "Claude access token expired",
        },
      ],
    });

    const toonRun = fixture.run();
    expect(toonRun.status).toBe(1);
    expect(toonRun.stderr).toBe("");
    expect(toonRun.stdout).toContain(
      "claude,all,unavailable,Claude access token expired (auth expired_refreshable),none",
    );

    expect(fixture.readRequests()).toEqual([
      {
        url: "https://api.anthropic.com/api/oauth/usage",
        authorizationMatches: true,
      },
      {
        url: "https://api.anthropic.com/api/oauth/usage",
        authorizationMatches: true,
      },
      {
        url: "https://api.anthropic.com/api/oauth/usage",
        authorizationMatches: true,
      },
    ]);
    expect(existsSync(fixture.delegateMarker)).toBe(false);
    expect(snapshot(fixture.credentialPath)).toEqual(fixture.credentialBefore);
    expect(readdirSync(fixture.cacheHome)).toEqual([]);
    for (const output of [jsonRun.stdout, fullRun.stdout, toonRun.stdout]) {
      expect(output).not.toContain(accessSentinel);
      expect(output).not.toContain(refreshSentinel);
    }
  });

  it("keeps an expired profile without a refresh token as auth_required", () => {
    const accessSentinel = "synthetic-expired-no-refresh-access";
    const fixture = createProfileFixture({
      accessToken: accessSentinel,
      expiresAt: "2000-01-01T00:00:00.000Z",
      usageStatus: 401,
    });

    const fullRun = fixture.run("--full", "--json");
    expect(fullRun.status).toBe(1);
    expect(fullRun.stderr).toBe("");
    const fullReport = JSON.parse(fullRun.stdout) as QuotaAxiResponse;
    expect(fullReport.providers[0]).toMatchObject({
      provider: "claude",
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: "Claude sign-in required",
        sourcesTried: ["oauth-file"],
      },
      attempts: [
        {
          source: "oauth-file",
          status: "failed",
          error: "Claude sign-in required",
        },
      ],
    });
    expect(fullReport.providers[0]?.state.authStatus).toBeUndefined();

    const toonRun = fixture.run();
    expect(toonRun.status).toBe(1);
    expect(toonRun.stderr).toBe("");
    expect(toonRun.stdout).toContain(
      "claude,all,auth_required,Claude sign-in required,none",
    );
    expect(toonRun.stdout).not.toContain("expired_refreshable");

    expect(existsSync(fixture.delegateMarker)).toBe(false);
    expect(snapshot(fixture.credentialPath)).toEqual(fixture.credentialBefore);
    expect(readdirSync(fixture.cacheHome)).toEqual([]);
    expect(fullRun.stdout).not.toContain(accessSentinel);
  });

  it("keeps an unexpired profile rejected with 401 as auth_required even when refreshable", () => {
    const fixture = createProfileFixture({
      accessToken: "synthetic-unexpired-revoked-access",
      refreshToken: "refresh-token-presence-only",
      expiresAt: "2035-01-01T00:00:00.000Z",
      usageStatus: 401,
    });

    const jsonRun = fixture.run("--json");
    expect(jsonRun.status).toBe(1);
    expect(jsonRun.stderr).toBe("");
    const jsonReport = JSON.parse(jsonRun.stdout) as QuotaAxiResponse;
    expect(jsonReport.providers[0]).toMatchObject({
      provider: "claude",
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: "Claude sign-in required",
      },
    });
    expect(jsonReport.providers[0]?.state.authStatus).toBeUndefined();
    expect(existsSync(fixture.delegateMarker)).toBe(false);
  });

  it("keeps a non-auth usage failure on an expired refreshable profile as an error", () => {
    const fixture = createProfileFixture({
      accessToken: "synthetic-expired-server-error-access",
      refreshToken: "refresh-token-presence-only",
      expiresAt: "2000-01-01T00:00:00.000Z",
      usageStatus: 500,
    });

    const jsonRun = fixture.run("--json");
    expect(jsonRun.status).toBe(1);
    expect(jsonRun.stderr).toBe("");
    const jsonReport = JSON.parse(jsonRun.stdout) as QuotaAxiResponse;
    expect(jsonReport.providers[0]).toMatchObject({
      provider: "claude",
      windows: [],
      state: {
        status: "error",
        stale: false,
        error: "Claude quota unavailable (500)",
      },
    });
    expect(jsonReport.providers[0]?.state.authStatus).toBeUndefined();
    expect(existsSync(fixture.delegateMarker)).toBe(false);
  });

  it("keeps a valid unexpired profile reading unchanged", () => {
    const accessSentinel = "synthetic-valid-profile-access";
    const refreshSentinel = "refresh-token-presence-only";
    const fixture = createProfileFixture({
      accessToken: accessSentinel,
      refreshToken: refreshSentinel,
      expiresAt: "2035-01-01T00:00:00.000Z",
      usageStatus: 200,
    });

    const fullRun = fixture.run("--full", "--json");
    expect(fullRun.status).toBe(0);
    expect(fullRun.stderr).toBe("");
    const fullReport = JSON.parse(fullRun.stdout) as QuotaAxiResponse;
    expect(fullReport.providers[0]).toMatchObject({
      provider: "claude",
      source: "oauth",
      account: {
        accountId: "synthetic-account-id",
        identityStatus: "verified",
      },
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentUsed: 25,
          percentRemaining: 75,
        },
      ],
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["oauth-file", "oauth-profile"],
      },
      attempts: [
        { source: "oauth-file", status: "success" },
        { source: "oauth-profile", status: "success" },
      ],
    });
    expect(fullReport.providers[0]?.state.authStatus).toBeUndefined();
    expect(existsSync(fixture.delegateMarker)).toBe(false);
    expect(snapshot(fixture.credentialPath)).toEqual(fixture.credentialBefore);
    expect(readdirSync(fixture.cacheHome)).toEqual([]);
    expect(fullRun.stdout).not.toContain(accessSentinel);
    expect(fullRun.stdout).not.toContain(refreshSentinel);
  });
});

type ProfileFixtureOptions = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  usageStatus: 200 | 401 | 500;
};

type RecordedRequest = {
  url: string;
  authorizationMatches: boolean;
};

type FileSnapshot = {
  bytes: string;
  mode: number;
  mtimeMs: number;
  size: number;
};

function createProfileFixture(options: ProfileFixtureOptions) {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-claude-profile-only-"));
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const cacheHome = join(root, "cache");
  const configHome = join(root, "config");
  const profileDir = join(root, "claude-profile");
  const binDir = join(root, "bin");
  for (const directory of [home, cacheHome, configHome, profileDir, binDir]) {
    mkdirSync(directory, { mode: 0o700 });
  }

  const credentialPath = join(profileDir, ".credentials.json");
  writeFileSync(
    credentialPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: options.accessToken,
        expiresAt: options.expiresAt,
        ...(options.refreshToken !== undefined
          ? { refreshToken: options.refreshToken }
          : {}),
      },
    }),
    { mode: 0o600 },
  );
  const credentialBefore = snapshot(credentialPath);

  const delegateMarker = join(root, "claude-delegate-called");
  const fakeClaude = join(binDir, "claude");
  writeFileSync(
    fakeClaude,
    `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(delegateMarker)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
    { mode: 0o700 },
  );
  chmodSync(fakeClaude, 0o700);

  const requestsPath = join(root, "requests.jsonl");
  const preload = join(root, "stub-claude-fetch.mjs");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";

const expectedAuth = ${JSON.stringify(`Bearer ${options.accessToken}`)};
const usageStatus = ${JSON.stringify(options.usageStatus)};
const requestsPath = ${JSON.stringify(requestsPath)};

globalThis.fetch = async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  appendFileSync(
    requestsPath,
    JSON.stringify({
      url,
      authorizationMatches: headers.get("authorization") === expectedAuth,
    }) + "\\n",
    { mode: 0o600 },
  );
  if (url.endsWith("/api/oauth/profile")) {
    return new Response(
      JSON.stringify({
        account: {
          uuid: "synthetic-account-id",
          email: "synthetic@example.invalid",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (usageStatus === 200) {
    return new Response(
      JSON.stringify({
        five_hour: {
          utilization: 25,
          resets_at: "2035-01-01T05:00:00Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(null, { status: usageStatus });
};
`,
    { mode: 0o600 },
  );

  const run = (...flags: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        BUILT_CLI_ENTRYPOINT,
        "--provider",
        "claude",
        "--profile-only",
        ...flags,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          HOME: home,
          XDG_CACHE_HOME: cacheHome,
          XDG_CONFIG_HOME: configHome,
          CLAUDE_CONFIG_DIR: profileDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );
    if (result.error) throw result.error;
    return result;
  };

  const readRequests = (): RecordedRequest[] => {
    if (!existsSync(requestsPath)) return [];
    return readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecordedRequest);
  };

  return {
    cacheHome,
    credentialPath,
    credentialBefore,
    delegateMarker,
    run,
    readRequests,
  };
}

function snapshot(path: string): FileSnapshot {
  const stats = statSync(path);
  return {
    bytes: readFileSync(path, "utf8"),
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}
