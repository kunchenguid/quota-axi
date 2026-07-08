import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const evidenceDir = join(
  root,
  ".no-mistakes",
  "evidence",
  "fm",
  "quota-axi-keychain-default-read-k7",
);
const runtimeDir = join(evidenceDir, "runtime");
const fakeBin = join(runtimeDir, "bin");
const fakeHome = join(runtimeDir, "home");
const xdgCacheHome = join(runtimeDir, "cache");
const callLog = join(evidenceDir, "security-calls.log");
const fakeToken = `TEST_TOKEN_${randomUUID()}`;

rmSync(runtimeDir, { recursive: true, force: true });
rmSync(callLog, { force: true });
mkdirSync(fakeBin, { recursive: true });
mkdirSync(fakeHome, { recursive: true });
mkdirSync(xdgCacheHome, { recursive: true });

const securityScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$SECURITY_CALL_LOG"
if [ "$1" = "find-generic-password" ] && [ "$2" = "-s" ] && [ "$3" = "Claude Code-credentials" ] && [ "$4" = "-w" ]; then
  printf '%s\\n' '{"claudeAiOauth":{"accessToken":"${fakeToken}","expiresAt":"2035-01-01T00:00:00.000Z","plan":"pro"}}'
  exit 0
fi
if [ "$1" = "find-generic-password" ] && [ "$2" = "-s" ] && [ "$3" = "Claude Code-credentials" ]; then
  printf '%s\\n' 'keychain item present'
  exit 0
fi
exit 2
`;

const securityPath = join(fakeBin, "security");
writeFileSync(securityPath, securityScript);
chmodSync(securityPath, 0o700);
writeFileSync(callLog, "");

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.XDG_CACHE_HOME = xdgCacheHome;
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
process.env.SECURITY_CALL_LOG = callLog;
Object.defineProperty(process, "platform", {
  configurable: true,
  value: "darwin",
});

const observedAuthorization = [];
let fetchCount = 0;
globalThis.fetch = async (_url, init = {}) => {
  fetchCount += 1;
  const headers = init.headers ?? {};
  const authorization =
    headers instanceof Headers
      ? headers.get("authorization")
      : (headers.authorization ?? headers.Authorization);
  observedAuthorization.push(authorization === `Bearer ${fakeToken}`);
  const utilization = fetchCount === 1 ? 12 : 7;
  return new Response(
    JSON.stringify({
      five_hour: {
        utilization,
        resets_at: "2035-01-01T05:00:00.000Z",
      },
    }),
    { status: 200 },
  );
};

const { main } = await import(pathToFileURL(join(root, "src", "cli.ts")).href);

async function runCli(label, argv) {
  const chunks = [];
  process.exitCode = undefined;
  await main({
    argv,
    binPath: "quota-axi",
    stdout: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  });
  const text = chunks.join("");
  writeFileSync(join(evidenceDir, `${label}.json`), text);
  const parsed = JSON.parse(text);
  const exitCode = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { exitCode, parsed, text };
}

const withoutMarker = await runCli("01-plain-without-marker", [
  "--provider",
  "claude",
  "--json",
  "--full",
]);

const markerPath = join(
  xdgCacheHome,
  "quota-axi",
  "claude-keychain-access-granted",
);
const markerBeforeBootstrap = existsSync(markerPath);

const bootstrap = await runCli("02-bootstrap-with-allow-keychain-prompt", [
  "--provider",
  "claude",
  "--json",
  "--full",
  "--allow-keychain-prompt",
]);
const cacheAfterBootstrapPath = join(xdgCacheHome, "quota-axi", "quotas.json");
writeFileSync(
  join(evidenceDir, "cache-after-bootstrap.json"),
  readFileSync(cacheAfterBootstrapPath, "utf-8"),
);

const plainAfterMarker = await runCli("03-plain-after-marker", [
  "--provider",
  "claude",
  "--json",
  "--full",
]);
const cacheAfterPlainPath = join(xdgCacheHome, "quota-axi", "quotas.json");
writeFileSync(
  join(evidenceDir, "cache-after-plain-marker.json"),
  readFileSync(cacheAfterPlainPath, "utf-8"),
);

const securityCalls = readFileSync(callLog, "utf-8")
  .trim()
  .split("\n")
  .filter(Boolean);
const markerMode = existsSync(markerPath)
  ? (statSync(markerPath).mode & 0o777).toString(8).padStart(4, "0")
  : "missing";

const tokenRendered =
  withoutMarker.text.includes(fakeToken) ||
  bootstrap.text.includes(fakeToken) ||
  plainAfterMarker.text.includes(fakeToken) ||
  readFileSync(cacheAfterPlainPath, "utf-8").includes(fakeToken);

const summary = {
  cliFlow: [
    {
      command: "quota-axi --provider claude --json --full",
      exitCode: withoutMarker.exitCode,
      status: withoutMarker.parsed.providers[0]?.state?.status,
      reason: withoutMarker.parsed.providers[0]?.state?.reason,
      remedyCommand: withoutMarker.parsed.providers[0]?.state?.remedyCommand,
      keychainAttempt: withoutMarker.parsed.providers[0]?.attempts?.find(
        (attempt) => attempt.source === "keychain",
      ),
      markerExistsBeforeBootstrap: markerBeforeBootstrap,
    },
    {
      command:
        "quota-axi --provider claude --json --full --allow-keychain-prompt",
      exitCode: bootstrap.exitCode,
      status: bootstrap.parsed.providers[0]?.state?.status,
      reason: bootstrap.parsed.providers[0]?.state?.reason ?? "none",
      markerMode,
      cachePercentUsed: JSON.parse(
        readFileSync(join(evidenceDir, "cache-after-bootstrap.json"), "utf-8"),
      ).providers[0]?.windows[0]?.percentUsed,
    },
    {
      command: "quota-axi --provider claude --json --full",
      exitCode: plainAfterMarker.exitCode,
      status: plainAfterMarker.parsed.providers[0]?.state?.status,
      reason: plainAfterMarker.parsed.providers[0]?.state?.reason ?? "none",
      cachePercentUsed: JSON.parse(
        readFileSync(
          join(evidenceDir, "cache-after-plain-marker.json"),
          "utf-8",
        ),
      ).providers[0]?.windows[0]?.percentUsed,
    },
  ],
  securityCalls,
  oauthFetches: fetchCount,
  authorizationHeaderObservedAndRedacted: observedAuthorization,
  tokenRenderedInCliOrCacheOutput: tokenRendered,
  markerPath: markerPath.replace(root, "."),
  cachePath: cacheAfterPlainPath.replace(root, "."),
};

writeFileSync(
  join(evidenceDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

const markdown = `# quota-axi Claude Keychain Default Read Evidence

