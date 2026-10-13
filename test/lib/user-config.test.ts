import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTuiAccountLabels,
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

describe("readTuiAccountLabels", () => {
  function labels(entries: unknown): ReturnType<typeof readTuiAccountLabels> {
    return readTuiAccountLabels(
      configFile(JSON.stringify({ tui: { accountLabels: entries } })),
    );
  }

  it("names a lane by its home-relative or absolute locator path", () => {
    const label = labels({
      "~/.claude-work": " posam ",
      "/srv/claude/": "shared",
    });

    expect(label(join(homedir(), ".claude-work"))).toBe("posam");
    expect(label(join(homedir(), ".claude-work", ""))).toBe("posam");
    expect(label("/srv/claude")).toBe("shared");
    expect(label("/srv/claude/../claude")).toBe("shared");
    expect(label(join(homedir(), ".claude"))).toBeUndefined();
  });

  it("names a lane reached through a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-axi-account-labels-"));
    temporaryDirectories.push(root);
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link, "dir");

    expect(labels({ [link]: "linked" })(real)).toBe("linked");
    expect(labels({ [real]: "real" })(link)).toBe("real");
  });

  it("skips only the entries it cannot use", () => {
    const label = labels({
      "relative/dir": "relative",
      "~other/.claude": "other user",
      "~": "home",
      "/numeric": 1,
      "/blank": "   ",
      "/kept": "kept",
    });

    expect(label(join(process.cwd(), "relative", "dir"))).toBeUndefined();
    expect(label(homedir())).toBeUndefined();
    expect(label(join(process.cwd(), "~"))).toBeUndefined();
    expect(label("/numeric")).toBeUndefined();
    expect(label("/blank")).toBeUndefined();
    expect(label("/kept")).toBe("kept");
  });

  it("names nothing without a usable setting", () => {
    for (const contents of [
      undefined,
      "not json",
      "[]",
      "{}",
      '{"tui":{}}',
      '{"tui":{"accountLabels":["/kept"]}}',
      '{"tui":{"accountLabels":"/kept"}}',
      '{"accountLabels":{"/kept":"kept"}}',
    ]) {
      expect(
        readTuiAccountLabels(configFile(contents))("/kept"),
        contents,
      ).toBe(undefined);
    }
  });
});
