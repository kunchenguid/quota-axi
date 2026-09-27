import { homedir } from "node:os";
import { join } from "node:path";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
