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
  test?: { instructions?: unknown };
  allow_repo_commands?: unknown;
};

/**
 * The runbook flattened into lowercase, whitespace-collapsed clauses so each
 * required or forbidden behaviour can be asserted next to the instruction that
 * states it. The clause view is an assertion aid, not a model of the prompt
 * no-mistakes assembles from `test.instructions`.
 */
function runbookClauses(instructions: unknown): string[] {
  if (typeof instructions !== "string") return [];
  return instructions
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split(/(?<=\.)\s+/)
    .filter(Boolean);
}

/**
 * True when a prompt clause states a prohibition ("do not", "never", "no")
 * about the given subject, so each forbidden behaviour has to be named next to
 * the instruction that forbids it rather than merely appearing somewhere.
 */
function forbids(clause: string, subject: RegExp): boolean {
  return /\b(?:do not|never|no)\b/.test(clause) && subject.test(clause);
}

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

  it("declares a trusted runbook that requires the deterministic suite and bounds the agent", () => {
    // The Test step still launches an agent after `commands.test`; this runbook
    // is the trusted bound on its own scenarios, so it must name the same
    // deterministic suite the baseline runs and forbid each live or unbounded
    // probe.
    const config = readConfig();
    const clauses = runbookClauses(config.test?.instructions);
    const runbook = clauses.join(" ");

    expect(config.test?.instructions).toBeTypeOf("string");
    expect(runbook).not.toBe("");
    expect(runbook).toContain(expectedCommands.test);
    expect(
      clauses.some(
        (clause) =>
          /\bscenarios?\b/.test(clause) && /\bbounded\b|\blocal\b/.test(clause),
      ),
    ).toBe(true);

    const forbiddenSubjects = [
      /\bnetwork\b/,
      /\bcredential\b/,
      /\brefresh\b|\bexchange\b/,
      /\bproxy\b/,
      /\bhosts?\b|\bports?\b/,
      /\bfilesystem\b/,
      /\bindefinitely\b|\bunbounded\b/,
    ];
    const unguarded = forbiddenSubjects.filter(
      (subject) => !clauses.some((clause) => forbids(clause, subject)),
    );
    expect(unguarded).toEqual([]);
  });

  it("credits a prohibition only when the clause forbids the behaviour it names", () => {
    // The guard above relies on this distinction: a runbook that mentions a
    // behaviour without forbidding it must not count.
    expect(forbids("do not start a proxy", /\bproxy\b/)).toBe(true);
    expect(
      forbids("never refresh, mint, or exchange a credential", /\brefresh\b/),
    ).toBe(true);
    expect(forbids("start a proxy and probe hosts", /\bproxy\b/)).toBe(false);
    expect(forbids("do not search the whole filesystem", /\bnetwork\b/)).toBe(
      false,
    );
  });

  it("keeps observable command execution on the trusted copy", () => {
    // `allow_repo_commands: true` would let a pushed branch supply `commands`
    // and `agent`; the repository deliberately leaves it off.
    expect(readConfig().allow_repo_commands ?? false).toBe(false);
  });
});
