import type { execFile, ExecFileException } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { resolveSystemTuiTheme } from "../../src/lib/system-theme.js";

const missingMacPreference =
  "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist";

function probe(
  stdout = "",
  error: Partial<ExecFileException> | null = null,
  stderr = "",
) {
  const end = vi.fn();
  const calls = vi.fn((_command, _args, _options, callback) => {
    callback(error, stdout, stderr);
    return { stdin: { end } };
  });
  return { run: calls as unknown as typeof execFile, calls, end };
}

describe("system TUI appearance", () => {
  it("reads macOS dark mode", async () => {
    const { run, calls, end } = probe("Dark\n");
    expect(await resolveSystemTuiTheme({ platform: "darwin", run })).toBe(
      "dark",
    );
    expect(calls).toHaveBeenCalledWith(
      "defaults",
      ["read", "-g", "AppleInterfaceStyle"],
      {
        encoding: "utf8",
        timeout: 500,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        shell: false,
        windowsHide: true,
      },
      expect.any(Function),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("recognizes macOS light mode's missing appearance key", async () => {
    const { run } = probe("", { code: 1 }, `${missingMacPreference}\n`);
    expect(await resolveSystemTuiTheme({ platform: "darwin", run })).toBe(
      "light",
    );
  });

  it.each(["0", "1"])("reads Windows AppsUseLightTheme=%s", async (value) => {
    const { run, calls } = probe(
      `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    AppsUseLightTheme    REG_DWORD    0x${value}\r\n`,
    );
    expect(await resolveSystemTuiTheme({ platform: "win32", run })).toBe(
      value === "1" ? "light" : "dark",
    );
    expect(calls.mock.calls[0].slice(0, 2)).toEqual([
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        "/v",
        "AppsUseLightTheme",
      ],
    ]);
  });

  it.each([
    ["'prefer-dark'", "dark"],
    ["'prefer-light'", "light"],
    ["'default'", "dark"],
    ["'unknown'", "dark"],
  ])("reads Linux color-scheme %s as %s", async (answer, theme) => {
    const { run, calls } = probe(`${answer}\n`);
    expect(await resolveSystemTuiTheme({ platform: "linux", run })).toBe(theme);
    expect(calls.mock.calls[0].slice(0, 2)).toEqual([
      "gsettings",
      ["get", "org.gnome.desktop.interface", "color-scheme"],
    ]);
  });

  it.each(["darwin", "win32", "linux"] as const)(
    "falls back to dark on %s errors, missing tools, and timeouts",
    async (platform) => {
      for (const error of [
        { code: 1 },
        { code: "ENOENT" },
        { code: "EACCES" },
        { killed: true, signal: "SIGKILL" as const },
      ]) {
        const { run, calls } = probe("", error);
        expect(await resolveSystemTuiTheme({ platform, run })).toBe("dark");
        expect(calls).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    ["darwin", "Light"],
    ["darwin", ""],
    ["win32", "AppsUseLightTheme REG_DWORD 0x2"],
    ["win32", "AppsUseLightTheme REG_SZ 0x1"],
    ["win32", "OtherValue REG_DWORD 0x1"],
    ["linux", "prefer-light"],
  ] as const)("keeps unknown %s output dark: %s", async (platform, answer) => {
    const { run } = probe(answer);
    expect(await resolveSystemTuiTheme({ platform, run })).toBe("dark");
  });

  it("does not probe an unsupported platform", async () => {
    const { run, calls } = probe();
    expect(await resolveSystemTuiTheme({ platform: "aix", run })).toBe("dark");
    expect(calls).not.toHaveBeenCalled();
  });

  it("contains a synchronous process-start failure", async () => {
    const run = vi.fn(() => {
      throw new Error("cannot start probe");
    }) as unknown as typeof execFile;
    expect(await resolveSystemTuiTheme({ platform: "linux", run })).toBe(
      "dark",
    );
  });
});
