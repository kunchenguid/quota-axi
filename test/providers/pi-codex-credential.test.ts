import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiCodexCredentialBroker } from "../../src/providers/pi-codex-credential.js";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 3_600_000;
const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
let temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Pi Codex credential broker", () => {
  it("reads the exact openai-codex OAuth shape without changing Pi auth state", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    writeAuth(authPath, {
      "openai-codex": oauthEntry(),
      unrelated: { type: "oauth", access: "must-not-be-used" },
    });
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const before = snapshot(authPath);
    const broker = createPiCodexCredentialBroker({ now: () => NOW });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      credentials: {
        accessToken: "fixture-codex-access-token",
        accountId: "acct-fixture-codex",
        expiresAtMs: FUTURE,
      },
    });
    const inspection = await broker.inspect();

    expect(inspection).toEqual({
      path: authPath,
      status: "available",
    });
    expect(JSON.stringify(inspection)).not.toContain(
      "fixture-codex-access-token",
    );
    expect(JSON.stringify(inspection)).not.toContain(
      "fixture-codex-refresh-token",
    );
    expectSnapshotEqual(authPath, before);
  });

  it("distinguishes a missing file and a missing provider entry", async () => {
    const home = temporaryDirectory();
    const agentDirectory = join(home, ".pi", "agent");
    const missingBroker = createPiCodexCredentialBroker({
      environment: { HOME: home, PI_CODING_AGENT_DIR: agentDirectory },
      homeDirectory: () => home,
      now: () => NOW,
    });

    await expect(missingBroker.resolve()).resolves.toEqual({
      status: "missing",
    });
    await expect(missingBroker.inspect()).resolves.toEqual({
      path: join(agentDirectory, "auth.json"),
      status: "missing",
    });

    const authPath = join(agentDirectory, "auth.json");
    writeAuth(authPath, { anthropic: { type: "oauth", access: "other" } });
    await expect(missingBroker.resolve()).resolves.toEqual({
      status: "missing",
    });
  });

  it("rejects malformed JSON and invalid OAuth shapes", async () => {
    const malformed = authFixture("{not-json");
    await expect(brokerFor(malformed).resolve()).resolves.toEqual({
      status: "invalid",
    });

    const invalidEntries = [
      { ...oauthEntry(), accountId: undefined },
      { ...oauthEntry(), expires: undefined },
      { ...oauthEntry(), expires: Math.floor(FUTURE / 1000) },
      { ...oauthEntry(), access: "$OPENAI_CODEX_TOKEN" },
      { ...oauthEntry(), access: "!op read codex" },
      { ...oauthEntry(), accountId: "acct\u0000unsafe" },
      { access: "fixture", accountId: "acct", expires: FUTURE },
    ];
    for (const entry of invalidEntries) {
      const fixture = authFixture({ "openai-codex": entry });
      await expect(brokerFor(fixture).resolve()).resolves.toEqual({
        status: "invalid",
      });
    }
  });

  it("distinguishes an oversized auth file using the 64 KiB read cap", async () => {
    const oversized = Buffer.alloc(64 * 1024 + 1, 0x61);
    const readFile = vi.fn(async () => oversized);
    const broker = createPiCodexCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: "/synthetic/pi-agent" },
      homeDirectory: () => "/synthetic/home",
      readFile,
      now: () => NOW,
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "oversized" });
    await expect(broker.inspect()).resolves.toMatchObject({
      status: "oversized",
      error: "credential_file_too_large",
    });
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile.mock.calls[0][1]).toBe(64 * 1024);
    expect(readFile.mock.calls[1][1]).toBe(64 * 1024);
  });

  it("reports API-key credentials as unsupported subscription auth", async () => {
    const fixture = authFixture({
      "openai-codex": { type: "api_key", key: "sk-must-not-be-used" },
    });
    const broker = brokerFor(fixture);

    await expect(broker.resolve()).resolves.toEqual({
      status: "unsupported",
    });
    const inspection = await broker.inspect();
    expect(inspection).toMatchObject({
      status: "unsupported",
      error: "unsupported_credential_type",
    });
    expect(JSON.stringify(inspection)).not.toContain("sk-must-not-be-used");
  });

  it("distinguishes refreshable and non-refreshable expiry without refreshing", async () => {
    const refreshable = authFixture({
      "openai-codex": oauthEntry({
        expires: NOW - 1,
        refresh: "refresh-stays-private",
      }),
    });
    const nonRefreshable = authFixture({
      "openai-codex": oauthEntry({ expires: NOW - 1, refresh: undefined }),
    });

    await expect(brokerFor(refreshable).resolve()).resolves.toEqual({
      status: "expired",
      refreshable: true,
    });
    await expect(brokerFor(refreshable).inspect()).resolves.toMatchObject({
      status: "expired",
      refreshable: true,
      error: "credentials_expired_refreshable",
    });
    await expect(brokerFor(nonRefreshable).resolve()).resolves.toEqual({
      status: "expired",
      refreshable: false,
    });
    const inspection = await brokerFor(nonRefreshable).inspect();
    expect(inspection).toMatchObject({
      status: "expired",
      refreshable: false,
      error: "credentials_expired",
    });
    expect(JSON.stringify(inspection)).not.toContain("refresh-stays-private");
  });

  it.each([" ", "$REFRESH_TOKEN", "!op read refresh", "refresh\u0000token"])(
    "does not classify unsafe refresh value %s as refreshable",
    async (refresh) => {
      const fixture = authFixture({
        "openai-codex": oauthEntry({ expires: NOW - 1, refresh }),
      });
      await expect(brokerFor(fixture).resolve()).resolves.toEqual({
        status: "expired",
        refreshable: false,
      });
    },
  );

  it("bounds unexpected read failures without exposing private details", async () => {
    const broker = createPiCodexCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: "/synthetic/pi-agent" },
      homeDirectory: () => "/synthetic/home",
      readFile: async () => {
        throw new Error("private-reader-detail");
      },
      now: () => NOW,
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "error" });
    const inspection = await broker.inspect();
    expect(inspection).toMatchObject({
      status: "error",
      error: "credential_resolution_failed",
    });
    expect(JSON.stringify(inspection)).not.toContain("private-reader-detail");
  });

  it("uses PI_CODING_AGENT_DIR with safe tilde expansion", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    writeAuth(authPath, { "openai-codex": oauthEntry() });
    const broker = createPiCodexCredentialBroker({
      environment: { HOME: home, PI_CODING_AGENT_DIR: "~/.pi/agent" },
      homeDirectory: () => home,
      now: () => NOW,
    });

    await expect(broker.resolve()).resolves.toMatchObject({
      status: "available",
    });
  });

  it("uses bounded read-only file access without Pi SDK or mutation APIs", () => {
    const implementation = readFileSync(
      new URL("../../src/providers/pi-codex-credential.ts", import.meta.url),
      "utf8",
    );

    expect(implementation).toContain('open(path, "r")');
    expect(implementation).not.toMatch(/@earendil-works\/pi-/);
    expect(implementation).not.toMatch(/writeFile|rename|chmod|refreshToken/);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-codex-"));
  temporaryDirectories.push(directory);
  return directory;
}

function authFixture(value: unknown): string {
  const home = temporaryDirectory();
  const authPath = join(home, ".pi", "agent", "auth.json");
  if (typeof value === "string") {
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(authPath, value, { mode: 0o600 });
  } else {
    writeAuth(authPath, value);
  }
  return authPath;
}

function brokerFor(authPath: string) {
  return createPiCodexCredentialBroker({
    environment: { PI_CODING_AGENT_DIR: dirname(authPath) },
    homeDirectory: () => dirname(dirname(authPath)),
    now: () => NOW,
  });
}

function oauthEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth",
    access: "fixture-codex-access-token",
    refresh: "fixture-codex-refresh-token",
    expires: FUTURE,
    accountId: "acct-fixture-codex",
    ...overrides,
  };
}

function writeAuth(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

type FileSnapshot = {
  bytes: string;
  mode: number;
  mtimeMs: number;
  size: number;
};

function snapshot(path: string): FileSnapshot {
  const stats = statSync(path);
  return {
    bytes: readFileSync(path, "utf8"),
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function expectSnapshotEqual(path: string, before: FileSnapshot): void {
  const after = snapshot(path);
  expect(after).toEqual(before);
}
