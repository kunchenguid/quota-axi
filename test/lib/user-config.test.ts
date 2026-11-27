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
  readTuiCardOrder,
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
  // Resolves a lane by its locator path alone, as a profile lane is named.
  function labels(entries: unknown): (path: string) => string | undefined {
    const label = readTuiAccountLabels(
      configFile(JSON.stringify({ tui: { accountLabels: entries } })),
    );
    return (path) => label({ accountLocator: { path } });
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

  it("names a lane by its exact account key, ahead of its locator", () => {
    const label = readTuiAccountLabels(
      configFile(
        JSON.stringify({
          tui: {
            accountLabels: {
              "claude-swap:9a1c20d6b88a9bcec745fb70": " team ",
              "profile:aaaaaaaaaaaaaaaaaaaaaaaa": "by key",
              "/srv/claude": "by path",
            },
          },
        }),
      ),
    );

    expect(label({ accountKey: "claude-swap:9a1c20d6b88a9bcec745fb70" })).toBe(
      "team",
    );
    expect(label({ accountKey: "claude-swap:9A1C20D6B88A9BCEC745FB70" })).toBe(
      undefined,
    );
    expect(
      label({
        accountKey: "profile:aaaaaaaaaaaaaaaaaaaaaaaa",
        accountLocator: { path: "/srv/claude" },
      }),
    ).toBe("by key");
    expect(
      label({
        accountKey: "profile:bbbbbbbbbbbbbbbbbbbbbbbb",
        accountLocator: { path: "/srv/claude" },
      }),
    ).toBe("by path");
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
        readTuiAccountLabels(configFile(contents))({
          accountLocator: { path: "/kept" },
        }),
        contents,
      ).toBe(undefined);
    }
  });
});

describe("readTuiCardOrder", () => {
  type Card = {
    provider: string;
    accountKey?: string;
    accountLocator?: { path: string };
  };

  function order(entries: unknown): ReturnType<typeof readTuiCardOrder> {
    return readTuiCardOrder(
      configFile(JSON.stringify({ tui: { order: entries } })),
    );
  }

  const lane = (path: string): Card => ({
    provider: "claude",
    accountLocator: { path: join(homedir(), path) },
  });
  const names = (cards: readonly Card[]): string[] =>
    cards.map((card) =>
      card.accountLocator
        ? card.accountLocator.path.slice(homedir().length + 1)
        : (card.accountKey ?? card.provider),
    );
  // Declaration order, with the lane CLAUDE_CONFIG_DIR selected first.
  const report: Card[] = [
    lane(".claude-team-b"),
    lane(".claude"),
    lane(".claude-team-a"),
    lane(".claude-team-c"),
    lane(".claude-work"),
    { provider: "codex" },
    { provider: "cursor" },
    { provider: "grok" },
  ];

  it("puts listed providers and lanes first, in the listed order", () => {
    const sorted = order([
      "codex",
      "~/.claude",
      "~/.claude-work",
      "~/.claude-team-a",
      "~/.claude-team-b",
      "~/.claude-team-c",
    ])(report);

    expect(names(sorted)).toEqual([
      "codex",
      ".claude",
      ".claude-work",
      ".claude-team-a",
      ".claude-team-b",
      ".claude-team-c",
      // Unlisted cards keep their own relative order after the listed ones.
      "cursor",
      "grok",
    ]);
  });

  it("gives the listed cards the same order whichever lane came first", () => {
    const listed = [
      "codex",
      "~/.claude",
      "~/.claude-work",
      "~/.claude-team-a",
      "~/.claude-team-b",
      "~/.claude-team-c",
    ];
    const sort = order(listed);
    const first = (cards: Card[]): string[] =>
      names(sort(cards)).slice(0, listed.length);

    expect(first(report)).toEqual(first([...report].reverse()));
    expect(first([...report.slice(1), report[0]])).toEqual(first(report));
  });

  it("orders every lane of a listed provider, and a listed lane before it", () => {
    const sorted = order(["~/.claude-work", "claude", "grok"])(report);

    expect(names(sorted)).toEqual([
      ".claude-work",
      ".claude-team-b",
      ".claude",
      ".claude-team-a",
      ".claude-team-c",
      "grok",
      "codex",
      "cursor",
    ]);
  });

  it("places a lane without a locator by its exact account key", () => {
    const cards: Card[] = [
      { provider: "claude", accountKey: "claude-swap:aaaa" },
      { provider: "claude", accountKey: "claude-swap:bbbb" },
      { provider: "codex" },
    ];

    expect(names(order(["claude-swap:bbbb", "codex"])(cards))).toEqual([
      "claude-swap:bbbb",
      "codex",
      "claude-swap:aaaa",
    ]);
    // A path entry never matches a key, and a key is matched exactly.
    expect(
      names(order(["~/claude-swap:bbbb", "CLAUDE-SWAP:aaaa"])(cards)),
    ).toEqual(["claude-swap:aaaa", "claude-swap:bbbb", "codex"]);
  });

  it("places a lane listed by both key and path at the earlier listing", () => {
    const work: Card = {
      provider: "claude",
      accountKey: "profile:bbbb",
      accountLocator: { path: join(homedir(), ".claude-work") },
    };
    const personal: Card = {
      provider: "claude",
      accountKey: "profile:aaaa",
      accountLocator: { path: join(homedir(), ".claude") },
    };
    const cards: Card[] = [personal, { provider: "codex" }, work];

    expect(order(["profile:bbbb", "codex", "~/.claude-work"])(cards)).toEqual([
      work,
      cards[1],
      personal,
    ]);
    expect(order(["~/.claude-work", "codex", "profile:bbbb"])(cards)).toEqual([
      work,
      cards[1],
      personal,
    ]);
    // An unlisted lane still takes its listed provider's place.
    expect(
      order(["codex", "profile:bbbb", "claude", "~/.claude-work"])(cards),
    ).toEqual([cards[1], work, personal]);
  });

  it("matches a lane by a trailing-slash or symlinked path", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-axi-card-order-"));
    temporaryDirectories.push(root);
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    const cards: Card[] = [
      { provider: "codex" },
      { provider: "claude", accountLocator: { path: real } },
    ];

    expect(order([`${link}/`])(cards)).toEqual([cards[1], cards[0]]);
  });

  it("skips only the entries it cannot use, and the first listing wins", () => {
    const sorted = order([
      7,
      null,
      "",
      "  ",
      "relative/dir",
      "grok",
      "~/.claude-work",
      "grok",
    ])(report);

    expect(names(sorted).slice(0, 2)).toEqual(["grok", ".claude-work"]);
  });

  it("keeps declaration order without a usable setting", () => {
    for (const contents of [
      undefined,
      "not json",
      "[]",
      "{}",
      '{"tui":{}}',
      '{"tui":{"order":"codex"}}',
      '{"tui":{"order":{"codex":1}}}',
      '{"tui":{"order":[]}}',
      '{"order":["codex"]}',
    ]) {
      const sorted = readTuiCardOrder(configFile(contents))(report);
      expect(sorted, contents).toEqual(report);
      expect(sorted, contents).not.toBe(report);
    }
  });
});
