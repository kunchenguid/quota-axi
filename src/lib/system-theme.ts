import { execFile } from "node:child_process";
import type { TuiTheme } from "../tui.js";

/** Read only the OS appearance preference; an unavailable probe stays dark. */
export function resolveSystemTuiTheme(
  dependencies: {
    platform?: NodeJS.Platform;
    run?: typeof execFile;
  } = {},
): Promise<TuiTheme> {
  const platform = dependencies.platform ?? process.platform;
  const probe =
    platform === "darwin"
      ? { command: "defaults", args: ["read", "-g", "AppleInterfaceStyle"] }
      : platform === "win32"
        ? {
            command: "reg",
            args: [
              "query",
              "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
              "/v",
              // Windows Terminal and other apps follow the default app mode,
              // rather than SystemUsesLightTheme used by the taskbar and Start.
              "AppsUseLightTheme",
            ],
          }
        : platform === "linux"
          ? {
              command: "gsettings",
              args: ["get", "org.gnome.desktop.interface", "color-scheme"],
            }
          : undefined;
  if (probe === undefined) return Promise.resolve("dark");

  return new Promise((resolve) => {
    try {
      const child = (dependencies.run ?? execFile)(
        probe.command,
        probe.args,
        {
          encoding: "utf8",
          timeout: 500,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          shell: false,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            // macOS light mode has no AppleInterfaceStyle preference. Only
            // that expected missing-key result is light; other failures stay dark.
            const missingMacPreference =
              platform === "darwin" &&
              error.code === 1 &&
              !error.killed &&
              !error.signal &&
              stderr.includes(
                "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist",
              );
            resolve(missingMacPreference ? "light" : "dark");
            return;
          }
          const answer = stdout.trim();
          if (platform === "win32") {
            const value =
              /^\s*AppsUseLightTheme\s+REG_DWORD\s+0x([01])\s*$/im.exec(answer);
            resolve(value?.[1] === "1" ? "light" : "dark");
          } else {
            resolve(
              platform === "linux" && answer === "'prefer-light'"
                ? "light"
                : "dark",
            );
          }
        },
      );
      // The fixed read commands have no interactive input surface.
      child.stdin?.end();
    } catch {
      resolve("dark");
    }
  });
}
