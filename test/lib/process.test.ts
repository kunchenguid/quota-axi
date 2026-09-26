import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandExists,
  currentUserProcessListArgs,
  execFileText,
  terminateChild,
} from "../../src/lib/process.js";

const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
let tempDir: string | undefined;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPathExt === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = originalPathExt;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("commandExists", () => {
  it("finds executables from PATH without shell probes", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-path-"));
    const command = "quota-axi-fixture";
    const file =
      process.platform === "win32"
        ? join(tempDir, `${command}.CMD`)
        : join(tempDir, command);
    writeFileSync(
      file,
      process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
    );
    chmodSync(file, 0o700);
    process.env.PATH = tempDir;
    process.env.PATHEXT = ".CMD;.EXE";

    expect(await commandExists(command)).toBe(true);
    expect(await commandExists("quota-axi-missing")).toBe(false);
  });
});

describe("terminateChild", () => {
  it.skipIf(process.platform === "win32")(
    "force-kills a child that ignores SIGTERM",
    async () => {
      const child = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
      ]);
      await new Promise((resolve) => child.stdout?.once("data", resolve));
      terminateChild(child);
      const signal = await new Promise((resolve) =>
        child.once("exit", (_code, exitSignal) => resolve(exitSignal)),
      );
      expect(signal).toBe("SIGKILL");
    },
    10_000,
  );
});

describe("currentUserProcessListArgs", () => {
  it("omits the BSD -x selector on Linux, where procps rejects it", () => {
    expect(currentUserProcessListArgs(1000)).toEqual(
      process.platform === "linux"
        ? ["-u", "1000", "-o", "pid=,command="]
        : ["-x", "-u", "1000", "-o", "pid=,command="],
    );
  });

  it.skipIf(process.platform === "win32")(
    "lists this process when handed to the real ps",
    async () => {
      const output = await execFileText(
        "ps",
        currentUserProcessListArgs(process.geteuid?.() ?? 0),
        5_000,
      );
      expect(output).toMatch(new RegExp(`^\\s*${process.pid}\\s`, "m"));
    },
    10_000,
  );
});
