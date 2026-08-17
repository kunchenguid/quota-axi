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
import { afterEach, describe, expect, it } from "vitest";
import { createPiZaiCredentialBroker } from "../../src/providers/pi-zai-credential.js";

const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalZaiApiKey = process.env.ZAI_API_KEY;
let temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  if (originalZaiApiKey === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = originalZaiApiKey;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Pi Z.AI credential broker", () => {
  it("resolves a literal zai API key without changing Pi auth state", async () => {
    const fixture = piAuthFixture({
      type: "api_key",
      key: "literal-zai-fixture-key-402",
    });

    await expect(createPiZaiCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      kind: "api_key",
      credential: "literal-zai-fixture-key-402",
    });
    await expect(createPiZaiCredentialBroker().inspect()).resolves.toBe(
      "available",
    );
    expectAuthUnchanged(fixture);
  });

  it("resolves an unexpired OAuth access token", async () => {
    piAuthFixture({
      type: "oauth",
      access: "oauth-zai-fixture-token-771",
      refresh: "oauth-zai-fixture-refresh-771",
      expires: Date.now() + 3_600_000,
    });

    await expect(createPiZaiCredentialBroker().resolve()).resolves.toEqual({
      status: "available",
      kind: "oauth",
      credential: "oauth-zai-fixture-token-771",
    });
  });

  it("reports an expired OAuth record as expired instead of refreshing it", async () => {
    const fixture = piAuthFixture({
      type: "oauth",
      access: "expired-zai-fixture-token-158",
      refresh: "expired-zai-fixture-refresh-158",
      expires: Date.now() - 1_000,
    });

    await expect(createPiZaiCredentialBroker().resolve()).resolves.toEqual({
      status: "expired",
      refreshable: true,
    });
    expectAuthUnchanged(fixture);
  });

  it("reports an unsupported credential type without reading its value", async () => {
    piAuthFixture({ type: "wellknown", key: "unsupported-fixture-key-330" });

    const resolution = await createPiZaiCredentialBroker().resolve();

    expect(resolution).toEqual({ status: "unsupported" });
    expect(JSON.stringify(resolution)).not.toContain(
      "unsupported-fixture-key-330",
    );
  });

  it("does not resolve credentials for unrelated Pi providers", async () => {
    const home = temporaryDirectory();
    const authPath = writeAuth(home, {
      "kimi-coding": { type: "api_key", key: "other-provider-fixture-key-984" },
    });

    const resolution = await createPiZaiCredentialBroker().resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain(
      "other-provider-fixture-key-984",
    );
    expect(readFileSync(authPath, "utf8")).toContain("kimi-coding");
  });

  it("does not resolve environment, template, or command references", async () => {
    const home = temporaryDirectory();
    const markerPath = join(home, "command-ran");
    writeAuth(home, {
      zai: {
        type: "api_key",
        key: `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "bad")`,
        )}`,
      },
    });

    await expect(createPiZaiCredentialBroker().resolve()).resolves.toEqual({
      status: "missing",
    });
    expect(() => statSync(markerPath)).toThrow();
  });

  it("does not fall back to an ambient API key when the Pi auth file is missing", async () => {
    const home = temporaryDirectory();
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    process.env.ZAI_API_KEY = "ambient-zai-fixture-key-615";

    const resolution = await createPiZaiCredentialBroker().resolve();

    expect(resolution).toEqual({ status: "missing" });
    expect(JSON.stringify(resolution)).not.toContain(
      "ambient-zai-fixture-key-615",
    );
  });

  it("treats a malformed auth file as missing rather than throwing", async () => {
    const home = temporaryDirectory();
    const authPath = join(home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(authPath, "{ not json", { mode: 0o600 });
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = dirname(authPath);

    await expect(createPiZaiCredentialBroker().resolve()).resolves.toEqual({
      status: "missing",
    });
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-zai-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAuth(home: string, entries: Record<string, unknown>): string {
  const authPath = join(home, ".pi", "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  writeFileSync(authPath, JSON.stringify(entries), { mode: 0o600 });
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = dirname(authPath);
  delete process.env.ZAI_API_KEY;
  return authPath;
}

function piAuthFixture(entry: Record<string, unknown>): {
  authPath: string;
  before: FileSnapshot;
} {
  const authPath = writeAuth(temporaryDirectory(), { zai: entry });
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

function expectAuthUnchanged(fixture: {
  authPath: string;
  before: FileSnapshot;
}): void {
  const after = snapshot(fixture.authPath);
  expect(after).toEqual(fixture.before);
  expect(readdirSync(dirname(fixture.authPath))).toEqual(["auth.json"]);
}