This evidence runs the actual CLI entrypoint with a fake macOS \`security\` command and a fake Claude OAuth usage API.
The fake Keychain value contains a sentinel token, and the harness checks that the token is not rendered in CLI output or cache files.

## CLI flow

| Step | Command | Exit | Provider status | Advice | Cache percent |
| --- | --- | ---: | --- | --- | ---: |
| 1 | \`quota-axi --provider claude --json --full\` | ${withoutMarker.exitCode} | ${withoutMarker.parsed.providers[0]?.state?.status} | ${withoutMarker.parsed.providers[0]?.state?.reason} | n/a |
| 2 | \`quota-axi --provider claude --json --full --allow-keychain-prompt\` | ${bootstrap.exitCode} | ${bootstrap.parsed.providers[0]?.state?.status} | ${bootstrap.parsed.providers[0]?.state?.reason ?? "none"} | ${summary.cliFlow[1].cachePercentUsed} |
| 3 | \`quota-axi --provider claude --json --full\` | ${plainAfterMarker.exitCode} | ${plainAfterMarker.parsed.providers[0]?.state?.status} | ${plainAfterMarker.parsed.providers[0]?.state?.reason ?? "none"} | ${summary.cliFlow[2].cachePercentUsed} |

## Security command calls

\`\`\`text
${securityCalls.join("\n")}
\`\`\`

## Checks

- The first plain call had no marker and only ran the non-secret presence check.
- The first plain call emitted \`keychain_access_required\` advice with the \`quota-axi --allow-keychain-prompt\` remedy.
- The bootstrap call used \`security find-generic-password -w\`, returned fresh quota, and created the marker with mode \`${markerMode}\`.
- The later plain call reused the marker, used \`security find-generic-password -w\`, returned fresh quota, and refreshed the cache to \`${summary.cliFlow[2].cachePercentUsed}\` percent used.
- The sentinel token was observed in OAuth authorization headers but was not rendered in CLI output or cache files: \`${!tokenRendered}\`.
`;

writeFileSync(join(evidenceDir, "summary.md"), markdown);

if (
  !securityCalls[0] ||
  securityCalls[0].endsWith(" -w") ||
  securityCalls[1] !== "find-generic-password -s Claude Code-credentials -w" ||
  securityCalls[2] !== "find-generic-password -s Claude Code-credentials -w" ||
  markerBeforeBootstrap ||
  markerMode !== "0600" ||
  withoutMarker.parsed.providers[0]?.state?.reason !==
    "keychain_access_required" ||
  bootstrap.parsed.providers[0]?.state?.status !== "fresh" ||
  plainAfterMarker.parsed.providers[0]?.state?.status !== "fresh" ||
  summary.cliFlow[2].cachePercentUsed !== 7 ||
  tokenRendered ||
  observedAuthorization.some((observed) => !observed)
) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}

rmSync(fakeBin, { recursive: true, force: true });
rmSync(fakeHome, { recursive: true, force: true });

console.log(JSON.stringify(summary, null, 2));
