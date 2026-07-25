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
import { createPiKimiCredentialBroker } from "../../src/providers/pi-kimi-credential.js";

const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalKimiApiKey = process.env.KIMI_API_KEY;
let temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  if (originalKimiApiKey === undefined) delete process.env.KIMI_API_KEY;
  else process.env.KIMI_API_KEY = originalKimiApiKey;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Pi Kimi credential broker", () => {
  it("resolves a literal kimi-coding API key from the Pi auth file", async () => {
    const fixture = piAuthFixture("literal-fixture-key-917");

    await expect(createPiKimiCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      apiKey: "literal-fixture-key-917",
    });
    expectAuthUnchanged(fixture);
  });

  it("resolves a synthetic Pi-managed API key without changing Pi auth state", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "api_key",
          key: "runtime-managed-fixture-key-264",
        },
      }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.KIMI_API_KEY;
    const before = snapshot(authPath);
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "runtime-managed-fixture-key-264",
    });
    expectSnapshotEqual(authPath, before);
    expect(readdirSync(home)).toEqual([".pi"]);
    expect(readdirSync(dirname(authPath))).toEqual(["auth.json"]);
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
        "kimi-coding": {
          type: "api_key",
          key: "exact-provider-fixture-key-615",
        },
      }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);

    await expect(createPiKimiCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      apiKey: "exact-provider-fixture-key-615",
    });
    expect(() => statSync(markerPath)).toThrow();
  });

  it("does not use an ambient API key when the Pi auth file is missing", async () => {
    const home = temporaryDirectory();
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    process.env.KIMI_API_KEY = "ambient-environment-fixture-key-742";
    const broker = createPiKimiCredentialBroker();

    const resolution = await broker.resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain(
      "ambient-environment-fixture-key-742",
    );
    expect(JSON.stringify(resolution)).not.toContain("$KIMI_API_KEY");
    expect(readdirSync(home)).toEqual([]);
  });

  it("reports a stored environment reference as missing without resolving it", async () => {
    const fixture = piAuthFixture("${MISSING_KIMI_KEY_FIXTURE_983}");
    process.env.MISSING_KIMI_KEY_FIXTURE_983 = "must-not-be-resolved";
    process.env.KIMI_API_KEY = "ambient-key-must-not-replace-reference";
    const broker = createPiKimiCredentialBroker();

    const resolution = await broker.resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain(
      "MISSING_KIMI_KEY_FIXTURE_983",
    );
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-resolved");
    expect(JSON.stringify(resolution)).not.toContain(
      "ambient-key-must-not-replace-reference",
    );
    expectAuthUnchanged(fixture);
  });

  it("rejects an environment-style key value that is still a reference", async () => {
    const fixture = piAuthFixture("$KIMI_API_KEY");
    process.env.KIMI_API_KEY = "ambient-key-must-not-replace-bad-reference";
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
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
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expect(() => statSync(markerPath)).toThrow();
    expectAuthUnchanged(fixture, ["auth.json"]);
  });

  it.each([
    ["unknown template", "prefix-$KIMI_API_KEY"],
    ["malformed reference", "${KIMI_API_KEY"],
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
      process.env.KIMI_API_KEY = "ambient-key-must-not-replace-bad-reference";
      const broker = createPiKimiCredentialBroker();

      const resolution = await broker.resolve();

      expect(resolution).toEqual({ status: "missing" });
      expect(JSON.stringify(resolution)).not.toContain(key);
      expect(JSON.stringify(resolution)).not.toContain(
        "ambient-key-must-not-replace-bad-reference",
      );
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
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expectSnapshotEqual(authPath, fixture.before);
  });

  it("reports oversized Pi auth files as missing without loading them fully", async () => {
    const oversized = Buffer.alloc(64 * 1024 + 8, 0x61);
    const readFile = vi.fn(async () => oversized);
    const broker = createPiKimiCredentialBroker({
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
    delete process.env.KIMI_API_KEY;
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    await expect(broker.inspect()).resolves.toBe("missing");
    expect(readdirSync(home)).toEqual([]);
  });

  it("leaves auth file bytes, mode, and mtime unchanged after a successful read", async () => {
    const fixture = piAuthFixture("mtime-fixture-key-441");
    const before = snapshot(fixture.authPath);

    await expect(createPiKimiCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      apiKey: "mtime-fixture-key-441",
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
        "kimi-coding": {
          type: "api_key",
          key: "tilde-fixture-key-326",
        },
      }),
      { mode: 0o600 },
    );
    const broker = createPiKimiCredentialBroker({
      environment: {
        HOME: home,
        PI_CODING_AGENT_DIR: "~/.pi/agent",
      },
      homeDirectory: () => home,
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "tilde-fixture-key-326",
    });
  });

  it("expands a Windows tilde Pi agent directory", async () => {
    const home = temporaryDirectory();
    const agentDirectory = join(home, ".pi\\agent");
    const authPath = join(agentDirectory, "auth.json");
    mkdirSync(agentDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "api_key",
          key: "windows-tilde-fixture-key-326",
        },
      }),
      { mode: 0o600 },
    );
    const before = snapshot(authPath);
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");

    try {
      await expect(
        createPiKimiCredentialBroker({
          environment: {
            HOME: home,
            PI_CODING_AGENT_DIR: "~\\.pi\\agent",
          },
          homeDirectory: () => home,
        }).resolve(),
      ).resolves.toEqual({
        status: "available",
        apiKey: "windows-tilde-fixture-key-326",
      });
      expectSnapshotEqual(authPath, before);
    } finally {
      platform.mockRestore();
    }
  });

  it("does not import Pi SDK packages", () => {
    const implementation = readFileSync(
      new URL("../../src/providers/pi-kimi-credential.ts", import.meta.url),
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

  it("does not resolve or refresh a stored non-API-key credential", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "oauth",
          access: "must-not-be-used",
          refresh: "must-not-be-refreshed",
        },
      }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);
    process.env.KIMI_API_KEY = "ambient-must-not-win";
    const before = snapshot(authPath);

    const resolution = await createPiKimiCredentialBroker().resolve();

    expect(resolution).toEqual({ status: "unsupported" });
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-used");
    expect(JSON.stringify(resolution)).not.toContain("must-not-be-refreshed");
    expect(JSON.stringify(resolution)).not.toContain("ambient-must-not-win");
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

    await expect(createPiKimiCredentialBroker().resolve()).resolves.toEqual({
      status: "missing",
    });
  });

  it("reports missing and blank keys without exposing values", async () => {
    for (const key of ["", "   "]) {
      const fixture = piAuthFixture(key);
      const resolution = await createPiKimiCredentialBroker().resolve();
      expect(resolution).toEqual({ status: "missing" });
      expectAuthUnchanged(fixture);
    }
  });

  it("bounds unexpected reader failures", async () => {
    const broker = createPiKimiCredentialBroker({
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
        "kimi-coding": {
          type: "api_key",
          key: "inspection-fixture-key-907",
        },
      }),
      { mode: 0o600 },
    );
    const availableBefore = snapshot(availablePath);

    await expect(
      createPiKimiCredentialBroker({
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
      createPiKimiCredentialBroker({
        environment: {
          HOME: missingHome,
          PI_CODING_AGENT_DIR: join(missingHome, ".pi", "agent"),
        },
        homeDirectory: () => missingHome,
      }).inspect(),
    ).resolves.toBe("missing");
    expect(readdirSync(missingHome)).toEqual([]);

    const unsupportedHome = temporaryDirectory();
    const unsupportedPath = join(unsupportedHome, ".pi", "agent", "auth.json");
    mkdirSync(dirname(unsupportedPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      unsupportedPath,
      JSON.stringify({
        "kimi-coding": { type: "oauth", access: "secret" },
      }),
      { mode: 0o600 },
    );
    await expect(
      createPiKimiCredentialBroker({
        environment: {
          HOME: unsupportedHome,
          PI_CODING_AGENT_DIR: dirname(unsupportedPath),
        },
        homeDirectory: () => unsupportedHome,
      }).inspect(),
    ).resolves.toBe("unsupported");
  });

  it("closes the file descriptor after a bounded read", async () => {
    const fixture = piAuthFixture("descriptor-fixture-key-118");
    const before = snapshot(fixture.authPath);

    await expect(createPiKimiCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      apiKey: "descriptor-fixture-key-118",
    });
    await expect(createPiKimiCredentialBroker().inspect()).resolves.toBe(
      "available",
    );

    expectSnapshotEqual(fixture.authPath, before);
    // A second open after close succeeds when the prior descriptor was released.
    expect(readFileSync(fixture.authPath, "utf8")).toBe(before.bytes);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-kimi-"));
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
      "kimi-coding": { type: "api_key", key },
    }),
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
