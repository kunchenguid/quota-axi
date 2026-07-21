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
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiKimiCredentialBroker } from "../../src/providers/pi-kimi-credential.js";

const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalKimiApiKey = process.env.KIMI_API_KEY;
const originalMissingKimiKey = process.env.MISSING_KIMI_KEY_FIXTURE_983;
let temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  if (originalKimiApiKey === undefined) delete process.env.KIMI_API_KEY;
  else process.env.KIMI_API_KEY = originalKimiApiKey;
  if (originalMissingKimiKey === undefined)
    delete process.env.MISSING_KIMI_KEY_FIXTURE_983;
  else process.env.MISSING_KIMI_KEY_FIXTURE_983 = originalMissingKimiKey;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

type FakeRuntime = {
  listCredentials: ReturnType<typeof vi.fn>;
  getAuth: ReturnType<typeof vi.fn>;
  checkAuth: ReturnType<typeof vi.fn>;
  refreshModels: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
};

describe("Pi Kimi credential broker", () => {
  it("resolves a managed API key through only the kimi-coding Pi provider", async () => {
    const runtime = fakeRuntime({
      credentials: [{ providerId: "kimi-coding", type: "api_key" }],
      apiKey: "managed-fixture-key-917",
    });
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () => runtime,
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "managed-fixture-key-917",
    });
    expect(runtime.listCredentials).toHaveBeenCalledTimes(1);
    expect(runtime.getAuth).toHaveBeenCalledExactlyOnceWith("kimi-coding");
    expectNoModelActivity(runtime);
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
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);
    delete process.env.KIMI_API_KEY;
    const before = readFileSync(authPath, "utf8");
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "runtime-managed-fixture-key-264",
    });
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
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

  it("resolves the official environment API key through Pi", async () => {
    const home = temporaryDirectory();
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    process.env.KIMI_API_KEY = "environment-reference-fixture-key-742";
    const broker = createPiKimiCredentialBroker();

    const resolution = await broker.resolve();

    expect(resolution).toEqual({
      status: "available",
      apiKey: "environment-reference-fixture-key-742",
    });
    expect(JSON.stringify(resolution)).not.toContain("$KIMI_API_KEY");
    expect(readdirSync(home)).toEqual([]);
  });

  it("reports a missing stored environment reference without transmitting it", async () => {
    const fixture = piAuthFixture("${MISSING_KIMI_KEY_FIXTURE_983}");
    delete process.env.MISSING_KIMI_KEY_FIXTURE_983;
    delete process.env.KIMI_API_KEY;
    const broker = createPiKimiCredentialBroker();

    const resolution = await broker.resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain(
      "MISSING_KIMI_KEY_FIXTURE_983",
    );
    expectPiAuthUnchanged(fixture);
  });

  it("rejects an environment value that is still a reference", async () => {
    const fixture = piAuthFixture("$KIMI_API_KEY");
    process.env.KIMI_API_KEY = "$STILL_UNRESOLVED_KIMI_KEY";
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expectPiAuthUnchanged(fixture);
  });

  it("does not execute a stored command reference itself", async () => {
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
    expectPiAuthUnchanged(fixture, ["auth.json"]);
  });

  it.each([
    ["unknown template", "prefix-$KIMI_API_KEY"],
    ["malformed reference", "${KIMI_API_KEY"],
    ["empty command", "!   "],
    [
      "failing command",
      `!${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`,
    ],
  ])("rejects a %s without exposing it", async (_label, key) => {
    const fixture = piAuthFixture(key);
    process.env.KIMI_API_KEY = "ambient-key-must-not-replace-bad-reference";
    const broker = createPiKimiCredentialBroker();

    const resolution = await broker.resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain(key);
    expectPiAuthUnchanged(fixture);
  });

  it("reports malformed Pi auth state as missing without changing it", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(authPath, "{ malformed", { mode: 0o600 });
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);
    const fixture = { authPath, before: readFileSync(authPath, "utf8") };
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expectPiAuthUnchanged(fixture);
  });

  it("resolves a managed API key through the real network-disabled Pi runtime", async () => {
    const credential = {
      type: "api_key" as const,
      key: "runtime-managed-fixture-key-691",
    };
    const credentials = {
      read: vi.fn(async (providerId: string) =>
        providerId === "kimi-coding" ? credential : undefined,
      ),
      list: vi.fn(async () => [
        { providerId: "kimi-coding", type: "api_key" as const },
      ]),
      modify: vi.fn(async () => credential),
      delete: vi.fn(async () => undefined),
    };
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () =>
        ModelRuntime.create({
          credentials,
          allowModelNetwork: false,
          modelsPath: null,
        }),
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "runtime-managed-fixture-key-691",
    });
    expect(credentials.modify).not.toHaveBeenCalled();
    expect(credentials.delete).not.toHaveBeenCalled();
  });

  it("lets Pi resolve its environment API key without reading environment variables itself", async () => {
    const runtime = fakeRuntime({ apiKey: "environment-fixture-key-483" });
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () => runtime,
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "environment-fixture-key-483",
    });
    expect(runtime.listCredentials).toHaveBeenCalledTimes(1);
    expect(runtime.getAuth).toHaveBeenCalledExactlyOnceWith("kimi-coding");
    expectNoModelActivity(runtime);
  });

  it("resolves an environment API key through the real Pi runtime", async () => {
    process.env.KIMI_API_KEY = "runtime-environment-fixture-key-851";
    const credentials = {
      read: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      modify: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () =>
        ModelRuntime.create({
          credentials,
          allowModelNetwork: false,
          modelsPath: null,
        }),
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "runtime-environment-fixture-key-851",
    });
    expect(credentials.modify).not.toHaveBeenCalled();
    expect(credentials.delete).not.toHaveBeenCalled();
  });

  it("uses Pi's environment resolution without creating Pi auth state", async () => {
    const home = temporaryDirectory();
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    process.env.KIMI_API_KEY = "runtime-environment-fixture-key-357";
    const broker = createPiKimiCredentialBroker();

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "runtime-environment-fixture-key-357",
    });
    expect(readdirSync(home)).toEqual([]);
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
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = "~\\.pi\\agent";
    const before = readFileSync(authPath, "utf8");
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");

    try {
      await expect(createPiKimiCredentialBroker().resolve()).resolves.toEqual({
        status: "available",
        apiKey: "windows-tilde-fixture-key-326",
      });
      expect(readFileSync(authPath, "utf8")).toBe(before);
    } finally {
      platform.mockRestore();
    }
  });

  it("uses Pi's supported one-off read and public runtime APIs", () => {
    const implementation = readFileSync(
      new URL("../../src/providers/pi-kimi-credential.ts", import.meta.url),
      "utf8",
    );

    expect(implementation).toContain("new InMemoryCredentialStore()");
    expect(implementation).toContain("readStoredCredential(");
    expect(implementation).not.toMatch(
      /dist\/core|AuthStorage|import\.meta\.resolve|JSON\.parse|readFileSync/,
    );
  });

  it("ignores resolver-provided base URLs and arbitrary headers", async () => {
    const runtime = fakeRuntime({
      apiKey: "managed-fixture-key-532",
      authExtras: {
        baseUrl: "https://untrusted.invalid",
        headers: { "x-untrusted": "private" },
      },
    });
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () => runtime,
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      apiKey: "managed-fixture-key-532",
    });
  });

  it("does not resolve or refresh a stored non-API-key credential", async () => {
    const runtime = fakeRuntime({
      credentials: [{ providerId: "kimi-coding", type: "oauth" }],
    });
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () => runtime,
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "unsupported",
    });
    expect(runtime.getAuth).not.toHaveBeenCalled();
    expectNoModelActivity(runtime);
  });

  it("ignores credential metadata for every other Pi provider", async () => {
    const runtime = fakeRuntime({
      credentials: [
        { providerId: "another-provider", type: "oauth" },
        { providerId: "unrelated-provider", type: "api_key" },
      ],
    });
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () => runtime,
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    expect(runtime.getAuth).toHaveBeenCalledExactlyOnceWith("kimi-coding");
  });

  it("reports missing and blank keys without exposing values", async () => {
    for (const apiKey of [undefined, "   "]) {
      const runtime = fakeRuntime({ apiKey });
      const broker = createPiKimiCredentialBroker({
        loadRuntime: async () => runtime,
      });
      await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
    }
  });

  it("bounds unexpected resolver failures", async () => {
    const broker = createPiKimiCredentialBroker({
      loadRuntime: async () => {
        throw new Error("private resolver details");
      },
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "error" });
    await expect(broker.inspect()).resolves.toBe("error");
  });

  it("inspects only availability and credential type", async () => {
    const available = fakeRuntime({ apiKey: "inspection-fixture-key-907" });
    const missing = fakeRuntime({ authAvailable: false });
    const unsupported = fakeRuntime({
      credentials: [{ providerId: "kimi-coding", type: "oauth" }],
    });

    await expect(
      createPiKimiCredentialBroker({
        loadRuntime: async () => available,
      }).inspect(),
    ).resolves.toBe("available");
    await expect(
      createPiKimiCredentialBroker({
        loadRuntime: async () => missing,
      }).inspect(),
    ).resolves.toBe("missing");
    await expect(
      createPiKimiCredentialBroker({
        loadRuntime: async () => unsupported,
      }).inspect(),
    ).resolves.toBe("unsupported");
    expect(available.getAuth).toHaveBeenCalledExactlyOnceWith("kimi-coding");
    expect(available.checkAuth).not.toHaveBeenCalled();
    expect(unsupported.getAuth).not.toHaveBeenCalled();
    expectNoModelActivity(available);
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
): { authPath: string; before: string } {
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
  return { authPath, before: readFileSync(authPath, "utf8") };
}

function expectPiAuthUnchanged(
  fixture: { authPath: string; before: string },
  expectedFiles: string[] = ["auth.json"],
): void {
  expect(readFileSync(fixture.authPath, "utf8")).toBe(fixture.before);
  expect(statSync(fixture.authPath).mode & 0o777).toBe(0o600);
  expect(readdirSync(dirname(fixture.authPath))).toEqual(expectedFiles);
}

function fakeRuntime(options: {
  credentials?: Array<{ providerId: string; type: string }>;
  apiKey?: string;
  authAvailable?: boolean;
  authExtras?: { baseUrl?: string; headers?: Record<string, string> };
}): FakeRuntime {
  return {
    listCredentials: vi.fn(async () => options.credentials ?? []),
    getAuth: vi.fn(async () =>
      options.apiKey
        ? {
            auth: { apiKey: options.apiKey, ...options.authExtras },
            source: "synthetic",
          }
        : undefined,
    ),
    checkAuth: vi.fn(async () =>
      options.authAvailable ? { type: "api_key" } : undefined,
    ),
    refreshModels: vi.fn(() => {
      throw new Error("model catalog refresh must not run");
    }),
    complete: vi.fn(() => {
      throw new Error("model inference must not run");
    }),
    stream: vi.fn(() => {
      throw new Error("model inference must not run");
    }),
  };
}

function expectNoModelActivity(runtime: FakeRuntime): void {
  expect(runtime.refreshModels).not.toHaveBeenCalled();
  expect(runtime.complete).not.toHaveBeenCalled();
  expect(runtime.stream).not.toHaveBeenCalled();
}
