import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiXaiCredentialBroker } from "../../src/providers/pi-xai-credential.js";

const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
let temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Pi xAI credential broker", () => {
  it("reads oauth credentials from the default Pi agent auth file", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    writeAuth(authPath, {
      xai: {
        type: "oauth",
        access: "fixture-access-token",
        refresh: "fixture-refresh-token",
        expires: Date.now() + 3_600_000,
      },
    });
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;

    const broker = createPiXaiCredentialBroker({
      environment: process.env,
      homeDirectory: () => home,
    });
    const resolution = await broker.resolve();
    const inspection = await broker.inspect();

    expect(resolution).toEqual({
      status: "available",
      kind: "oauth",
      credential: "fixture-access-token",
    });
    expect(inspection).toEqual({ status: "available" });
    expect(JSON.stringify(inspection)).not.toContain("fixture-access-token");
    expect(readdirSync(dirname(authPath))).toEqual(["auth.json"]);
  });

  it("accepts literal api_key credentials", async () => {
    const fixture = piAuthFixture({
      type: "api_key",
      key: "literal-xai-api-key",
    });
    const broker = createPiXaiCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: dirname(fixture) },
      homeDirectory: () => temporaryDirectory(),
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      kind: "api_key",
      credential: "literal-xai-api-key",
    });
  });

  it("classifies expired oauth with refresh as expired refreshable", async () => {
    const fixture = piAuthFixture({
      type: "oauth",
      access: "expired-access",
      refresh: "still-present-refresh",
      expires: Date.now() - 1_000,
    });
    const broker = createPiXaiCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: dirname(fixture) },
      homeDirectory: () => temporaryDirectory(),
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "expired",
      refreshable: true,
      credential: "expired-access",
    });
    // Inspection reports classification only, never the probe credential.
    await expect(broker.inspect()).resolves.toEqual({
      status: "expired",
      refreshable: true,
    });
  });

  it("classifies expired oauth without refresh as non-refreshable", async () => {
    const fixture = piAuthFixture({
      type: "oauth",
      access: "expired-access",
      expires: Date.now() - 1_000,
    });
    const broker = createPiXaiCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: dirname(fixture) },
      homeDirectory: () => temporaryDirectory(),
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "expired",
      refreshable: false,
      credential: "expired-access",
    });
  });

  it.each([" ", "$REFRESH_TOKEN", "!op read refresh", "refresh\u0000token"])(
    "rejects unusable refresh credential %s",
    async (refresh) => {
      const fixture = piAuthFixture({
        type: "oauth",
        access: "expired-access",
        refresh,
        expires: Date.now() - 1_000,
      });
      const broker = createPiXaiCredentialBroker({
        environment: { PI_CODING_AGENT_DIR: dirname(fixture) },
        homeDirectory: () => temporaryDirectory(),
      });

      await expect(broker.resolve()).resolves.toEqual({
        status: "expired",
        refreshable: false,
        credential: "expired-access",
      });
    },
  );

  it("classifies malformed JSON as invalid", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, "{not-json", { mode: 0o600 });
    const broker = createPiXaiCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: dirname(authPath) },
      homeDirectory: () => home,
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "invalid" });
    await expect(broker.inspect()).resolves.toEqual({
      status: "invalid",
      error: "invalid_credential",
    });
  });

  it.each([null, "not-a-timestamp", {}, Number.NaN])(
    "rejects malformed oauth expiry %s",
    async (expires) => {
      const fixture = piAuthFixture({
        type: "oauth",
        access: "fixture-access",
        expires,
      });
      const broker = createPiXaiCredentialBroker({
        environment: { PI_CODING_AGENT_DIR: dirname(fixture) },
        homeDirectory: () => temporaryDirectory(),
      });

      await expect(broker.resolve()).resolves.toEqual({ status: "invalid" });
    },
  );

  it("rejects environment and command references without resolving them", async () => {
    for (const key of ["$XAI_API_KEY", "!op read secret"]) {
      const fixture = piAuthFixture({ type: "api_key", key });
      const broker = createPiXaiCredentialBroker({
        environment: {
          PI_CODING_AGENT_DIR: dirname(fixture),
          XAI_API_KEY: "ambient-must-not-resolve",
        },
        homeDirectory: () => temporaryDirectory(),
      });
      await expect(broker.resolve()).resolves.toEqual({ status: "invalid" });
      expect(readFileSync(fixture, "utf8")).toContain(key);
    }
  });

  it("ignores unrelated Pi providers and ambient env keys", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    writeAuth(authPath, {
      anthropic: { type: "api_key", key: "not-xai" },
      "kimi-coding": { type: "api_key", key: "not-xai-either" },
    });
    const broker = createPiXaiCredentialBroker({
      environment: {
        PI_CODING_AGENT_DIR: dirname(authPath),
        XAI_API_KEY: "ambient-xai-key",
      },
      homeDirectory: () => home,
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "missing" });
  });

  it("marks unsupported credential types without treating them as missing", async () => {
    const fixture = piAuthFixture({
      type: "device_code",
      access: "device-access",
    });
    const broker = createPiXaiCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: dirname(fixture) },
      homeDirectory: () => temporaryDirectory(),
    });

    await expect(broker.resolve()).resolves.toEqual({ status: "unsupported" });
    await expect(broker.inspect()).resolves.toEqual({
      status: "unsupported",
      error: "unsupported_credential_type",
    });
  });

  it("does not implement Pi packages or write auth files", async () => {
    const implementation = readFileSync(
      new URL("../../src/providers/pi-xai-credential.ts", import.meta.url),
      "utf8",
    );
    expect(implementation).not.toMatch(/@earendil-works\/pi-/);
    expect(implementation).not.toMatch(/writeFile|rename|chmod/);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-xai-"));
  temporaryDirectories.push(directory);
  return directory;
}

function piAuthFixture(entry: Record<string, unknown>): string {
  const home = temporaryDirectory();
  const authPath = join(home, ".pi", "agent", "auth.json");
  writeAuth(authPath, { xai: entry });
  return authPath;
}

function writeAuth(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}
