import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";

export const OPENCODE_AUTH_SOURCE = "opencode:auth.json";

export function opencodeAuthFilePath(): string {
  const xdg =
    typeof process.env.XDG_DATA_HOME === "string" &&
    process.env.XDG_DATA_HOME.length > 0
      ? process.env.XDG_DATA_HOME
      : undefined;
  if (xdg) return join(xdg, "opencode", "auth.json");
  if (process.platform === "win32") {
    const localAppData =
      typeof process.env.LOCALAPPDATA === "string" &&
      process.env.LOCALAPPDATA.length > 0
        ? process.env.LOCALAPPDATA
        : undefined;
    if (localAppData) return join(localAppData, "opencode", "auth.json");
  }
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

export function readOpencodeAuthFile(
  filePath: string = opencodeAuthFilePath(),
): JsonFileReadResult {
  return readJsonFileResult(filePath);
}
