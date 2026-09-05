import {
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
import { createPiMinimaxCredentialBroker } from "../../src/providers/pi-minimax-credential.js";

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

describe("Pi MiniMax credential broker", () => {
  it("resolves a literal minimax-cn API key from the Pi auth file", async () => {
    const fixture = piAuthFixture("literal-fixture-key-917");

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      kind: "api_key",
      credential: "literal-fixture-key-917",
    });
    expectAuthUnchanged(fixture);
  });

  it("does not resolve credentials for unrelated Pi providers", async () => {
    const home = temporaryDirectory();
    const markerPath = join(home, "unrelated-command-ran");
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        unrelated: {
          type: "api_key",
          key: `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "bad")`,
          )}`,
        },
        "minimax-cn": {
          type: "api_key",
          key: "exact-provider-fixture-key-615",
        },
      }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      kind: "api_key",
      credential: "exact-provider-fixture-key-615",
    });
    expect(() => statSync(markerPath)).toThrow();
  });

  it("reports a stored environment reference as missing without resolving it", async () => {
    const fixture = piAuthFixture("${MISSING_MINIMAX_KEY_FIXTURE_983}");
    process.env.MISSING_MINIMAX_KEY_FIXTURE_983 = "must-not-be-resolved";
    const broker = createPiMinimaxCredentialBroker();

    const resolution = await broker.resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain(
      "MISSING_MINIMAX_KEY_FIXTURE_983",
    );
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-resolved");
    expectAuthUnchanged(fixture);
  });

  it("does not execute a stored command reference", async () => {
    const home = temporaryDirectory();
    const scriptPath = join(home, "credential-command.mjs");
    const markerPath = join(home, "credential-command-ran");
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "bad");\n`,
      { mode: 0o600 },
    );
    const fixture = piAuthFixture(
      `!${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      home,
    );
    const broker = createPiMinimaxCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expect(() => statSync(markerPath)).toThrow();
    expectAuthUnchanged(fixture, ["auth.json"]);
  });

  it.each([
    ["unknown template", "prefix-$SOME_VAR"],
    ["malformed reference", "${SOME_VAR"],
    ["empty command", "!   "],
    [
      "failing command",
      `!${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`,
    ],
  ])(
    "rejects a %s without exposing it or executing it",
    async (_label, key) => {
      const home = temporaryDirectory();
      const markerPath = join(home, "reference-side-effect");
      const fixture = piAuthFixture(key, home);
      const broker = createPiMinimaxCredentialBroker();

      const resolution = await broker.resolve();

      expect(resolution).toEqual({ status: "missing" });
      expect(JSON.stringify(resolution)).not.toContain(key);
      expect(() => statSync(markerPath)).toThrow();
      expectAuthUnchanged(fixture);
    },
  );

  it("reports malformed Pi auth state as missing without changing it", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(authPath, "{ malformed", { mode: 0o600 });
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);
    const fixture = { authPath, before: snapshot(authPath) };
    const broker = createPiMinimaxCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expectSnapshotEqual(authPath, fixture.before);
  });

  it("reports oversized Pi auth files as missing without loading them fully", async () => {
    const oversized = Buffer.alloc(64 * 1024 + 8, 0x61);
    const readFile = vi.fn(async () => oversized);
    const broker = createPiMinimaxCredentialBroker({
      environment: {
        HOME: "/synthetic-home",
        PI_CODING_AGENT_DIR: "/synthetic-home/.pi/agent",
      },
      homeDirectory: () => "/synthetic-home",
      readFile,
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls[0][1]).toBe(64 * 1024);
  });

  it("treats a missing auth file and empty home as missing without creating state", async () => {
    const home = temporaryDirectory();
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const broker = createPiMinimaxCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    await expect(broker.inspect()).resolves.toBe("missing");
    expect(readdirSync(home)).toEqual([]);
  });

  it("leaves auth file bytes, mode, and mtime unchanged after a successful read", async () => {
    const fixture = piAuthFixture("mtime-fixture-key-441");
    const before = snapshot(fixture.authPath);

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      kind: "api_key",
      credential: "mtime-fixture-key-441",
    });

    expectSnapshotEqual(fixture.authPath, before);
  });

  it("uses PI_CODING_AGENT_DIR with safe tilde expansion", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "minimax-cn": {
          type: "api_key",
          key: "tilde-fixture-key-326",
        },
      }),
      { mode: 0o600 },
    );
    const broker = createPiMinimaxCredentialBroker({
      environment: {
        HOME: home,
        PI_CODING_AGENT_DIR: "~/.pi/agent",
      },
      homeDirectory: () => home,
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      kind: "api_key",
      credential: "tilde-fixture-key-326",
    });
  });

  it("does not import Pi SDK packages", () => {
    const implementation = readFileSync(
      new URL("../../src/providers/pi-minimax-credential.ts", import.meta.url),
      "utf8",
    );
    const packageJson = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );

    expect(implementation).not.toMatch(/@earendil-works\/pi-/);
    expect(implementation).not.toContain("ModelRuntime");
    expect(implementation).not.toContain("InMemoryCredentialStore");
    expect(implementation).not.toContain("readStoredCredential");
    expect(packageJson).not.toMatch(/@earendil-works\/pi-/);
    expect(implementation).toContain('open(path, "r")');
  });

  it("resolves a stored OAuth access token without refreshing it", async () => {
    const fixture = piOauthFixture({
      access: "pi-oauth-fixture-access-538",
      refresh: "must-not-be-refreshed",
      expires: Date.now() + 3_600_000,
    });

    const resolution = await createPiMinimaxCredentialBroker().resolve();

    expect(resolution).toEqual({
      status: "available",
      kind: "oauth",
      credential: "pi-oauth-fixture-access-538",
    });
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-refreshed");
    expectSnapshotEqual(fixture.authPath, fixture.before);
  });

  it("accepts an OAuth record with no stored expiry", async () => {
    const fixture = piOauthFixture({
      access: "pi-oauth-no-expiry-241",
      refresh: "must-not-be-refreshed",
    });

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      kind: "oauth",
      credential: "pi-oauth-no-expiry-241",
    });
    expectSnapshotEqual(fixture.authPath, fixture.before);
  });

  it("reports an expired OAuth record as expired instead of refreshing it", async () => {
    const fixture = piOauthFixture({
      access: "pi-oauth-expired-access-770",
      refresh: "must-not-be-refreshed",
      expires: Date.now() - 1_000,
    });

    const resolution = await createPiMinimaxCredentialBroker().resolve();

    expect(resolution).toEqual({
      status: "expired",
      refreshable: true,
      credential: "pi-oauth-expired-access-770",
    });
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-refreshed");
    await expect(createPiMinimaxCredentialBroker().inspect()).resolves.toBe(
      "expired",
    );
    expectSnapshotEqual(fixture.authPath, fixture.before);
  });

  it("reports an expired OAuth record with no refresh token as unrefreshable", async () => {
    piOauthFixture({
      access: "pi-oauth-terminal-access-119",
      expires: Date.now() - 1_000,
    });

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "expired",
      refreshable: false,
      credential: "pi-oauth-terminal-access-119",
    });
  });

  it.each([
    ["absent access token", { refresh: "r", expires: Date.now() + 3_600_000 }],
    ["environment reference", { access: "$SOME_OAUTH_ACCESS" }],
    ["unparseable expiry", { access: "usable-access", expires: "soon" }],
  ])("reports an OAuth record with an %s as missing", async (_label, entry) => {
    const fixture = piOauthFixture(entry);

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "missing",
    });
    expectSnapshotEqual(fixture.authPath, fixture.before);
  });

  it("does not resolve a credential type it does not understand", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "minimax-cn": {
          type: "device_code",
          access: "must-not-be-used",
          refresh: "must-not-be-refreshed",
        },
      }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);
    const before = snapshot(authPath);

    const resolution = await createPiMinimaxCredentialBroker().resolve();

    expect(resolution).toEqual({ status: "unsupported" });
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-used");
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-refreshed");
    expectSnapshotEqual(authPath, before);
  });

  it("ignores credential metadata for every other Pi provider", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "another-provider": { type: "oauth", access: "other" },
        "unrelated-provider": {
          type: "api_key",
          key: "unrelated-literal-key",
        },
      }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "missing",
    });
  });

  it("reports missing and blank keys without exposing values", async () => {
    for (const key of ["", "   "]) {
      const fixture = piAuthFixture(key);
      const resolution = await createPiMinimaxCredentialBroker().resolve();
      expect(resolution).toEqual({ status: "missing" });
      expectAuthUnchanged(fixture);
    }
  });

  it("bounds unexpected reader failures", async () => {
    const broker = createPiMinimaxCredentialBroker({
      environment: { HOME: "/synthetic-home" },
      homeDirectory: () => "/synthetic-home",
      readFile: async () => {
        throw new Error("private reader details");
      },
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "error" });
    await expect(broker.inspect()).resolves.toBe("error");
  });

  it("inspects only availability and credential type", async () => {
    const availableHome = temporaryDirectory();
    const availablePath = join(availableHome, ".pi", "agent", "auth.json");
    mkdirSync(dirname(availablePath), { recursive: true, mode: 0o700 });
    writeFileSync(
      availablePath,
      JSON.stringify({
        "minimax-cn": {
          type: "api_key",
          key: "inspection-fixture-key-907",
        },
      }),
      { mode: 0o600 },
    );
    const availableBefore = snapshot(availablePath);

    await expect(
      createPiMinimaxCredentialBroker({
        environment: {
          HOME: availableHome,
          PI_CODING_AGENT_DIR: dirname(availablePath),
        },
        homeDirectory: () => availableHome,
      }).inspect(),
    ).resolves.toBe("available");
    expectSnapshotEqual(availablePath, availableBefore);

    const missingHome = temporaryDirectory();
    await expect(
      createPiMinimaxCredentialBroker({
        environment: {
          HOME: missingHome,
          PI_CODING_AGENT_DIR: join(missingHome, ".pi", "agent"),
        },
        homeDirectory: () => missingHome,
      }).inspect(),
    ).resolves.toBe("missing");
    expect(readdirSync(missingHome)).toEqual([]);
  });

  it("closes the file descriptor after a bounded read", async () => {
    const fixture = piAuthFixture("descriptor-fixture-key-118");
    const before = snapshot(fixture.authPath);

    await expect(createPiMinimaxCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      kind: "api_key",
      credential: "descriptor-fixture-key-118",
    });
    await expect(createPiMinimaxCredentialBroker().inspect()).resolves.toBe(
      "available",
    );

    expectSnapshotEqual(fixture.authPath, before);
    expect(readFileSync(fixture.authPath, "utf8")).toBe(before.bytes);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-minimax-"));
  temporaryDirectories.push(directory);
  return directory;
}

function piAuthFixture(
  key: string,
  existingHome?: string,
): { authPath: string; before: FileSnapshot } {
  const home = existingHome ?? temporaryDirectory();
  const authPath = join(home, ".pi", "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    authPath,
    JSON.stringify({
      "minimax-cn": { type: "api_key", key },
    }),
    { mode: 0o600 },
  );
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = dirname(authPath);
  return { authPath, before: snapshot(authPath) };
}

function piOauthFixture(entry: Record<string, unknown>): {
  authPath: string;
  before: FileSnapshot;
} {
  const home = temporaryDirectory();
  const authPath = join(home, ".pi", "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    authPath,
    JSON.stringify({ "minimax-cn": { type: "oauth", ...entry } }),
    { mode: 0o600 },
  );
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = dirname(authPath);
  return { authPath, before: snapshot(authPath) };
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
  expect(after.bytes).toBe(before.bytes);
  expect(after.mode).toBe(before.mode);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBe(before.size);
}

function expectAuthUnchanged(
  fixture: { authPath: string; before: FileSnapshot },
  expectedFiles: string[] = ["auth.json"],
): void {
  expectSnapshotEqual(fixture.authPath, fixture.before);
  expect(readdirSync(dirname(fixture.authPath))).toEqual(expectedFiles);
}
