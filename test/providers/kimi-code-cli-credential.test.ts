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
import { createKimiCodeCliCredentialSource } from "../../src/providers/kimi-code-cli-credential.js";

const NOW = 1_800_000_000_000;
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Kimi Code CLI credential discovery", () => {
  it("reads the official default location under HOME", async () => {
    const home = temporaryDirectory();
    writeCredential(home, {
      access_token: "default-home-token",
      refresh_token: "ignored-refresh-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: home },
      homeDirectory: () => "/unused-system-home",
      now: () => NOW,
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "default-home-token",
    });
  });

  it("prefers KIMI_CODE_HOME over the default home", async () => {
    const home = temporaryDirectory();
    const override = temporaryDirectory();
    writeCredential(home, {
      access_token: "wrong-default-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    writeCredential(override, {
      access_token: "override-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: home, KIMI_CODE_HOME: override },
      now: () => NOW,
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "override-token",
    });
  });

  it("distinguishes missing, malformed, expired, and near-expiry credentials", async () => {
    const cases: Array<{
      payload?: unknown;
      raw?: string;
      status: "missing" | "invalid" | "expired";
    }> = [
      { status: "missing" },
      { raw: "{not-json", status: "invalid" },
      { payload: [], status: "invalid" },
      {
        payload: { access_token: "", expires_at: NOW / 1_000 + 3_600 },
        status: "invalid",
      },
      { payload: { access_token: "token" }, status: "invalid" },
      {
        payload: { access_token: "token", expires_at: "not-an-expiry" },
        status: "invalid",
      },
      {
        payload: { access_token: "token", expires_at: NOW / 1_000 - 1 },
        status: "expired",
      },
      {
        payload: { access_token: "token", expires_at: NOW / 1_000 + 60 },
        status: "expired",
      },
    ];

    for (const fixture of cases) {
      const home = temporaryDirectory();
      if (fixture.raw !== undefined) writeCredentialRaw(home, fixture.raw);
      else if (fixture.payload !== undefined)
        writeCredential(home, fixture.payload);
      const source = createKimiCodeCliCredentialSource({
        environment: { KIMI_CODE_HOME: home },
        now: () => NOW,
      });

      await expect(source.resolve()).resolves.toEqual({
        status: fixture.status,
      });
      await expect(source.inspect()).resolves.toBe(fixture.status);
    }
  });

  it.each([
    NOW / 1_000 + 3_600.5,
    String(NOW / 1_000 + 3_600),
    `+${NOW / 1_000 + 3_600}`,
    "1.8000036e9",
  ])("accepts official numeric expiry encoding %s", async (expiresAt) => {
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: "/synthetic-home" },
      now: () => NOW,
      readTextFile: vi.fn(async () =>
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: { deliberately: "not consumed" },
          expires_at: expiresAt,
        }),
      ),
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "fresh-token",
    });
  });

  it("performs only a read and leaves credential storage unchanged", async () => {
    const home = temporaryDirectory();
    const credential = writeCredential(home, {
      access_token: "read-only-token",
      refresh_token: "never-use-this-refresh-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    const unrelated = join(home, "device_id");
    writeFileSync(unrelated, "existing-device-id\n", { mode: 0o600 });
    const before = snapshotTree(home);
    const source = createKimiCodeCliCredentialSource({
      environment: { KIMI_CODE_HOME: home },
      now: () => NOW,
    });

    await source.resolve();

    expect(snapshotTree(home)).toEqual(before);
    expect(readFileSync(credential, "utf8")).toContain(
      "never-use-this-refresh-token",
    );
    expect(readdirSync(home).sort()).toEqual(["credentials", "device_id"]);
  });

  it("has no credential-write, process-launch, refresh, or Pi-auth surface", () => {
    const implementation = readFileSync(
      new URL(
        "../../src/providers/kimi-code-cli-credential.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(implementation).not.toMatch(
      /node:child_process|\b(?:spawn|execFile|writeFile|mkdir|rename|unlink)\b|refresh_token|device_id|\.pi\/agent\/auth\.json/,
    );
  });

  it("bounds malformed credential files without returning their contents", async () => {
    const sentinel = "CLI-CREDENTIAL-SENTINEL-938475";
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: "/synthetic-home" },
      now: () => NOW,
      readTextFile: vi.fn(async () => sentinel.repeat(3_000)),
    });

    const resolution = await source.resolve();

    expect(resolution).toEqual({ status: "invalid" });
    expect(JSON.stringify(resolution)).not.toContain(sentinel);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-kimi-code-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeCredential(home: string, payload: unknown): string {
  return writeCredentialRaw(home, JSON.stringify(payload));
}

function writeCredentialRaw(home: string, raw: string): string {
  const path = join(home, "credentials", "kimi-code.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, raw, { mode: 0o600 });
  return path;
}

function snapshotTree(root: string): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  visit(root, "", snapshot);
  return snapshot;
}

function visit(
  root: string,
  relative: string,
  snapshot: Record<string, unknown>,
): void {
  const directory = join(root, relative);
  for (const name of readdirSync(directory).sort()) {
    const childRelative = join(relative, name);
    const path = join(root, childRelative);
    const stat = statSync(path);
    snapshot[childRelative] = {
      type: stat.isDirectory() ? "directory" : "file",
      mode: stat.mode & 0o777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { content: readFileSync(path, "utf8") } : {}),
    };
    if (stat.isDirectory()) visit(root, childRelative, snapshot);
  }
}
