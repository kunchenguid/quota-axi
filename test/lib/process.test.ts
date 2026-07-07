import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandExists,
  spawnTextSession,
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

describe("spawnTextSession", () => {
  it("captures all output from a child that writes and exits immediately", async () => {
    const output = await spawnTextSession(
      process.execPath,
      ["-e", "process.stdout.write('a'.repeat(1000000))"],
      () => {},
      10_000,
      () => false,
    );
    expect(output).toHaveLength(1_000_000);
  });

  it("rejects when the command cannot be spawned", async () => {
    await expect(
      spawnTextSession(
        join(tmpdir(), "quota-axi-missing-binary"),
        [],
        () => {},
        5_000,
        () => false,
      ),
    ).rejects.toThrow("command unavailable");
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
