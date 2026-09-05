import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiApiKeyCredentialBroker } from "../../src/providers/pi-api-key-credential.js";

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

describe("Pi API-key credential broker", () => {
  it("resolves a literal API key and reports the entry it came from", async () => {
    piAuthFixture({ zai: { type: "api_key", key: "fixture-zai-key-812" } });

    await expect(broker(["zai", "zai-coding-cn"]).resolve()).resolves.toEqual({
      status: "available",
      providerId: "zai",
      credential: "fixture-zai-key-812",
    });
  });

  it("falls through absent entries to later provider ids in order", async () => {
    piAuthFixture({
      "zai-coding-cn": { type: "api_key", key: "fixture-cn-key-463" },
    });

    await expect(broker(["zai", "zai-coding-cn"]).resolve()).resolves.toEqual({
      status: "available",
      providerId: "zai-coding-cn",
      credential: "fixture-cn-key-463",
    });
  });

  it("falls through an unusable entry to a usable later id", async () => {
    piAuthFixture({
      zai: { type: "api_key", key: "${ZAI_API_KEY}" },
      "zai-coding-cn": { type: "api_key", key: "fixture-cn-key-463" },
    });

    await expect(broker(["zai", "zai-coding-cn"]).resolve()).resolves.toEqual({
      status: "available",
      providerId: "zai-coding-cn",
      credential: "fixture-cn-key-463",
    });
  });

  it("falls through an untyped entry to a usable later id", async () => {
    piAuthFixture({
      zai: { key: "fixture-untyped-key-338" },
      "zai-coding-cn": { type: "api_key", key: "fixture-cn-key-463" },
    });

    await expect(broker(["zai", "zai-coding-cn"]).resolve()).resolves.toEqual({
      status: "available",
      providerId: "zai-coding-cn",
      credential: "fixture-cn-key-463",
    });
  });

  it("falls through an unsupported type to a usable later id", async () => {
    piAuthFixture({
      zai: { type: "oauth", access: "fixture-access-184" },
      "zai-coding-cn": { type: "api_key", key: "fixture-cn-key-463" },
    });

    await expect(broker(["zai", "zai-coding-cn"]).resolve()).resolves.toEqual({
      status: "available",
      providerId: "zai-coding-cn",
      credential: "fixture-cn-key-463",
    });
  });

  it("does not resolve credentials for unrelated Pi providers", async () => {
    piAuthFixture({
      unrelated: { type: "api_key", key: "fixture-other-key-771" },
    });

    await expect(broker(["zai"]).resolve()).resolves.toEqual({
      status: "missing",
    });
  });

  it("reports missing when the auth file does not exist", async () => {
    const home = temporaryDirectory();
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;

    await expect(broker(["zai"]).resolve()).resolves.toEqual({
      status: "missing",
    });
    expect(readdirSync(home)).toEqual([]);
  });

  it("reports missing for an entry without a credential type", async () => {
    piAuthFixture({ zai: { key: "fixture-key-295" } });

    await expect(broker(["zai"]).resolve()).resolves.toEqual({
      status: "missing",
    });
  });

  it("reports invalid for a usable-typed entry with no literal key", async () => {
    piAuthFixture({ zai: { type: "api_key", key: "line-one\nline-two" } });

    await expect(broker(["zai"]).resolve()).resolves.toEqual({
      status: "invalid",
      providerId: "zai",
    });
  });

  it("names the responsible entry when a later id holds the unusable key", async () => {
    piAuthFixture({
      "zai-coding-cn": { type: "api_key", key: "${ZAI_CN_KEY}" },
    });

    await expect(broker(["zai", "zai-coding-cn"]).resolve()).resolves.toEqual({
      status: "invalid",
      providerId: "zai-coding-cn",
    });
  });

  it.each([
    ["an environment reference", "${ZAI_API_KEY}"],
    ["a command reference", "!op read op://vault/zai"],
    ["an interpolated literal", "prefix_${SUFFIX}"],
    ["a blank value", "   "],
  ])("rejects a key holding %s without resolving it", async (_label, key) => {
    piAuthFixture({ zai: { type: "api_key", key } });

    await expect(broker(["zai"]).resolve()).resolves.toEqual({
      status: "invalid",
      providerId: "zai",
    });
  });

  it("reports unsupported for non-API-key credential types", async () => {
    piAuthFixture({
      zai: { type: "oauth", access: "fixture-access-184", refresh: "r" },
    });

    await expect(broker(["zai"]).resolve()).resolves.toEqual({
      status: "unsupported",
      providerId: "zai",
    });
  });

  it("reports an unreadable auth file as an error, never an auth verdict", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(authPath, "{}", { mode: 0o600 });
    chmodSync(authPath, 0o000);
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      await expect(broker(["zai"]).resolve()).resolves.toEqual({
        status: "error",
      });
    } finally {
      chmodSync(authPath, 0o600);
    }
  });

  it("reports a malformed auth file as an error", async () => {
    const home = temporaryDirectory();
    const authPath = piDirectory(home);
    mkdirSync(authPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(authPath, "auth.json"), "{broken", { mode: 0o600 });
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;

    await expect(broker(["zai"]).resolve()).resolves.toEqual({
      status: "error",
    });
  });

  it("honors PI_CODING_AGENT_DIR including a ~ home expansion", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, "custom-agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "opencode-go": { type: "api_key", key: "fixture-go-key-993" },
      }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";

    await expect(broker(["opencode-go"]).resolve()).resolves.toEqual({
      status: "available",
      providerId: "opencode-go",
      credential: "fixture-go-key-993",
    });
  });

  it("inspects without exposing credential material", async () => {
    piAuthFixture({ zai: { type: "api_key", key: "fixture-zai-key-812" } });

    await expect(broker(["zai", "zai-coding-cn"]).inspect()).resolves.toEqual({
      status: "available",
      providerId: "zai",
    });
    expect(JSON.stringify(await broker(["zai"]).inspect())).not.toContain(
      "fixture-zai-key-812",
    );
  });

  it("keeps Pi auth state untouched and creates no new files", async () => {
    const home = temporaryDirectory();
    const authPath = join(piDirectory(home), "auth.json");
    mkdirSync(piDirectory(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({ zai: { type: "api_key", key: "fixture-zai-key-812" } }),
      { mode: 0o600 },
    );
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const before = statSync(authPath);

    const brokerUnderTest = broker(["zai", "zai-coding-cn"]);
    await brokerUnderTest.resolve();
    await brokerUnderTest.inspect();

    expect(statSync(authPath).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(home)).toEqual([".pi"]);
    expect(readdirSync(piDirectory(home))).toEqual(["auth.json"]);
  });

  function broker(providerIds: readonly string[]) {
    return createPiApiKeyCredentialBroker(providerIds);
  }

  function piAuthFixture(auth: Record<string, unknown>): void {
    const home = temporaryDirectory();
    const directory = piDirectory(home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "auth.json"), JSON.stringify(auth), {
      mode: 0o600,
    });
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
  }

  function piDirectory(home: string): string {
    return join(home, ".pi", "agent");
  }

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-api-key-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});
