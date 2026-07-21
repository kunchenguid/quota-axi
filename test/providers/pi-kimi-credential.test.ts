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

  it("uses only Pi's supported one-off read and in-memory credential APIs", () => {
    const implementation = readFileSync(
      new URL("../../src/providers/pi-kimi-credential.ts", import.meta.url),
      "utf8",
    );

    expect(implementation).toContain("readStoredCredential(PI_PROVIDER_ID)");
    expect(implementation).toContain("new InMemoryCredentialStore()");
    expect(implementation).not.toMatch(
      /node:fs|auth\.json|readFile|JSON\.parse|writeFile|mkdir|rename|unlink/,
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
    const available = fakeRuntime({ authAvailable: true });
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
    expect(available.getAuth).not.toHaveBeenCalled();
    expect(available.checkAuth).toHaveBeenCalledExactlyOnceWith("kimi-coding");
    expect(unsupported.checkAuth).not.toHaveBeenCalled();
    expectNoModelActivity(available);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-kimi-"));
  temporaryDirectories.push(directory);
  return directory;
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
