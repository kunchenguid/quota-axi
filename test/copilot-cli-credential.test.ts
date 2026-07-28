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
import { createCopilotCliCredentialSource } from "../src/providers/copilot-cli-credential.js";

// Deliberately short fake tokens: real GitHub OAuth tokens are 36+ chars
// after the "gho_" prefix, so these never match a `gho_[A-Za-z0-9]{20,}`
// secret-scan pattern while still exercising the parsing/selection logic.
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-copilot-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConfig(home: string, raw: string): string {
  const dir = join(home, ".copilot");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  writeFileSync(path, raw, { mode: 0o600 });
  return path;
}

function fixtureSource(
  overrides: Parameters<typeof createCopilotCliCredentialSource>[0] = {},
) {
  return createCopilotCliCredentialSource({
    platform: () => "linux",
    ...overrides,
  });
}

describe("GitHub Copilot CLI credential discovery", () => {
  it("strips leading // comment lines and parses successfully", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      [
        "// User settings belong in settings.json.",
        "// This file is managed automatically.",
        JSON.stringify({
          lastLoggedInUser: { host: "https://github.com", login: "octocat" },
          copilotTokens: {
            "https://github.com:octocat": "gho_fakeComment1",
          },
        }),
      ].join("\n"),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      oauthToken: "gho_fakeComment1",
      login: "octocat",
      host: "github.com",
    });
  });

  it("preserves https:// inside the copilotTokens key (regression guard)", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      JSON.stringify({
        lastLoggedInUser: { host: "https://github.com", login: "adibirzu" },
        copilotTokens: {
          "https://github.com:adibirzu": "gho_fakeUrlKey2",
        },
      }),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    const resolution = await source.resolve();

    expect(resolution).toEqual({
      status: "available",
      oauthToken: "gho_fakeUrlKey2",
      login: "adibirzu",
      host: "github.com",
    });
  });

  it("selects the lastLoggedInUser entry when multiple tokens exist", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      JSON.stringify({
        lastLoggedInUser: {
          host: "https://ghe.example.test",
          login: "enterprise-user",
        },
        copilotTokens: {
          "https://github.com:public-user": "gho_fakePublic3",
          "https://ghe.example.test:enterprise-user": "gho_fakeEnt3",
        },
      }),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      oauthToken: "gho_fakeEnt3",
      login: "enterprise-user",
      host: "ghe.example.test",
    });
  });

  it("falls back to the github.com entry when lastLoggedInUser is absent", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      JSON.stringify({
        copilotTokens: {
          "https://ghe.example.test:enterprise-user": "gho_fakeEnt4",
          "https://github.com:public-user": "gho_fakePublic4",
        },
      }),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      oauthToken: "gho_fakePublic4",
      login: "public-user",
      host: "github.com",
    });
  });

  it("returns invalid on ambiguous multi-host with no github.com entry", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      JSON.stringify({
        copilotTokens: {
          "https://ghe-one.example.test:user-one": "gho_fakeOne5",
          "https://ghe-two.example.test:user-two": "gho_fakeTwo5",
        },
      }),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({ status: "invalid" });
  });

  it("returns missing when the file is absent", async () => {
    const home = temporaryDirectory();
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({ status: "missing" });
    await expect(source.inspect()).resolves.toBe("missing");
  });

  it("returns invalid (never throws) on malformed JSON", async () => {
    const home = temporaryDirectory();
    writeConfig(home, "// leading comment\n{not-json-at-all");
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "invalid",
      reason: "cli_config_parse_error",
    });
    await expect(source.inspect()).resolves.toBe("invalid");
  });

  it("returns invalid for a single-entry file whose token key has no separator", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      JSON.stringify({
        copilotTokens: { "no-colon-in-this-key": "gho_fakeNoSep6" },
      }),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({ status: "invalid" });
  });

  it("selects the sole entry when exactly one usable token exists", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      JSON.stringify({
        copilotTokens: {
          "https://ghe.example.test:only-user": "gho_fakeSole7",
        },
      }),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      oauthToken: "gho_fakeSole7",
      login: "only-user",
      host: "ghe.example.test",
    });
  });

  it("ignores empty-string tokens, treating them as absent", async () => {
    const home = temporaryDirectory();
    writeConfig(
      home,
      JSON.stringify({
        copilotTokens: {
          "https://ghe.example.test:empty-user": "",
          "https://github.com:real-user": "gho_fakeReal8",
        },
      }),
    );
    const source = fixtureSource({ environment: { HOME: home } });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      oauthToken: "gho_fakeReal8",
      login: "real-user",
      host: "github.com",
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
    const sentinel = "CLI-CREDENTIAL-SENTINEL-582910";
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
      "/synthetic-home/.copilot/config.json",
      1024 * 1024,
    );
  });

  it("honours GITHUB_COPILOT_CLI_CONFIG as a full-path override", async () => {
    const home = temporaryDirectory();
    const overridePath = join(home, "custom-copilot-config.json");
    writeFileSync(
      overridePath,
      JSON.stringify({
        copilotTokens: {
          "https://github.com:override-user": "gho_fakeOverride9",
        },
      }),
      { mode: 0o600 },
    );
    const source = fixtureSource({
      environment: { GITHUB_COPILOT_CLI_CONFIG: overridePath, HOME: home },
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      oauthToken: "gho_fakeOverride9",
      login: "override-user",
      host: "github.com",
    });
  });

  it("never contains a real-looking token in its own source text", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(source).not.toMatch(/gho_[A-Za-z0-9]{20,}/);
  });
});
