import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ProviderQuota, QuotaAxiResponse } from "../src/types.js";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
const PROVIDERS = ["grok", "codex", "cursor", "copilot", "zai"] as const;
type Provider = (typeof PROVIDERS)[number];
const DAY_MS = 24 * 60 * 60 * 1_000;

let temporaryDirectories: string[] = [];
let closedProxy: string;

beforeAll(async () => {
  // Every request goes through a proxy port nothing listens on, so each read
  // fails transiently (ECONNREFUSED) and no vendor is ever contacted.
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((done) => server.close(() => done()));
  closedProxy = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

type WindowTiming = { startsAt?: string; resetsAt?: string };

/**
 * One synthetic machine: accepted credentials for every provider, and a quota
 * cache seeded with one 60%-remaining window per provider.
 */
function fixture(seed?: { timing: WindowTiming; refreshedAt: string }) {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-stale-bound-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const cache = join(root, "cache", "quota-axi");
  const pi = join(root, "pi");
  const bin = join(root, "bin");
  for (const directory of [
    join(home, ".grok"),
    join(home, ".codex"),
    cache,
    pi,
    bin,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  // PATH holds node alone, so no installed vendor CLI can answer instead.
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(
    join(home, ".grok", "auth.json"),
    JSON.stringify({
      "https://auth.x.ai::fixture": {
        key: "fixture",
        auth_mode: "oidc",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    }),
  );
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({
      tokens: { access_token: "fixture", account_id: "acct-fixture" },
    }),
  );
  writeFileSync(
    join(root, "cursor-auth.json"),
    JSON.stringify({ accessToken: "fixture" }),
  );
  writeFileSync(
    join(root, "apps.json"),
    JSON.stringify({ "github.com:app": { oauth_token: "fixture" } }),
  );
  writeFileSync(
    join(pi, "auth.json"),
    JSON.stringify({ zai: { type: "api_key", key: "fixture" } }),
  );

  if (seed) {
    const window = {
      percentUsed: 40,
      percentRemaining: 60,
      ...seed.timing,
    };
    const state = {
      status: "fresh",
      stale: false,
      sourcesTried: ["fixture"],
      refreshedAt: seed.refreshedAt,
    };
    const snapshot = (
      provider: Provider,
      label: string,
      source: string,
      extra: Record<string, unknown>,
    ) => ({
      provider,
      label,
      source,
      windows: [{ ...extra, ...window }],
      state,
    });
    const file = join(cache, "quotas.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 3,
        providers: [
          snapshot("grok", "Grok", "web", {
            id: "credits",
            label: "credits",
            kind: "credits",
          }),
          snapshot("codex", "Codex", "oauth", {
            id: "weekly",
            label: "week",
            kind: "weekly",
            windowSeconds: 604_800,
          }),
          snapshot("cursor", "Cursor", "api", {
            id: "included_usage",
            label: "included_usage",
            kind: "monthly",
          }),
          snapshot("copilot", "GitHub Copilot", "api", {
            id: "premium_interactions",
            label: "premium_interactions",
            kind: "monthly",
          }),
          snapshot("zai", "Z.AI", "api", {
            id: "weekly",
            label: "weekly",
            kind: "weekly",
          }),
        ],
      }),
    );
    chmodSync(file, 0o600);
  }

  return (...flags: string[]) =>
    spawnSync(
      process.execPath,
      [
        BUILT_CLI_ENTRYPOINT,
        "--no-credential-refresh",
        "--provider",
        PROVIDERS.join(","),
        ...flags,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: bin,
          HOME: home,
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_CONFIG_HOME: join(home, ".config"),
          PI_CODING_AGENT_DIR: pi,
          CODEX_HOME: join(home, ".codex"),
          CURSOR_STATE_DB: join(root, "absent.vscdb"),
          CURSOR_CLI_CONFIG: join(root, "cursor-auth.json"),
          GITHUB_COPILOT_APPS_JSON: join(root, "apps.json"),
          COPILOT_HOME: join(home, ".copilot"),
          GH_CONFIG_DIR: join(home, ".config", "gh"),
          HTTPS_PROXY: closedProxy,
          HTTP_PROXY: closedProxy,
        },
      },
    );
}

function report(stdout: string): Record<Provider, ProviderQuota> {
  const response = JSON.parse(stdout) as QuotaAxiResponse;
  return Object.fromEntries(
    response.providers.map((provider) => [provider.provider, provider]),
  ) as Record<Provider, ProviderQuota>;
}

/** What a failed read publishes, independent of when it ran. */
function failedRead(provider: ProviderQuota) {
  return {
    source: provider.source,
    windows: provider.windows,
    status: provider.state.status,
    stale: provider.state.stale,
    error: provider.state.error,
  };
}

describe("built CLI stale cache fallback bound", () => {
  let uncached: ReturnType<typeof spawnSync>;
  let uncachedReport: Record<Provider, ProviderQuota>;

  beforeAll(() => {
    uncached = fixture()("--json", "--full");
    uncachedReport = report(String(uncached.stdout));
  });

  it("fails each transient read without a cache", () => {
    expect(uncached.status).toBe(1);
    for (const provider of PROVIDERS) {
      expect(uncachedReport[provider]).toMatchObject({
        windows: [],
        state: { stale: false },
      });
      expect(uncachedReport[provider].source).not.toBe("cache");
    }
  });

  it("reports the failed read, not a window whose reset has passed", () => {
    const now = Date.now();
    const run = fixture({
      timing: {
        startsAt: new Date(now - 8 * DAY_MS).toISOString(),
        resetsAt: new Date(now - DAY_MS).toISOString(),
      },
      refreshedAt: new Date(now - 5 * DAY_MS).toISOString(),
    });

    const json = run("--json", "--full");
    expect(json.status).toBe(uncached.status);
    const providers = report(json.stdout);
    for (const provider of PROVIDERS) {
      expect(failedRead(providers[provider])).toEqual(
        failedRead(uncachedReport[provider]),
      );
    }

    const tui = run("--tui", "--once");
    expect(tui.stdout).not.toContain("cache · stale");
    expect(tui.stdout).not.toContain("60%");
  });

  it("reports the failed read once a resetless window outlives its kind", () => {
    const run = fixture({
      timing: {},
      refreshedAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    });

    const json = run("--json", "--full");
    expect(json.status).toBe(uncached.status);
    const providers = report(json.stdout);
    for (const provider of PROVIDERS) {
      expect(failedRead(providers[provider])).toEqual(
        failedRead(uncachedReport[provider]),
      );
    }
  });

  it("still serves a window whose reset is ahead as stale", () => {
    const now = Date.now();
    const resetsAt = new Date(now + DAY_MS).toISOString();
    const run = fixture({
      timing: { startsAt: new Date(now - 6 * DAY_MS).toISOString(), resetsAt },
      refreshedAt: new Date(now - 60 * 60 * 1_000).toISOString(),
    });

    const json = run("--json", "--full");
    expect(json.status).toBe(0);
    const providers = report(json.stdout);
    for (const provider of PROVIDERS) {
      expect(providers[provider]).toMatchObject({
        source: "cache",
        windows: [{ percentRemaining: 60, resetsAt }],
        state: { status: "stale", stale: true },
      });
    }
  });
});
