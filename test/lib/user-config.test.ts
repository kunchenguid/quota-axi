import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTuiShowPreference,
  userConfigFilePath,
} from "../../src/lib/user-config.js";

let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

function configFile(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-user-config-"));
  temporaryDirectories.push(root);
  const file = userConfigFilePath({ XDG_CONFIG_HOME: root });
  if (contents !== undefined) {
    mkdirSync(join(root, "quota-axi"));
    writeFileSync(file, contents);
  }
  return file;
}

describe("userConfigFilePath", () => {
  it("lives under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(userConfigFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "quota-axi", "config.json"),
    );
    expect(userConfigFilePath({})).toBe(
      join(homedir(), ".config", "quota-axi", "config.json"),
    );
    expect(userConfigFilePath({ XDG_CONFIG_HOME: "" })).toBe(
      join(homedir(), ".config", "quota-axi", "config.json"),
    );
  });
});

describe("readTuiShowPreference", () => {
  it("reads tui.show when it is exactly used or remaining", () => {
    expect(readTuiShowPreference(configFile('{"tui":{"show":"used"}}'))).toBe(
      "used",
    );
    expect(
      readTuiShowPreference(configFile('{"tui":{"show":"remaining"}}')),
    ).toBe("remaining");
  });

  it("ignores unrelated keys alongside the preference", () => {
    expect(
      readTuiShowPreference(
        configFile('{"other":1,"tui":{"show":"used","later":true}}'),
      ),
    ).toBe("used");
  });

  it("keeps the remaining view without a usable preference", () => {
    for (const contents of [
      undefined,
      "",
      "not json",
      "[]",
      "null",
      '"used"',
      "{}",
      '{"tui":"used"}',
      '{"tui":{}}',
      '{"tui":{"show":"Used"}}',
      '{"tui":{"show":" used"}}',
      '{"tui":{"show":"left"}}',
      '{"tui":{"show":true}}',
      '{"show":"used"}',
    ]) {
      expect(readTuiShowPreference(configFile(contents)), contents).toBe(
        "remaining",
      );
    }
  });

  it("keeps the remaining view when the path is not a readable file", () => {
    const file = configFile();
    mkdirSync(file, { recursive: true });
    expect(readTuiShowPreference(file)).toBe("remaining");
  });
});
