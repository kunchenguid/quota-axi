import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

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
  try {
    return realpathSync(home);
  } catch {
    return resolve(home);
  }
}

export function codexHomeAccountKey(identity: string): string {
  return `codex-home:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}
