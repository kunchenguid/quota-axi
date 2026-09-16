import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ghCliHostsPath,
  resolveGhCliCredential,
} from "../../src/providers/gh-cli-credential.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-gh-cli-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Resolve against a synthetic `hosts.yml`, never the machine's real store. */
async function resolveHosts(text: string) {
  const dir = join(tempDir, "gh");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hosts.yml"), text, { mode: 0o600 });
  return resolveGhCliCredential({ environment: { GH_CONFIG_DIR: dir } });
}

describe("GitHub CLI hosts.yml path", () => {
  it("follows gh's own configuration directory precedence", () => {
    const home = () => "/home/fixture";
    expect(
      ghCliHostsPath(
        { GH_CONFIG_DIR: "/gh-dir", XDG_CONFIG_HOME: "/xdg" },
        "linux",
        home,
      ),
    ).toBe(join("/gh-dir", "hosts.yml"));
    expect(ghCliHostsPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", home)).toBe(
      join("/xdg", "gh", "hosts.yml"),
    );
    expect(ghCliHostsPath({ AppData: "C:\\AppData" }, "win32", home)).toBe(
      join("C:\\AppData", "GitHub CLI", "hosts.yml"),
    );
    expect(ghCliHostsPath({ AppData: "/appdata" }, "linux", home)).toBe(
      join("/home/fixture", ".config", "gh", "hosts.yml"),
    );
  });
});

describe("GitHub CLI credential resolution", () => {
  it("resolves the github.com host token gh writes with plain-text storage", async () => {
    const result = await resolveHosts(
      [
        "github.com:",
        "    users:",
        "        fixture-user:",
        "            oauth_token: gho_per_user_copy",
        "    git_protocol: ssh",
        "    oauth_token: gho_active_fixture",
        "    user: fixture-user",
        "",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      status: "resolved",
      token: "gho_active_fixture",
    });
  });

  it("accepts two-space indentation, quoting, comments, and a document marker", async () => {
    const result = await resolveHosts(
      [
        "\uFEFF---",
        "# gh hosts",
        "ghe.example.test:",
        "  oauth_token: 'enterprise-fixture'",
        "github.com:",
        '  user: "fixture-user" # active',
        "  oauth_token: 'gho_quoted''fixture' # comment",
        "",
      ].join("\r\n"),
    );

    expect(result).toMatchObject({
      status: "resolved",
      token: "gho_quoted'fixture",
    });
  });

  it("reads a trailing plain comment off an unquoted token", async () => {
    const result = await resolveHosts(
      "github.com:\n  oauth_token: gho_plain_fixture   # note\n",
    );

    expect(result).toMatchObject({
      status: "resolved",
      token: "gho_plain_fixture",
    });
  });

  it("follows gh in resolving a repeated key to its first entry", async () => {
    const result = await resolveHosts(
      [
        "github.com:",
        "  oauth_token: gho_first_fixture",
        "  oauth_token: gho_second_fixture",
        "github.com:",
        "  oauth_token: gho_shadowed_fixture",
        "",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      status: "resolved",
      token: "gho_first_fixture",
    });
  });

  it("reports an absent file as absent", async () => {
    const result = await resolveGhCliCredential({
      environment: { GH_CONFIG_DIR: join(tempDir, "missing") },
    });

    expect(result.status).toBe("absent");
  });

  it("reports an empty file or one with no github.com login as absent", async () => {
    expect((await resolveHosts("")).status).toBe("absent");
    expect(
      (
        await resolveHosts(
          "ghe.example.test:\n  user: fixture-user\n  oauth_token: enterprise-fixture\n",
        )
      ).status,
    ).toBe("absent");
  });

  it.each([
    [
      "keyring storage",
      "github.com:\n    users:\n        fixture-user:\n    git_protocol: https\n    user: fixture-user\n",
    ],
    [
      "a per-user copy without the host token",
      "github.com:\n  users:\n    fixture-user:\n      oauth_token: gho_user_copy\n  user: fixture-user\n",
    ],
    ["an empty token", "github.com:\n  oauth_token:\n  user: fixture-user\n"],
    ["an empty quoted token", 'github.com:\n  oauth_token: ""\n'],
  ])("reports %s as a login quota-axi does not read", async (_label, text) => {
    expect((await resolveHosts(text)).status).toBe("unsupported");
  });

  it.each([
    ["tab indentation", "github.com:\n\toauth_token: gho_fixture\n"],
    ["a sequence", "github.com:\n  - oauth_token: gho_fixture\n"],
    ["a scalar host", "github.com: gho_fixture\n"],
    ["an empty host", "github.com:\nother.example.test:\n  user: x\n"],
    ["a nested token", "github.com:\n  oauth_token:\n    value: gho_fixture\n"],
    [
      "a block scalar token",
      "github.com:\n  oauth_token: |\n    gho_fixture\n",
    ],
    [
      "a multi-line flow mapping",
      "github.com:\n  users: {\n    fixture: x }\n  oauth_token: gho_fixture\n",
    ],
    ["an anchor token", "github.com:\n  oauth_token: &token gho_fixture\n"],
    ["an unterminated quote", "github.com:\n  oauth_token: 'gho_fixture\n"],
    ["a double-quoted escape", 'github.com:\n  oauth_token: "gho\\u0041"\n'],
    ["an environment reference", "github.com:\n  oauth_token: $GH_TOKEN\n"],
    ["a command reference", "github.com:\n  oauth_token: '!gh auth token'\n"],
    [
      "inconsistent indentation",
      "github.com:\n    user: fixture\n  oauth_token: gho_fixture\n",
    ],
    ["a key without a separator", "github.com\n  oauth_token: gho_fixture\n"],
  ])("reports %s as structurally invalid", async (_label, text) => {
    expect((await resolveHosts(text)).status).toBe("structurally_invalid");
  });

  it("reports an oversized file as structurally invalid", async () => {
    const result = await resolveHosts(
      `github.com:\n  oauth_token: gho_fixture\n# ${"x".repeat(70_000)}\n`,
    );

    expect(result.status).toBe("structurally_invalid");
  });

  it("reports an unreadable file as a read error", async () => {
    const dir = join(tempDir, "gh");
    mkdirSync(join(dir, "hosts.yml"), { recursive: true });

    const result = await resolveGhCliCredential({
      environment: { GH_CONFIG_DIR: dir },
    });

    expect(result.status).toBe("read_error");
  });

  it("never exposes a token outside the resolved state", async () => {
    const result = await resolveHosts(
      "github.com:\n  users:\n    fixture-user:\n      oauth_token: gho_user_copy\n",
    );

    expect(JSON.stringify(result)).not.toContain("gho_user_copy");
  });
});
