import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The artifact under test here is repository configuration, not product source:
 * the gate reads `.no-mistakes.yaml` and the `package.json` suite definition
 * from disk, and nothing in the published package exposes either of them, so no
 * published interface can carry this contract.
 * `test/release-ci-exclusions.test.ts` guards `release-please-config.json` and
 * `.github/workflows/*` the same way.
 */

/**
 * The deterministic Test baseline the no-mistakes gate must run. The gate reads
 * `commands` only from the trusted default-branch copy of `.no-mistakes.yaml`,
 * and an empty `commands.test` leaves the Test step to an open-ended agent that
 * invents its own validation commands. Keeping the exact strings here makes that
 * silent fallback a test failure instead of a pipeline behaviour change.
 */
const expectedCommands = {
  prepare: "pnpm install --frozen-lockfile",
  test: "pnpm test",
};

/**
 * Flags that keep the suite running after it finishes. `vitest run` and an
 * explicit `--watch=false` are not watch-enabling; everything here is. Checked
 * as whole command tokens, so `vitest run --watch` is caught even though the
 * watch flag does not follow `vitest` directly.
 */
const watchFlags = new Set(["-w", "--watch", "--watchall", "--standalone"]);

function enablesWatch(token: string): boolean {
  const [flag, value] = token.split("=");
  if (value === "false") return false;
  return watchFlags.has(flag.toLowerCase());
}

/**
 * True only when the command runs the suite exactly once: it invokes
 * `vitest run` and passes no watch-enabling flag anywhere. Vitest watches by
 * default in a TTY, so an unqualified `vitest` is not a terminating command.
 */
function runsSuiteOnce(command: string): boolean {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.some(enablesWatch)) return false;
  return tokens.some(
    (token, index) => token === "vitest" && tokens[index + 1] === "run",
  );
}

type NoMistakesConfig = {
  commands?: Record<string, unknown>;
  allow_repo_commands?: unknown;
};

function readConfig(): NoMistakesConfig {
  const raw = readFileSync(join(root, ".no-mistakes.yaml"), "utf8");
  return (loadYaml(raw) ?? {}) as NoMistakesConfig;
}

function readScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("no-mistakes trusted configuration", () => {
  it("declares the exact deterministic commands and no others", () => {
    // Exact equality is deliberate: adding a lint/format command here changes
    // what a pipeline step runs, so it must be a considered edit that updates
    // this contract.
    expect(readConfig().commands).toEqual(expectedCommands);
  });

  it("pins commands.test to a suite that terminates on its own", () => {
    const suite = readScripts().test ?? "";

    // An empty or watch-mode command would hand the Test step back to a command
    // that never returns.
    expect(suite).not.toBe("");
    expect(runsSuiteOnce(suite)).toBe(true);
  });

  it.each([
    "pnpm run build && vitest run --watch",
    "pnpm run build && vitest run --watch=true",
    "pnpm run build && vitest run -w",
    "pnpm run build && vitest run --standalone",
    "pnpm run build && vitest run --watchAll",
    "pnpm run build && vitest --watch",
    "pnpm run build && vitest",
    "pnpm run build && vitest --watch run",
  ])("rejects a watch-enabling or implicit-watch suite: %s", (command) => {
    expect(runsSuiteOnce(command)).toBe(false);
  });

  it.each([
    "pnpm run build && vitest run",
    "pnpm run build && vitest run --reporter=dot",
    "pnpm run build && vitest run --watch=false",
  ])("accepts a one-shot suite: %s", (command) => {
    expect(runsSuiteOnce(command)).toBe(true);
  });

  it("rejects the repository's own watch script as the gate suite", () => {
    expect(runsSuiteOnce(readScripts()["test:watch"] ?? "")).toBe(false);
  });

  it("keeps observable command execution on the trusted copy", () => {
    // `allow_repo_commands: true` would let a pushed branch supply `commands`
    // and `agent`; the repository deliberately leaves it off.
    expect(readConfig().allow_repo_commands ?? false).toBe(false);
  });
});
