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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiCursorCredentialBroker } from "../../src/providers/pi-cursor-credential.js";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 3_600_000;
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Pi Cursor credential broker", () => {
  it.each([
    [
      "API key",
      { type: "api_key", key: "literal-cursor-token" },
      {
        status: "available",
        kind: "api_key",
        credential: "literal-cursor-token",
      },
    ],
    [
      "OAuth",
      {
        type: "oauth",
        access: "literal-cursor-access",
        refresh: "refresh-must-stay-private",
        expires: FUTURE,
      },
      {
        status: "available",
        kind: "oauth",
        credential: "literal-cursor-access",
      },
    ],
  ])("reads the exact literal %s shape", async (_label, entry, expected) => {
    const authPath = authFixture({ cursor: entry });
    const before = snapshot(authPath);
    const broker = brokerFor(authPath);

    await expect(broker.resolve()).resolves.toEqual(expected);
    await expect(broker.inspect()).resolves.toEqual({
      path: authPath,
      status: "available",
    });
    expectSnapshotEqual(authPath, before);
  });

  it("probes a stored-expired OAuth access token without reading refresh into output", async () => {
    const access = "stored-expired-cursor-access";
    const refresh = "private-refresh-value";
    const authPath = authFixture({
      cursor: {
        type: "oauth",
        access,
        refresh,
        expires: NOW - 1,
      },
    });
    const broker = brokerFor(authPath);

    await expect(broker.resolve()).resolves.toEqual({
      status: "expired",
      refreshable: true,
      credential: access,
    });
    const inspection = await broker.inspect();
    expect(inspection).toEqual({
      path: authPath,
      status: "expired",
      refreshable: true,
      error: "credentials_expired_refreshable",
    });
    expect(JSON.stringify(inspection)).not.toContain(access);
    expect(JSON.stringify(inspection)).not.toContain(refresh);
  });

  it.each([
    ["non-object store", []],
    ["non-object cursor entry", { cursor: "token" }],
    ["missing type", { cursor: { key: "token" } }],
    [
      "unsafe API key reference",
      { cursor: { type: "api_key", key: "$TOKEN" } },
    ],
    [
      "command API key reference",
      { cursor: { type: "api_key", key: "!op read token" } },
    ],
    ["control-byte access", oauthEntry({ access: "bad\u0000token" })],
    ["seconds expiry", oauthEntry({ expires: Math.floor(FUTURE / 1000) })],
    ["string expiry", oauthEntry({ expires: String(FUTURE) })],
    ["missing refresh", oauthEntry({ refresh: undefined })],
    [
      "invalid API-key env",
      { cursor: { type: "api_key", key: "token", env: { VALUE: 3 } } },
    ],
  ])("rejects %s", async (_label, store) => {
    const authPath = authFixture(store);
    await expect(brokerFor(authPath).resolve()).resolves.toEqual({
      status: "invalid",
    });
  });

  it("keeps absent, unsupported, malformed, oversized, and read-error states distinct", async () => {
    const missingPath = join(temporaryDirectory(), "pi", "auth.json");
    await expect(brokerFor(missingPath).resolve()).resolves.toEqual({
      status: "missing",
    });

    const absentEntry = authFixture({ xai: { type: "api_key", key: "other" } });
    await expect(brokerFor(absentEntry).resolve()).resolves.toEqual({
      status: "missing",
    });

    const unsupported = authFixture({
      cursor: { type: "device_code", access: "unused" },
    });
    await expect(brokerFor(unsupported).resolve()).resolves.toEqual({
      status: "unsupported",
    });

    const malformed = authFixture("{not-json");
    await expect(brokerFor(malformed).resolve()).resolves.toEqual({
      status: "invalid",
    });

    const readFile = vi.fn(async () => Buffer.alloc(64 * 1024 + 1));
    const oversized = createPiCursorCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: "/synthetic/pi-agent" },
      homeDirectory: () => "/synthetic/home",
      readFile,
      now: () => NOW,
    });
    await expect(oversized.resolve()).resolves.toEqual({ status: "invalid" });
    expect(readFile).toHaveBeenCalledWith(
      "/synthetic/pi-agent/auth.json",
      64 * 1024,
    );

    const broken = createPiCursorCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: "/synthetic/pi-agent" },
      homeDirectory: () => "/synthetic/home",
      readFile: async () => {
        throw new Error("private filesystem detail");
      },
      now: () => NOW,
    });
    await expect(broken.resolve()).resolves.toEqual({ status: "error" });
    expect(JSON.stringify(await broken.inspect())).not.toContain(
      "private filesystem detail",
    );
  });

  it("uses a bounded read-only file open and creates no Pi state", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    writeAuth(authPath, {
      cursor: { type: "api_key", key: "read-only-cursor-token" },
    });
    chmodSync(authPath, 0o400);
    const before = snapshot(authPath);
    const broker = createPiCursorCredentialBroker({
      environment: { HOME: home, PI_CODING_AGENT_DIR: "~/.pi/agent" },
      homeDirectory: () => home,
      now: () => NOW,
    });

    await expect(broker.resolve()).resolves.toMatchObject({
      status: "available",
    });
    expectSnapshotEqual(authPath, before);
    expect(readdirSync(dirname(authPath))).toEqual(["auth.json"]);

    const emptyHome = temporaryDirectory();
    const empty = createPiCursorCredentialBroker({
      environment: { HOME: emptyHome },
      homeDirectory: () => emptyHome,
      now: () => NOW,
    });
    await expect(empty.inspect()).resolves.toMatchObject({ status: "missing" });
    expect(existsSync(join(emptyHome, ".pi"))).toBe(false);
  });

  it("contains no process, browser, Keychain, or mutation path", () => {
    const implementation = readFileSync(
      new URL("../../src/providers/pi-cursor-credential.ts", import.meta.url),
      "utf8",
    );
    expect(implementation).not.toMatch(/child_process|execFile|spawn|security/);
    expect(implementation).not.toMatch(/browser|keychain/i);
    expect(implementation).not.toMatch(/writeFile|rename|chmod|console\./);
    expect(implementation).not.toMatch(/exchange_user_api_key|\/auth\/poll/i);
  });
});

function oauthEntry(overrides: Record<string, unknown> = {}): unknown {
  return {
    cursor: {
      type: "oauth",
      access: "literal-cursor-access",
      refresh: "refresh-must-stay-private",
      expires: FUTURE,
      ...overrides,
    },
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-cursor-"));
  temporaryDirectories.push(directory);
  return directory;
}

function authFixture(value: unknown): string {
  const authPath = join(temporaryDirectory(), "pi", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    authPath,
    typeof value === "string" ? value : JSON.stringify(value),
    { mode: 0o600 },
  );
  return authPath;
}

function brokerFor(authPath: string) {
  return createPiCursorCredentialBroker({
    environment: { PI_CODING_AGENT_DIR: dirname(authPath) },
    homeDirectory: () => dirname(dirname(authPath)),
    now: () => NOW,
  });
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
  expect(snapshot(path)).toEqual(before);
}
