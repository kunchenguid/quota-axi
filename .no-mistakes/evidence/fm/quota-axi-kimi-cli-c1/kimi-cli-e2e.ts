import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { main } from "../../../../src/cli.js";
import { PROVIDERS } from "../../../../src/providers/index.js";
import { createKimiAdapter } from "../../../../src/providers/kimi.js";
import { createKimiCodeCliCredentialSource } from "../../../../src/providers/kimi-code-cli-credential.js";

const evidenceDirectory = dirname(new URL(import.meta.url).pathname);
const runtimeDirectory = mkdtempSync(
  join(evidenceDirectory, ".kimi-cli-e2e-runtime-"),
);
const codeHome = join(runtimeDirectory, "kimi-code-home");
const credentialPath = join(codeHome, "credentials", "kimi-code.json");
const accessToken = "E2E-ACCESS-TOKEN-MUST-NOT-LEAK";
const refreshToken = "E2E-REFRESH-TOKEN-MUST-NOT-BE-USED-OR-LEAK";
const now = Date.parse("2027-02-03T04:05:06.000Z");
const requests: Array<Record<string, unknown>> = [];

mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
writeFileSync(
  credentialPath,
  JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: now / 1_000 + 3_600,
  }),
  { mode: 0o600 },
);
const before = snapshot(codeHome);

PROVIDERS.kimi = createKimiAdapter({
  broker: {
    resolve: async () => ({ status: "missing" }),
    inspect: async () => "missing",
  },
  cliCredentialSource: createKimiCodeCliCredentialSource({
    environment: { KIMI_CODE_HOME: codeHome },
    now: () => now,
  }),
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: init?.method,
      redirect: init?.redirect,
      credentials: init?.credentials,
      authorization: headers.get("authorization") === `Bearer ${accessToken}`
        ? "Bearer <redacted expected access_token>"
        : "unexpected",
      cookie: headers.get("cookie"),
      sensitiveHeaders: [...headers.keys()].filter((name) =>
        /device|fingerprint|account|session/i.test(name)
      ),
    });
    return new Response(
      JSON.stringify({
        usage: {
          limit: 640,
          used: 208,
          resetTime: "2027-02-08T17:00:00Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: 80,
              remaining: 68,
              reset_at: "2027-02-03T09:05:06+00:00",
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
  readCachedProvider: () => undefined,
  deleteCachedProvider: () => undefined,
  now: () => now,
});

const chunks: string[] = [];
await main({
  argv: ["--provider", "kimi", "--json", "--full"],
  binPath: "quota-axi",
  stdout: { write: (chunk) => chunks.push(String(chunk)) },
});

const cliOutput = chunks.join("");
const after = snapshot(codeHome);
const secretLeaked = cliOutput.includes(accessToken) ||
  cliOutput.includes(refreshToken);
const credentialStorageUnchanged = JSON.stringify(before) ===
  JSON.stringify(after);

const transcript = [
  "$ quota-axi --provider kimi --json --full",
  cliOutput.trimEnd(),
  "",
  "Observed provider request:",
  JSON.stringify(requests, null, 2),
  "",
  `Secret values present in CLI output: ${secretLeaked}`,
  `Credential storage unchanged after quota read: ${credentialStorageUnchanged}`,
  `Provider requests made: ${requests.length}`,
  "Pi credential result simulated: definitively missing",
  "Kimi Code credential source: real bounded filesystem reader",
  "Provider response: deterministic mocked first-party usage payload",
  "",
].join("\n");

if (secretLeaked || !credentialStorageUnchanged || requests.length !== 1) {
  throw new Error(transcript);
}

writeFileSync(join(evidenceDirectory, "kimi-cli-e2e.txt"), transcript);
process.stdout.write(transcript);
rmSync(runtimeDirectory, { recursive: true, force: true });

function snapshot(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  visit(root, "", result);
  return result;
}

function visit(
  root: string,
  relative: string,
  result: Record<string, unknown>,
): void {
  const directory = join(root, relative);
  for (const name of readdirSync(directory).sort()) {
    const childRelative = join(relative, name);
    const path = join(root, childRelative);
    const metadata = statSync(path);
    if (metadata.isDirectory()) {
      result[`${childRelative}/`] = { mode: metadata.mode & 0o777 };
      visit(root, childRelative, result);
    } else {
      result[childRelative] = {
        mode: metadata.mode & 0o777,
        size: metadata.size,
        sha256: createHash("sha256")
          .update(readFileSync(path))
          .digest("hex"),
      };
    }
  }
}
