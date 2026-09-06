import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI_ENTRYPOINT = resolve("bin/quota-axi.ts");
const GLOBAL_USAGE_URL = "https://api.kimi.ai/coding/v1/usages";
const MAINLAND_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Kimi Code environment resolution", () => {
  it("reads the credential and endpoint of a global (.ai) login", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
type = "kimi"
api_key = "config-api-key-must-not-be-used-401"
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000001"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000001",
      "global-token-517",
    );
    const preload = mockFetch(
      fixture,
      GLOBAL_USAGE_URL,
      "global-token-517",
      20,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("global-token-517");
    expect(result.stdout).not.toContain("config-api-key-must-not-be-used-401");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 80 }],
          state: { status: "fresh" },
          attempts: [
            { source: "pi:kimi-coding", status: "skipped" },
            { source: "kimi-code-cli", status: "success" },
          ],
        },
      ],
    });
  });

  it("probes a stored-expired global (.ai) credential against its own endpoint", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000002"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000002",
      "stale-global-token-624",
      1_000_000_000,
    );
    // The mock rejects any other origin, so a token the store calls expired
    // reaching `.com` - or never being sent at all - fails this test.
    const preload = mockFetch(
      fixture,
      GLOBAL_USAGE_URL,
      "stale-global-token-624",
      40,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("stale-global-token-624");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 60 }],
          state: { status: "fresh" },
          attempts: [
            { source: "pi:kimi-coding", status: "skipped" },
            { source: "kimi-code-cli", status: "success" },
          ],
        },
      ],
    });
  });

  it("keeps the default slot and endpoint when no config.toml exists", () => {
    const fixture = isolatedFixture();
    writeCredential(fixture, "kimi-code", "default-slot-token-338");
    const preload = mockFetch(
      fixture,
      MAINLAND_USAGE_URL,
      "default-slot-token-338",
      25,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("default-slot-token-338");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 75 }],
        },
      ],
    });
  });

  it("keeps the default slot and endpoint for a mainland-China login", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
type = "kimi"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
`,
    );
    writeCredential(fixture, "kimi-code", "mainland-token-926");
    const preload = mockFetch(
      fixture,
      MAINLAND_USAGE_URL,
      "mainland-token-926",
      40,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("mainland-token-926");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 60 }],
        },
      ],
    });
  });

  it("never sends the token to an origin outside Kimi Code's own deployments", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://quota-axi-should-never-reach-this.invalid/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000002"
oauth_host = "https://quota-axi-should-never-reach-this.invalid"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000002",
      "must-not-leave-830",
    );
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["auth", "--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.root, "fetch-was-called"))).toBe(false);
    expect(result.stdout).not.toContain("must-not-leave-830");
    expect(JSON.parse(result.stdout)).toMatchObject({
      auth: [
        {
          provider: "kimi",
          sources: [
            { source: "pi:kimi-coding", status: "missing" },
            {
              source: "kimi-code-cli",
              status: "skipped",
              error: "kimi_code_cli_region_unrecognized",
            },
          ],
        },
      ],
    });
  });

  it("reports a keyring-stored credential as unread rather than absent", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code".oauth]
storage = "keyring"
key = "oauth/kimi-code"
`,
    );
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["auth", "--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.root, "fetch-was-called"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      auth: [
        {
          provider: "kimi",
          sources: [
            { source: "pi:kimi-coding", status: "missing" },
            {
              source: "kimi-code-cli",
              status: "skipped",
              error: "kimi_code_cli_credential_storage_unsupported",
            },
          ],
        },
      ],
    });
  });

  it("reports a configured slot whose credential file is absent as missing", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000003"
oauth_host = "https://auth.kimi.ai"
`,
    );
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["auth", "--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.root, "fetch-was-called"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      auth: [
        {
          provider: "kimi",
          sources: [
            { source: "pi:kimi-coding", status: "missing" },
            { source: "kimi-code-cli", status: "missing" },
          ],
        },
      ],
    });
  });

  it("has no credential-write, process-launch, or network surface", () => {
    const implementation = readFileSync(
      new URL("../src/providers/kimi-code-config.ts", import.meta.url),
      "utf8",
    );

    expect(implementation).not.toMatch(
      /node:child_process|node:https?|\b(?:spawn|execFile|fetch|writeFile|mkdir|rename|unlink)\b|access_token|refresh_token|api_key/,
    );
  });

  it("refuses a configured slot key that would leave the credentials directory", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/../../escaped"
`,
    );
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["auth", "--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.root, "fetch-was-called"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      auth: [
        {
          provider: "kimi",
          sources: [
            { source: "pi:kimi-coding", status: "missing" },
            {
              source: "kimi-code-cli",
              status: "skipped",
              error: "kimi_code_cli_config_invalid",
            },
          ],
        },
      ],
    });
  });

  it("reads the managed provider's own table, not a similarly keyed service", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `default_model = "kimi-code/k3"

[services.moonshot_search]
base_url = "https://api.kimi.ai/coding/v1/search"

[services.moonshot_search.oauth]
storage = "keyring"
key = "oauth/kimi-code-env-decoy00000000001"

[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000004"
oauth_host = "https://auth.kimi.ai"

[[hooks]]
event = "PreToolUse"
command = "echo '[providers.\\"managed:kimi-code\\".oauth]'"
timeout = 5
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000004",
      "table-scoped-token-644",
    );
    const preload = mockFetch(
      fixture,
      GLOBAL_USAGE_URL,
      "table-scoped-token-644",
      10,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("table-scoped-token-644");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 90 }],
        },
      ],
    });
  });
});

type IsolatedFixture = {
  root: string;
  home: string;
  cacheHome: string;
  kimiCodeHome: string;
};

function isolatedFixture(): IsolatedFixture {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-kimi-environment-"));
  temporaryDirectories.push(root);
  const fixture = {
    root,
    home: join(root, "home"),
    cacheHome: join(root, "cache"),
    kimiCodeHome: join(root, "kimi-code"),
  };
  mkdirSync(fixture.home, { mode: 0o700 });
  mkdirSync(fixture.kimiCodeHome, { recursive: true, mode: 0o700 });
  return fixture;
}

function writeConfig(fixture: IsolatedFixture, contents: string): void {
  writeFileSync(join(fixture.kimiCodeHome, "config.toml"), contents, {
    mode: 0o644,
  });
}

function writeCredential(
  fixture: IsolatedFixture,
  name: string,
  accessToken: string,
): void {
  const credentialPath = join(
    fixture.kimiCodeHome,
    "credentials",
    `${name}.json`,
  );
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    credentialPath,
    JSON.stringify({
      access_token: accessToken,
      refresh_token: `ignored-refresh-for-${name}`,
      expires_at: 4_102_444_800,
    }),
    { mode: 0o600 },
  );
}

/** Answers one usage request, and only when origin and bearer both match. */
function mockFetch(
  fixture: IsolatedFixture,
  expectedUrl: string,
  expectedToken: string,
  used: number,
): string {
  const preload = join(fixture.root, "mock-fetch.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = async (input, init) => {
  if (String(input) !== ${JSON.stringify(expectedUrl)}) {
    throw new Error("Unexpected Kimi request origin: " + String(input));
  }
  if (new Headers(init?.headers).get("authorization") !== "Bearer " + ${JSON.stringify(expectedToken)}) {
    throw new Error("Unexpected Kimi credential");
  }
  return new Response(JSON.stringify({
    usage: { limit: 100, used: ${used}, resetTime: "2099-01-08T00:00:00Z" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
    { mode: 0o600 },
  );
  return preload;
}

/** Records that a request happened at all, for the cases where none may. */
function recordingFetch(fixture: IsolatedFixture): string {
  const preload = join(fixture.root, "recording-fetch.mjs");
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";

globalThis.fetch = async (input) => {
  writeFileSync(${JSON.stringify(join(fixture.root, "fetch-was-called"))}, String(input));
  throw new Error("no request was expected");
};
`,
    { mode: 0o600 },
  );
  return preload;
}

function runCli(
  fixture: IsolatedFixture,
  args: string[],
  preload?: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const imports = ["tsx", ...(preload ? [pathToFileURL(preload).href] : [])];
  const result = spawnSync(
    process.execPath,
    [
      ...imports.flatMap((specifier) => ["--import", specifier]),
      CLI_ENTRYPOINT,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        HOME: fixture.home,
        XDG_CACHE_HOME: fixture.cacheHome,
        KIMI_CODE_HOME: fixture.kimiCodeHome,
        PATH: process.env.PATH ?? "",
        ...extraEnv,
      },
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
