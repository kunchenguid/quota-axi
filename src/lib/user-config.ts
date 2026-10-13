import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { TuiShow } from "../tui.js";
import { readJsonFile } from "./fs.js";

/**
 * The user-level quota-axi configuration file:
 * `$XDG_CONFIG_HOME/quota-axi/config.json`, or `~/.config/quota-axi/config.json`
 * when `XDG_CONFIG_HOME` is unset. It holds human preferences only, so nothing
 * an agent reads from quota-axi ever depends on it.
 */
export function userConfigFilePath(
  environment: Record<string, string | undefined> = process.env,
): string {
  const base = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "quota-axi", "config.json");
}

/**
 * The `--tui` direction preference, `tui.show` in the user config file. Only
 * the exact values `used` and `remaining` are recognized; an absent,
 * unreadable, or malformed file, and any other value, keep the default
 * remaining view.
 */
export function readTuiShowPreference(
  file: string = userConfigFilePath(),
): TuiShow {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const show = isRecord(tui) ? tui.show : undefined;
  return show === "used" ? "used" : "remaining";
}

/** Resolves a lane's `accountLocator.path` to the label its card shows. */
export type TuiAccountLabels = (locatorPath: string) => string | undefined;

/**
 * The `--tui` lane names, `tui.accountLabels` in the user config file: an
 * object from a lane's locator path (absolute, or `~/`-relative) to the name
 * its card shows. Paths are compared after `~` expansion and symlink
 * resolution, so a trailing slash or a linked directory names the same lane.
 * An absent, unreadable, or malformed file or setting names nothing; a
 * relative path, a non-string label, or a blank label skips only that entry.
 */
export function readTuiAccountLabels(
  file: string = userConfigFilePath(),
): TuiAccountLabels {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const entries = isRecord(tui) ? tui.accountLabels : undefined;
  const labels = new Map<string, string>();
  if (isRecord(entries)) {
    for (const [path, label] of Object.entries(entries)) {
      const expanded = expandHome(path);
      if (!isAbsolute(expanded) || typeof label !== "string") continue;
      const trimmed = label.trim();
      if (trimmed) labels.set(canonicalPath(expanded), trimmed);
    }
  }
  return (locatorPath) =>
    labels.size === 0 ? undefined : labels.get(canonicalPath(locatorPath));
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
