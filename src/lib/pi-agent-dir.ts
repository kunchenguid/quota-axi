import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type PiAgentDirEnvironment = {
  readonly HOME?: string | undefined;
  readonly PI_CODING_AGENT_DIR?: string | undefined;
  readonly [key: string]: string | undefined;
};

export function resolvePiAgentDirectory(
  environment: PiAgentDirEnvironment = process.env,
  homeDirectory: () => string = homedir,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = () => nonempty(environment.HOME) ?? homeDirectory();
  const configured = nonempty(environment.PI_CODING_AGENT_DIR);
  if (configured === undefined) {
    return join(home(), ".pi", "agent");
  }
  if (configured === "~") return home();
  if (
    configured.startsWith("~/") ||
    (platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(home(), configured.slice(2));
  }
  return configured;
}

export function resolvePiAuthFilePath(
  environment: PiAgentDirEnvironment = process.env,
  homeDirectory: () => string = homedir,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(
    resolvePiAgentDirectory(environment, homeDirectory, platform),
    "auth.json",
  );
}

function nonempty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The opt-in list of additional Pi agent directories whose Codex logins are
 * reported as their own lanes. Each entry is a directory exactly as the user
 * would set `PI_CODING_AGENT_DIR`, separated by the platform path delimiter.
 */
export const PI_PROFILES_ENV = "QUOTA_AXI_PI_PROFILES";

/**
 * The directories `QUOTA_AXI_PI_PROFILES` lists, in order, or `undefined` when
 * the variable is unset, blank, or lists no entry: then Codex reads only the
 * Pi directory this process selects, exactly as it does without the variable.
 *
 * Empty entries are ignored. A relative entry is returned in `invalid` so the
 * command can fail loudly instead of reading a directory the user did not mean.
 */
export function piListedProfiles(
  env: NodeJS.ProcessEnv = process.env,
): { dirs: string[]; invalid: string[] } | undefined {
  const value = env[PI_PROFILES_ENV];
  if (value === undefined || value.trim() === "") return undefined;
  const dirs: string[] = [];
  const invalid: string[] = [];
  for (const entry of value.split(delimiter)) {
    if (entry === "") continue;
    (isAbsolute(entry) ? dirs : invalid).push(entry);
  }
  return dirs.length || invalid.length ? { dirs, invalid } : undefined;
}
