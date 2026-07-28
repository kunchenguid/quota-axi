import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCursorCliCredentialSource,
  DEFAULT_CURSOR_CLIENT_VERSION,
} from "../src/providers/cursor-cli-auth.js";

const NOW = 1_800_000_000_000;

// Synthetic, unsigned JWTs (alg: "none") built purely from short fixture
// segments — never a real Cursor session token. See below for the exact
// header/payload used to generate these two fixtures.
//   header: {"alg":"none","typ":"JWT"}
//   payload (expired): {"exp": 1799996400}   -- 3600s before NOW
const EXPIRED_JWT =
  "eyJhbGciOiAibm9uZSIsICJ0eXAiOiAiSldUIn0.eyJleHAiOiAxNzk5OTk2NDAwfQ.fakesig";
// payload (unexpired): {"exp": 1800003600}   -- 3600s after NOW
const UNEXPIRED_JWT =
  "eyJhbGciOiAibm9uZSIsICJ0eXAiOiAiSldUIn0.eyJleHAiOiAxODAwMDAzNjAwfQ.fakesig";

let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-cursor-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAuth(home: string, payload: unknown): string {
  const dir = join(home, ".config", "cursor");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(payload), { mode: 0o600 });
  return path;
}

const noCursorAgent = {
  commandExists: vi.fn(async () => false),
  execFileText: vi.fn(),
};

function fixtureSource(
  overrides: Parameters<typeof createCursorCliCredentialSource>[0] = {},
) {
  return createCursorCliCredentialSource({
    platform: () => "linux",
    now: () => NOW,
    commandExists: noCursorAgent.commandExists,
    execFileText: noCursorAgent.execFileText,
    ...overrides,
  });
}

describe("Cursor CLI credential discovery", () => {
  it("reads accessToken from a valid fixture", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: "opaque-cli-access-token-1" });
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "opaque-cli-access-token-1",
      clientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
    });
  });

  it("ignores refreshToken entirely", async () => {
    const home = temporaryDirectory();
    writeAuth(home, {
      accessToken: "opaque-cli-access-token-2",
      refreshToken: "never-read-this-refresh-token",
    });
    const source = fixtureSource({ environment: { HOME: home } });

    const resolution = await source.resolve();

    expect(resolution).toMatchObject({
      status: "available",
      accessToken: "opaque-cli-access-token-2",
    });
    expect(JSON.stringify(resolution)).not.toContain("refresh");
  });

  it("returns expired for a synthetic JWT with a past exp", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: EXPIRED_JWT });
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({ status: "expired" });
    await expect(source.inspect()).resolves.toBe("expired");
  });

  it("returns available for an unexpired synthetic JWT", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: UNEXPIRED_JWT });
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: UNEXPIRED_JWT,
      clientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
    });
  });

  it("returns available for a non-JWT opaque token (expiry unknown, does not guess)", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: "opaque-token-without-dots" });
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "opaque-token-without-dots",
      clientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
    });
  });

  it("returns missing on absent file", async () => {
    const home = temporaryDirectory();
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({ status: "missing" });
    await expect(source.inspect()).resolves.toBe("missing");
  });

  it("returns invalid on malformed JSON", async () => {
    const home = temporaryDirectory();
    const dir = join(home, ".config", "cursor");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "auth.json"), "{not-json", { mode: 0o600 });
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({ status: "invalid" });
    await expect(source.inspect()).resolves.toBe("invalid");
  });

  it("returns invalid when accessToken is missing or empty", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: "" });
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({ status: "invalid" });
  });

  it("strips ANSI escape sequences from the version string", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: "opaque-cli-access-token-3" });
    const source = fixtureSource({
      environment: { HOME: home },
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => "\x1b[32m2026.07.23-e383d2b\x1b[0m\n"),
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "opaque-cli-access-token-3",
      clientVersion: "2026.07.23-e383d2b",
    });
  });

  it("falls back to the default constant when the version fails charset validation", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: "opaque-cli-access-token-4" });
    const source = fixtureSource({
      environment: { HOME: home },
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => "2026.07.23 e383d2b\nextra line"),
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "opaque-cli-access-token-4",
      clientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
    });
  });

  it("falls back to the default constant when execFileText throws (timeout/crash)", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: "opaque-cli-access-token-5" });
    const source = fixtureSource({
      environment: { HOME: home },
      commandExists: vi.fn(async () => true),
      execFileText: vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "opaque-cli-access-token-5",
      clientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
    });
  });

  it("does not prevent availability when cursor-agent is absent", async () => {
    const home = temporaryDirectory();
    writeAuth(home, { accessToken: "opaque-cli-access-token-6" });
    const source = fixtureSource({
      environment: { HOME: home },
      commandExists: vi.fn(async () => false),
    });

    const resolution = await source.resolve();

    expect(resolution.status).toBe("available");
    expect(resolution).toMatchObject({
      clientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
    });
  });

  it("returns skipped on win32", async () => {
    const source = fixtureSource({
      platform: () => "win32",
      environment: { HOME: "/unused" },
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "skipped",
      reason: "unsupported_platform",
    });
    await expect(source.inspect()).resolves.toBe("skipped");
  });

  it("distinguishes credential I/O failures (EACCES) from a missing file", async () => {
    const source = fixtureSource({
      environment: { HOME: "/synthetic-home" },
      readFile: vi.fn(async () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
      }),
    });

    await expect(source.resolve()).resolves.toEqual({ status: "invalid" });
  });

  it("bounds oversized credential files without returning their contents", async () => {
    const sentinel = "CURSOR-CLI-SENTINEL-471203";
    const readFile = vi.fn(async (_path: string, maxBytes: number) =>
      Buffer.alloc(maxBytes + 1, sentinel),
    );
    const source = fixtureSource({
      environment: { HOME: "/synthetic-home" },
      readFile,
    });

    const resolution = await source.resolve();

    expect(resolution).toEqual({ status: "invalid" });
    expect(JSON.stringify(resolution)).not.toContain(sentinel);
    expect(readFile).toHaveBeenCalledWith(
      "/synthetic-home/.config/cursor/auth.json",
      1024 * 1024,
    );
  });

  it("honours CURSOR_CLI_AUTH_JSON as a full-path override", async () => {
    const home = temporaryDirectory();
    const overridePath = join(home, "custom-cursor-auth.json");
    writeFileSync(
      overridePath,
      JSON.stringify({ accessToken: "opaque-cli-access-token-7" }),
      { mode: 0o600 },
    );
    const source = fixtureSource({
      environment: { CURSOR_CLI_AUTH_JSON: overridePath, HOME: home },
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "opaque-cli-access-token-7",
      clientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
    });
  });

  it("resolves under the lowercase cursor/ directory, distinct from the editor's Cursor/", async () => {
    const home = temporaryDirectory();
    const path = writeAuth(home, { accessToken: "opaque-cli-access-token-8" });

    expect(path).toContain(`${join("", "cursor", "auth.json")}`);
    expect(path).not.toContain(join("Cursor", "User", "globalStorage"));
  });

  it("never contains a real-looking token or JWT in its own source text", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(source).not.toMatch(/ey[A-Za-z0-9_-]{50,}/);
  });
});
