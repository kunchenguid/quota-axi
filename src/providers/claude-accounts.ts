import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeProfileLocations } from "../lib/claude-profile.js";
import { claudeStoredProfileContextId } from "../lib/fs.js";
import { traceInput } from "../lib/input-trace.js";

export type ClaudeProfile = ReturnType<typeof claudeProfileLocations>;

/** One Claude profile lane, in report order. */
export type ClaudeProfileLane = {
  profile: ClaudeProfile;
  /** The profile this process selects: the only lane that owns the env token and delegated refresh. */
  selected: boolean;
};

/**
 * The Claude profiles an opted-in read reports, in order: the profile this
 * process selects (the lane every read reports today), then the default
 * profile, then each directory `QUOTA_AXI_CLAUDE_PROFILES` lists. Profiles
 * that name the same credential store are reported once, at their first
 * position. No directory is searched for: only these candidates are read.
 *
 * The selected profile and every listed directory always get a lane, because
 * the user named them; one without a credential reports that as its own
 * reading. The default profile was not named, so it joins only on positive
 * evidence that it holds a credential: its native credential file, or (on
 * macOS) its exact Keychain item, checked from metadata without reading a
 * value. `hasKeychainItem` receives the Keychain services the other lanes own
 * so a sibling's item is never taken for the default's.
 */
export async function discoverClaudeProfiles(
  listed: readonly string[],
  hasKeychainItem: (
    profile: ClaudeProfile,
    siblingServices: ReadonlySet<string>,
  ) => Promise<boolean>,
): Promise<ClaudeProfileLane[]> {
  const candidates: (ClaudeProfileLane & { implicit: boolean })[] = [
    { profile: claudeProfileLocations(), selected: true, implicit: false },
    { profile: claudeProfileLocations({}), selected: false, implicit: true },
    ...listed.map((dir) => ({
      profile: claudeProfileLocations({ CLAUDE_CONFIG_DIR: dir }),
      selected: false,
      implicit: false,
    })),
  ];
  // A store keeps its first position, but naming it anywhere makes it explicit
  const byStore = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const identity = profileStoreIdentity(candidate.profile);
    const first = byStore.get(identity);
    if (!first) byStore.set(identity, { ...candidate });
    else first.implicit &&= candidate.implicit;
  }
  const unique = [...byStore.values()];
  const lanes: ClaudeProfileLane[] = [];
  for (const candidate of unique) {
    if (candidate.implicit) {
      const siblingServices = new Set(
        unique
          .filter((other) => other !== candidate)
          .map((other) => other.profile.keychainService)
          .filter((service) => service !== candidate.profile.keychainService),
      );
      if (!(await holdsCredential(candidate.profile, siblingServices)))
        continue;
    }
    lanes.push({ profile: candidate.profile, selected: candidate.selected });
  }
  return lanes;

  async function holdsCredential(
    profile: ClaudeProfile,
    siblingServices: ReadonlySet<string>,
  ): Promise<boolean> {
    const darwin = process.platform === "darwin";
    if (
      !(profile.secureStorageSelected && darwin) &&
      credentialFilePresent(join(profile.configDir, ".credentials.json"))
    )
      return true;
    return darwin && (await hasKeychainItem(profile, siblingServices));
  }
}

/**
 * Which credential store a profile reads. On macOS the Keychain service and
 * config directory together; elsewhere the real config directory, so two
 * spellings of one directory are one lane.
 */
function profileStoreIdentity(profile: ClaudeProfile): string {
  return process.platform === "darwin"
    ? claudeStoredProfileContextId(profile)
    : fileIdentity(profile.configDir);
}

/** A present-but-unreadable file still counts: its own read reports it. */
function credentialFilePresent(path: string): boolean {
  traceInput(path);
  try {
    statSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function fileIdentity(configDir: string): string {
  try {
    return realpathSync(configDir);
  } catch {
    return resolve(configDir);
  }
}

/**
 * The lane's published key names the profile itself, so it never moves when
 * an ambient `CLAUDE_CODE_OAUTH_TOKEN` is exported or unexported. On macOS it
 * derives from the stored-profile context (config directory plus Keychain
 * service); elsewhere from the real config directory. It is a one-way digest:
 * no path, token, or email can be read back from it.
 */
export function claudeAccountKey(profile: ClaudeProfile): string {
  const identity =
    process.platform === "darwin"
      ? claudeStoredProfileContextId(profile)
      : createHash("sha256")
          .update(
            JSON.stringify(["claude-file-v1", fileIdentity(profile.configDir)]),
          )
          .digest("hex");
  return `profile:${identity.slice(0, 24)}`;
}
