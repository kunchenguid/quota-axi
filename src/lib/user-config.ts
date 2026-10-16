import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { TuiShow } from "../tui.js";
import { PROVIDER_IDS } from "../types.js";
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

/** Resolves a lane to the label its card shows. */
export type TuiAccountLabels = (lane: {
  accountKey?: string;
  accountLocator?: { path: string };
}) => string | undefined;

/**
 * The `--tui` lane names, `tui.accountLabels` in the user config file: an
 * object from a lane's locator path (absolute, or `~/`-relative) or its
 * account key to the name its card shows. Paths are compared after `~`
 * expansion and symlink resolution, so a trailing slash or a linked directory
 * names the same lane; any other entry is matched exactly against the lane's
 * account key, so a relative path names nothing. An absent, unreadable, or
 * malformed file or setting names nothing; a non-string or blank label skips
 * only that entry.
 */
export function readTuiAccountLabels(
  file: string = userConfigFilePath(),
): TuiAccountLabels {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const entries = isRecord(tui) ? tui.accountLabels : undefined;
  const paths = new Map<string, string>();
  const accountKeys = new Map<string, string>();
  if (isRecord(entries)) {
    for (const [entry, label] of Object.entries(entries)) {
      if (typeof label !== "string" || !label.trim()) continue;
      const expanded = expandHome(entry);
      if (isAbsolute(expanded))
        paths.set(canonicalPath(expanded), label.trim());
      else accountKeys.set(entry, label.trim());
    }
  }
  return ({ accountKey, accountLocator }) =>
    (accountKey && accountKeys.get(accountKey)) ||
    (accountLocator && paths.size > 0
      ? paths.get(canonicalPath(accountLocator.path))
      : undefined);
}

/** Puts `--tui` cards in the user's order; returns a new array. */
export type TuiCardOrder = <
  Card extends {
    provider: string;
    accountKey?: string;
    accountLocator?: { path: string };
  },
>(
  cards: readonly Card[],
) => Card[];

/**
 * The `--tui` card order, `tui.order` in the user config file: a list of
 * provider ids, lane locator paths, and lane account keys, matched like
 * `tui.accountLabels` (a path is absolute or `~/`-relative and compared after
 * `~` expansion and symlink resolution; any other entry that is not a provider
 * id is an exact account key). A lane listed by path or account key takes that
 * place (the earlier one when it is listed by both), any other card of a listed provider takes the provider's place, and
 * unlisted cards follow in their own relative order. An absent, unreadable, or
 * malformed file or setting keeps declaration order; a non-string or blank
 * entry is skipped, and a repeated entry keeps its first place.
 */
export function readTuiCardOrder(
  file: string = userConfigFilePath(),
): TuiCardOrder {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const entries = isRecord(tui) ? tui.order : undefined;
  const providers = new Map<string, number>();
  const lanes = new Map<string, number>();
  const accountKeys = new Map<string, number>();
  // Unlisted cards sort after every listed place.
  const unlisted = Array.isArray(entries) ? entries.length : 0;
  if (Array.isArray(entries)) {
    entries.forEach((entry: unknown, place) => {
      if (typeof entry !== "string" || !entry.trim()) return;
      if ((PROVIDER_IDS as readonly string[]).includes(entry)) {
        if (!providers.has(entry)) providers.set(entry, place);
        return;
      }
      const expanded = expandHome(entry);
      if (!isAbsolute(expanded)) {
        if (!accountKeys.has(entry)) accountKeys.set(entry, place);
        return;
      }
      const path = canonicalPath(expanded);
      if (!lanes.has(path)) lanes.set(path, place);
    });
  }
  return (cards) => {
    const placed = cards.map((card, index) => {
      // A lane listed by both path and account key takes the earlier place.
      const lanePlaces = [
        card.accountLocator &&
          lanes.get(canonicalPath(card.accountLocator.path)),
        card.accountKey === undefined
          ? undefined
          : accountKeys.get(card.accountKey),
      ].filter((place) => place !== undefined);
      return {
        card,
        index,
        place:
          lanePlaces.length > 0
            ? Math.min(...lanePlaces)
            : (providers.get(card.provider) ?? unlisted),
      };
    });
    placed.sort((a, b) => a.place - b.place || a.index - b.index);
    return placed.map(({ card }) => card);
  };
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
