import { createHash } from "node:crypto";
import { delimiter, isAbsolute } from "node:path";

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

export function codexHomeAccountKey(home: string): string {
  return `codex-home:${createHash("sha256").update(home).digest("hex").slice(0, 24)}`;
}
