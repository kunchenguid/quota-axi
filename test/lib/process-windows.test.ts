import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const originalComSpec = process.env.ComSpec;

describe("execFileText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.resetModules();
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
  });

  it("passes Windows shim arguments through an encoded launcher", async () => {
    const launcherDirectory = await mkdtemp(
      path.join(tmpdir(), "quota-axi-powershell-"),
    );
    const launcherPath = path.join(launcherDirectory, "powershell.exe");
    const shimPath = path.join(launcherDirectory, "bl shim.cmd");
    const originalPath = process.env.PATH;
    await writeFile(
      launcherPath,
      `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const command = process.env.QUOTA_AXI_COMMAND;
const argumentsForCommand = Object.keys(process.env)
  .filter((name) => /^QUOTA_AXI_ARG_\\d+$/.test(name))
  .sort((left, right) => Number(left.slice(15)) - Number(right.slice(15)))
  .map((name) => process.env[name]);
process.stdout.write(execFileSync(command, argumentsForCommand));
`,
    );
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)));
`,
    );
    await chmod(launcherPath, 0o755);
    await chmod(shimPath, 0o755);
    process.env.PATH = `${launcherDirectory}${path.delimiter}${originalPath ?? ""}`;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const { execFileText } = await import("../../src/lib/process.js");
      await expect(
        execFileText(
          shimPath,
          ["usage", "token-plan", "--output", "json"],
          5000,
        ),
      ).resolves.toBe(
        JSON.stringify(["usage", "token-plan", "--output", "json"]),
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(launcherDirectory, { recursive: true, force: true });
    }
  });

  it("preserves shell metacharacters and percent sequences through a shim", async () => {
    const launcherDirectory = await mkdtemp(
      path.join(tmpdir(), "quota-axi-cmd-shim-"),
    );
    const powershellPath = path.join(launcherDirectory, "powershell.exe");
    const launcherPath = path.join(launcherDirectory, "shim with spaces.cmd");
    const originalPath = process.env.PATH;
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    await writeFile(
      powershellPath,
      `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const command = process.env.QUOTA_AXI_COMMAND;
const argumentsForCommand = Object.keys(process.env)
  .filter((name) => /^QUOTA_AXI_ARG_\\d+$/.test(name))
  .sort((left, right) => Number(left.slice(15)) - Number(right.slice(15)))
  .map((name) => process.env[name]);
process.stdout.write(execFileSync(command, argumentsForCommand));
`,
    );
    await writeFile(
      launcherPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)));
`,
    );
    await chmod(powershellPath, 0o755);
    await chmod(launcherPath, 0o755);
    process.env.PATH = `${launcherDirectory}${path.delimiter}${originalPath ?? ""}`;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const { execFileText } = await import("../../src/lib/process.js");
      await expect(
        execFileText(
          launcherPath,
          ['a"b', "C:\\path\\", "%PATH%", "a&b|c<d>e(f)", "caret^value", ""],
          5000,
        ),
      ).resolves.toBe(
        JSON.stringify([
          'a"b',
          "C:\\path\\",
          "%PATH%",
          "a&b|c<d>e(f)",
          "caret^value",
          "",
        ]),
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = originalWindir;
      await rm(launcherDirectory, { recursive: true, force: true });
    }
  });

  it("rejects control characters instead of passing command syntax to ComSpec", async () => {
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

    const { execFileText } = await import("../../src/lib/process.js");

    await expect(
      execFileText("C:\\Tools\\bl.cmd", ["safe", "line\nbreak"], 1000),
    ).rejects.toThrow("Windows command arguments cannot contain controls");
    expect(execFile).not.toHaveBeenCalled();
  });
});
