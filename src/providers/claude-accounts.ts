import { readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeProfileLocations } from "../lib/claude-profile.js";
import {
  claudeCredentialContextId,
  claudeStoredProfileContextId,
} from "../lib/fs.js";

export type ClaudeProfile = ReturnType<typeof claudeProfileLocations>;

/**
 * Current selector first, then the default and conventional ~/.claude-* profile
 * directories in lexical order. A directory name alone is not an account:
 * enrollment requires a native credential file or the exact Keychain item.
 * No recursive search, credential values, or process-wide environment changes.
 */
export async function discoverClaudeProfiles(
  hasKeychainItem: (profile: ClaudeProfile) => Promise<boolean>,
): Promise<ClaudeProfile[]> {
  const selected = claudeProfileLocations();
  const candidates = [selected, claudeProfileLocations({})];
  try {
    const names = readdirSync(homedir(), { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          entry.name.startsWith(".claude-"),
      )
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      candidates.push(
        claudeProfileLocations({ CLAUDE_CONFIG_DIR: join(homedir(), name) }),
      );
    }
  } catch {
    // An unreadable home cannot invalidate the explicitly selected profile.
  }
  const seen = new Set<string>();
  const profiles: ClaudeProfile[] = [];
  for (const profile of candidates) {
    const key =
      process.platform === "darwin"
        ? claudeCredentialContextId(profile)
        : fileIdentity(profile.configDir);
    if (seen.has(key)) continue;
    seen.add(key);
    const explicitlySelected =
      profile === selected &&
      (process.env.CLAUDE_CONFIG_DIR !== undefined ||
        Boolean(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR));
    const filePresent =
      !(profile.secureStorageSelected && process.platform === "darwin") &&
      credentialFilePresent(join(profile.configDir, ".credentials.json"));
    if (
      explicitlySelected ||
      filePresent ||
      (process.platform === "darwin" && (await hasKeychainItem(profile)))
    ) {
      profiles.push(profile);
    }
  }
  return profiles.length ? profiles : [selected];
}

function credentialFilePresent(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    // Present-but-unreadable must produce its own failure, not disappear.
    return (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      (error as NodeJS.ErrnoException).code !== "ENOTDIR"
    );
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
 * The published key names the profile itself, so it must not move when an
 * ambient `CLAUDE_CODE_OAUTH_TOKEN` is exported or unexported: the stored
 * identity is the macOS counterpart of the Linux config-directory hash.
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
