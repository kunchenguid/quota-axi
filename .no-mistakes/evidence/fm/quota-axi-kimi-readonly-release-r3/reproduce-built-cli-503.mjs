import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";

const syntheticSecret = "synthetic-cleanup-key-731";
const root = mkdtempSync(join(tmpdir(), "quota-axi-kimi-evidence-"));
const home = join(root, "home");
const cacheHome = join(root, "cache");
const kimiCodeHome = join(root, "kimi-code");
const authPath = join(home, ".pi", "agent", "auth.json");
const preloadPath = join(root, "synthetic-503-fetch.mjs");
const markerPath = join(root, "response-cleanup.json");
const transcriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "built-cli-synthetic-503.txt",
);

try {
  for (const directory of [home, cacheHome, kimiCodeHome, dirname(authPath)]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  chmodSync(root, 0o700);
  writeFileSync(
    authPath,
    JSON.stringify({
      "kimi-coding": { type: "api_key", key: syntheticSecret },
    }),
    { mode: 0o600 },
  );
  const authBefore = snapshot(authPath);

  writeFileSync(
    preloadPath,
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
      headers.get("authorization") === "Bearer ${syntheticSecret}",
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
      pathToFileURL(preloadPath).href,
      resolve("dist/bin/quota-axi.js"),
      "--provider",
      "kimi",
      "--json",
      "--full",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        HOME: home,
        XDG_CACHE_HOME: cacheHome,
        KIMI_CODE_HOME: kimiCodeHome,
        KIMI_CLEANUP_MARKER: markerPath,
        PATH: process.env.PATH ?? "",
      },
    },
  );
  if (result.error) throw result.error;

  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const authUnchanged = JSON.stringify(snapshot(authPath)) === JSON.stringify(authBefore);
  const cacheEntries = readdirSync(cacheHome);
  const secretRedacted = !result.stdout.includes(syntheticSecret);

  assert(result.status === 1, `expected CLI exit 1, received ${result.status}`);
  assert(result.stderr === "", `expected empty stderr, received ${result.stderr}`);
  assert(marker.cancelCount === 1, "response cancellation count was not exactly one");
  assert(marker.cleanupCompleted === true, "response cleanup did not complete before CLI exit");
  assert(
    JSON.stringify(marker.request) ===
      JSON.stringify({
        url: "https://api.kimi.com/coding/v1/usages",
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        authorizationMatches: true,
      }),
    "request contract changed",
  );
  assert(authUnchanged, "synthetic Pi credential state changed");
  assert(cacheEntries.length === 0, "cache state changed");
  assert(secretRedacted, "synthetic secret appeared in CLI output");

  const transcript = [
    "$ node --import <synthetic-503-fetch> dist/bin/quota-axi.js --provider kimi --json --full",
    `exitCode: ${result.status}`,
    "stderr: <empty>",
    "stdout:",
    JSON.stringify(JSON.parse(result.stdout), null, 2),
    "responseCleanup:",
    JSON.stringify(marker, null, 2),
    `credentialStateUnchanged: ${authUnchanged}`,
    `cacheEntries: ${JSON.stringify(cacheEntries)}`,
    `syntheticSecretRedacted: ${secretRedacted}`,
    "externalNetworkContact: false (global fetch was replaced before CLI startup)",
    "result: PASS",
    "",
  ].join("\n");
  writeFileSync(transcriptPath, transcript, { mode: 0o600 });
  process.stdout.write(transcript);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function snapshot(path) {
  const stats = statSync(path);
  return {
    bytes: readFileSync(path, "utf8"),
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
