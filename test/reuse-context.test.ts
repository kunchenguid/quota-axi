import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SELECTION_ENV,
  reuseContextId,
} from "../src/lib/reuse-context.js";

/**
 * Environment variables that never choose which credential, profile, store,
 * or deployment a provider reads, so fresh reuse ignores them.
 */
const NOT_SELECTING = new Set([
  // Terminal and color detection for --tui
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  // Executable lookup; the store a CLI opens is chosen by its own variables
  "PATH",
  "PATHEXT",
  "WINDIR",
  // quota-axi's own cache location, which already separates the cache itself
  "XDG_CACHE_HOME",
  // Names a snapshot file that answers instead of every provider
  "QUOTA_AXI_SNAPSHOT",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

/**
 * Every environment variable name `src/` reads: property reads on an env
 * object, and string literals bound to an `*_ENV` constant or an `envVar`
 * field, which is how indirect reads spell their names.
 */
function environmentReads(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /\benv(?:ironment)?\??\.([A-Z][A-Z0-9_]*)\b/g,
    ))
      names.add(match[1]!);
    for (const match of text.matchAll(
      /(?:\b[A-Z0-9_]+_ENV\s*=|\benvVar:)\s*"([A-Z][A-Z0-9_]*)"/g,
    ))
      names.add(match[1]!);
  }
  return names;
}

describe("fresh-reuse credential selection", () => {
  it("covers every environment variable a provider reads", () => {
    const listed = new Set<string>(CREDENTIAL_SELECTION_ENV);
    const unclassified = [...environmentReads()].filter(
      (name) => !listed.has(name) && !NOT_SELECTING.has(name),
    );
    expect(unclassified).toEqual([]);
  });

  it("finds the indirect reads the scan is meant to catch", () => {
    const reads = environmentReads();
    for (const name of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "QUOTA_AXI_CODEX_BINARY",
      "DEEPSEEK_API_KEY",
      "GROK_AUTH_JSON",
    ])
      expect(reads).toContain(name);
  });

  it("changes with any selecting variable and hides every value", () => {
    const base = { HOME: "/synthetic/home" };
    const id = reuseContextId(base);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(reuseContextId({ ...base })).toBe(id);
    expect(reuseContextId({ ...base, TERM: "xterm" })).toBe(id);
    for (const name of CREDENTIAL_SELECTION_ENV) {
      if (name === "HOME") continue;
      expect(reuseContextId({ ...base, [name]: "synthetic" }), name).not.toBe(
        id,
      );
    }
    expect(reuseContextId({ ...base, ELEVENLABS_API_KEY: "sk-a" })).not.toBe(
      reuseContextId({ ...base, ELEVENLABS_API_KEY: "sk-b" }),
    );
  });
});
