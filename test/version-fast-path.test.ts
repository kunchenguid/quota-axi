import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
const TRACE_REGISTER = resolve("test/fixtures/module-trace/register.mjs");
const VERSION = (
  JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    version: string;
  }
).version;

let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

function runTraced(argv: string[]): { modules: string[]; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-module-trace-"));
  temporaryDirectories.push(root);
  const traceFile = join(root, "modules.txt");
  const result = spawnSync(
    process.execPath,
    ["--import", TRACE_REGISTER, BUILT_CLI_ENTRYPOINT, ...argv],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        QUOTA_AXI_MODULE_TRACE_FILE: traceFile,
      },
    },
  );
  if (result.error) throw result.error;
  const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8") : "";
  return {
    modules: trace.split("\n").filter((line) => line.length > 0),
    stdout: result.stdout,
  };
}

const HEAVY_MODULES = [
  "/dist/src/cli.js",
  "/dist/src/commands.js",
  "/axi-sdk-js/dist/index.js",
  "/@toon-format/toon/",
];

describe("quota-axi --version fast path", () => {
  it("answers a bare version flag without loading the heavy command graph", () => {
    const { modules, stdout } = runTraced(["--version"]);

    expect(stdout).toBe(`${VERSION}\n`);
    expect(modules.some((url) => url.endsWith("/dist/src/version.js"))).toBe(
      true,
    );
    expect(
      modules.some((url) => url.endsWith("/axi-sdk-js/dist/fast-path.js")),
    ).toBe(true);
    for (const heavy of HEAVY_MODULES) {
      expect(
        modules.some((url) => url.includes(heavy)),
        `${heavy} must not load on the version path`,
      ).toBe(false);
    }
  });

  it("negative control: a real command path does load the heavy command graph", () => {
    // Proves the module trace above would catch a regression rather than
    // passing because the probe records nothing.
    const { modules } = runTraced(["--help"]);

    for (const heavy of HEAVY_MODULES) {
      expect(
        modules.some((url) => url.includes(heavy)),
        `${heavy} is expected on the slow path`,
      ).toBe(true);
    }
  });

  it.each([["-v"], ["-V"], ["--version"]])(
    "prints exactly the version for %s",
    (flag) => {
      const result = spawnSync(process.execPath, [BUILT_CLI_ENTRYPOINT, flag], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${VERSION}\n`);
      expect(result.stderr).toBe("");
    },
  );

  it("still answers a trailing version flag through the full CLI", () => {
    const result = spawnSync(
      process.execPath,
      [BUILT_CLI_ENTRYPOINT, "--provider", "claude", "-v"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
  });
});
