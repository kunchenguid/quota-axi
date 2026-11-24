import { createHash } from "node:crypto";
import { readlinkSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export const CODEX_HOMES_ENV = "QUOTA_AXI_CODEX_HOMES";

/**
 * The opt-in list of additional Codex homes to report as independent lanes.
 * Entries are raw absolute paths, matching CODEX_HOME semantics.
 */
export function codexListedHomes(
  env: NodeJS.ProcessEnv = process.env,
): { dirs: string[]; invalid: string[] } | undefined {
  const value = env[CODEX_HOMES_ENV];
  if (value === undefined || value.trim() === "") return undefined;
  const dirs: string[] = [];
  const invalid: string[] = [];
  for (const entry of value.split(delimiter)) {
    if (entry === "") continue;
    (isAbsolute(entry) ? dirs : invalid).push(entry);
  }
  return dirs.length || invalid.length ? { dirs, invalid } : undefined;
}

/** Canonical filesystem identity, with a stable fallback for absent homes. */
export function codexHomeIdentity(home: string): string {
  return canonicalCodexHome(resolve(home), new Set());
}

function canonicalCodexHome(home: string, seen: Set<string>): string {
  try {
    return realpathSync(home);
  } catch {
    const parent = dirname(home);
    if (parent === home) return home;
    const canonicalParent = canonicalCodexHome(parent, seen);
    const candidate = join(canonicalParent, basename(home));
    if (seen.has(candidate)) return candidate;
    seen.add(candidate);
    try {
      return canonicalCodexHome(
        resolve(dirname(candidate), readlinkSync(candidate)),
        seen,
      );
    } catch {
      return candidate;
    }
  }
}

export function codexHomeAccountKey(identity: string): string {
  return `codex-home:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}
