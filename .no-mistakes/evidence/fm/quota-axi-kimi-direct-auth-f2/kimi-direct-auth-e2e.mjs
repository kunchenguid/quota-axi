import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const fixtureRoot = mkdtempSync(join(tmpdir(), "quota-axi-kimi-evidence-"));
const syntheticHome = join(fixtureRoot, "home");
const authPath = join(syntheticHome, ".pi", "agent", "auth.json");
const preloadPath = join(fixtureRoot, "fixed-kimi-response.mjs");
const syntheticKey = "synthetic-review-key-573";

try {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    authPath,
    JSON.stringify({
      unrelated: { type: "api_key", key: "must-not-be-used" },
      "kimi-coding": { type: "api_key", key: syntheticKey },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    preloadPath,
    `globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.kimi.com/coding/v1/usages") throw new Error("wrong endpoint");
  if (init?.method !== "GET" || init?.redirect !== "manual" || init?.credentials !== "omit") throw new Error("unsafe request options");
  if (new Headers(init.headers).get("authorization") !== "Bearer ${syntheticKey}") throw new Error("wrong credential");
  return new Response(JSON.stringify({ usage: { limit: 100, used: 12, resetTime: "2099-01-08T00:00:00Z" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
    { mode: 0o600 },
  );

  const beforeBytes = readFileSync(authPath);
  const before = statSync(authPath);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preloadPath,
      resolve("dist/bin/quota-axi.js"),
      "--provider",
      "kimi",
      "--json",
      "--full",
    ],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: syntheticHome,
        PI_CODING_AGENT_DIR: join(syntheticHome, ".pi", "agent"),
        XDG_CACHE_HOME: join(fixtureRoot, "cache"),
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);

  const report = JSON.parse(result.stdout);
  const provider = report.providers[0];
  const afterBytes = readFileSync(authPath);
  const after = statSync(authPath);
  if (!beforeBytes.equals(afterBytes)) throw new Error("auth bytes changed");
  if ((before.mode & 0o777) !== (after.mode & 0o777)) throw new Error("auth mode changed");
  if (before.mtimeMs !== after.mtimeMs) throw new Error("auth mtime changed");
  if (result.stdout.includes(syntheticKey) || result.stdout.includes("must-not-be-used")) {
    throw new Error("credential leaked to stdout");
  }

  console.log("Command: quota-axi --provider kimi --json --full");
  console.log("Fixture: synthetic HOME and Pi auth.json only; fetch intercepted locally");
  console.log(`Exit status: ${result.status}`);
  console.log(`Provider status: ${provider.state.status}`);
  console.log(`Source: ${provider.source}`);
  console.log(`Sources tried: ${provider.state.sourcesTried.join(" -> ")}`);
  console.log(`Attempt: ${provider.attempts[0].source} ${provider.attempts[0].status}`);
  console.log(`Weekly percent remaining: ${provider.windows[0].percentRemaining}`);
  console.log("Request contract: fixed-origin GET, redirects manual, credentials omitted");
  console.log("Credential selection: exact kimi-coding literal key accepted; unrelated entry ignored");
  console.log("Secret redaction: synthetic keys absent from CLI output");
  console.log(
    `Auth file unchanged: bytes=yes mode=${(after.mode & 0o777).toString(8)} mtime=yes`,
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
