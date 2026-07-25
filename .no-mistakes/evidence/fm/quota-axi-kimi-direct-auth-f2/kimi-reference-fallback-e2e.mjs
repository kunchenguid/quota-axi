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

const fixtureRoot = mkdtempSync(join(tmpdir(), "quota-axi-kimi-fallback-evidence-"));
const syntheticHome = join(fixtureRoot, "home");
const authPath = join(syntheticHome, ".pi", "agent", "auth.json");
const cliPath = join(fixtureRoot, "kimi-code", "credentials", "kimi-code.json");
const preloadPath = join(fixtureRoot, "fixed-kimi-response.mjs");
const cliToken = "synthetic-cli-fallback-token-836";
const ambientKey = "ambient-key-must-not-authenticate-628";

try {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(cliPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    authPath,
    JSON.stringify({
      "kimi-coding": { type: "api_key", key: "$KIMI_API_KEY" },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    cliPath,
    JSON.stringify({ access_token: cliToken, expires_at: 4_102_444_800 }),
    { mode: 0o600 },
  );
  writeFileSync(
    preloadPath,
    `globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.kimi.com/coding/v1/usages") throw new Error("wrong endpoint");
  if (new Headers(init.headers).get("authorization") !== "Bearer ${cliToken}") throw new Error("unsafe credential selection");
  return new Response(JSON.stringify({ usage: { limit: 100, used: 25, resetTime: "2099-01-08T00:00:00Z" } }), {
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
        PI_CODING_AGENT_DIR: dirname(authPath),
        KIMI_CODE_HOME: join(fixtureRoot, "kimi-code"),
        KIMI_API_KEY: ambientKey,
        XDG_CACHE_HOME: join(fixtureRoot, "cache"),
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);

  const provider = JSON.parse(result.stdout).providers[0];
  const after = statSync(authPath);
  if (!beforeBytes.equals(readFileSync(authPath))) throw new Error("auth bytes changed");
  if ((before.mode & 0o777) !== (after.mode & 0o777)) throw new Error("auth mode changed");
  if (before.mtimeMs !== after.mtimeMs) throw new Error("auth mtime changed");
  if (result.stdout.includes(cliToken) || result.stdout.includes(ambientKey)) {
    throw new Error("credential leaked to stdout");
  }

  console.log("Command: quota-axi --provider kimi --json --full");
  console.log("Fixture: Pi $KIMI_API_KEY reference, ambient key, and synthetic Kimi CLI fallback");
  console.log(`Exit status: ${result.status}`);
  console.log(`Provider status: ${provider.state.status}`);
  console.log(`Sources tried: ${provider.state.sourcesTried.join(" -> ")}`);
  console.log(`Attempts: ${provider.attempts.map((item) => `${item.source} ${item.status}`).join(", ")}`);
  console.log(`Weekly percent remaining: ${provider.windows[0].percentRemaining}`);
  console.log("Reference handling: Pi environment reference rejected without resolution");
  console.log("Ambient KIMI_API_KEY handling: ignored");
  console.log("Fallback handling: official Kimi Code CLI token selected");
  console.log("Secret redaction: ambient and fallback keys absent from CLI output");
  console.log(
    `Auth file unchanged: bytes=yes mode=${(after.mode & 0o777).toString(8)} mtime=yes`,
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
