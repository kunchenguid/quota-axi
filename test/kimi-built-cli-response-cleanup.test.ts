import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
const TSC_ENTRYPOINT = resolve("node_modules/typescript/bin/tsc");
let temporaryDirectories: string[] = [];

beforeAll(() => {
  const result = spawnSync(
    process.execPath,
    [TSC_ENTRYPOINT, "--pretty", "false"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(existsSync(BUILT_CLI_ENTRYPOINT)).toBe(true);
});

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("built Kimi CLI response cleanup", () => {
  it("awaits cancellation of an unread streaming 503 response", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "api_key",
          key: "synthetic-cleanup-key-731",
        },
      }),
      { mode: 0o600 },
    );
    const authBefore = snapshot(authPath);
    const preload = join(fixture.root, "synthetic-503-fetch.mjs");
    const cleanupMarker = join(fixture.root, "response-cleanup.json");
    writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs";

let cancelCount = 0;
globalThis.fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const request = {
    url: String(input),
    method: init?.method,
    redirect: init?.redirect,
    credentials: init?.credentials,
    authorizationMatches:
      headers.get("authorization") === "Bearer synthetic-cleanup-key-731",
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("synthetic error body"));
    },
    async cancel() {
      cancelCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      writeFileSync(
        process.env.KIMI_CLEANUP_MARKER,
        JSON.stringify({ cancelCount, request, cleanupCompleted: true }),
        { mode: 0o600 },
      );
    },
  });
  return new Response(body, {
    status: 503,
    headers: { "content-type": "application/json" },
  });
};
`,
      { mode: 0o600 },
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        BUILT_CLI_ENTRYPOINT,
        "--provider",
        "kimi",
        "--json",
        "--full",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          HOME: fixture.home,
          XDG_CACHE_HOME: fixture.cacheHome,
          KIMI_CODE_HOME: fixture.kimiCodeHome,
          KIMI_CLEANUP_MARKER: cleanupMarker,
          PATH: process.env.PATH ?? "",
        },
      },
    );
    if (result.error) throw result.error;

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: {
            status: "error",
            error: "provider_unavailable",
            sourcesTried: ["pi:kimi-coding"],
          },
        },
      ],
    });
    expect(JSON.parse(readFileSync(cleanupMarker, "utf8"))).toEqual({
      cancelCount: 1,
      request: {
        url: "https://api.kimi.com/coding/v1/usages",
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        authorizationMatches: true,
      },
      cleanupCompleted: true,
    });
    expect(snapshot(authPath)).toEqual(authBefore);
    expect(readdirSync(fixture.cacheHome)).toEqual([]);
    expect(result.stdout).not.toContain("synthetic-cleanup-key-731");
  });
});

type IsolatedFixture = {
  root: string;
  home: string;
  cacheHome: string;
  kimiCodeHome: string;
};

function isolatedFixture(): IsolatedFixture {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-kimi-cleanup-"));
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  const fixture = {
    root,
    home: join(root, "home"),
    cacheHome: join(root, "cache"),
    kimiCodeHome: join(root, "kimi-code"),
  };
  for (const directory of [
    fixture.home,
    fixture.cacheHome,
    fixture.kimiCodeHome,
  ]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  return fixture;
}

type FileSnapshot = {
  bytes: string;
  mode: number;
  mtimeMs: number;
  size: number;
};

function snapshot(path: string): FileSnapshot {
  const stats = statSync(path);
  return {
    bytes: readFileSync(path, "utf8"),
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}
