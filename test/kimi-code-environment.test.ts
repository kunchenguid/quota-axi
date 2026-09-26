import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(1);
    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("must-not-leave-830");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          windows: [],
          state: {
            status: "error",
            error: "kimi_code_cli_region_unrecognized",
          },
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

  it("leaves the Kimi Code home untouched by a successful reading", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000005"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000005",
      "read-only-token-471",
    );
    const before = snapshotTree(fixture.kimiCodeHome);
    const preload = mockFetch(
      fixture,
      GLOBAL_USAGE_URL,
      "read-only-token-471",
      35,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(snapshotTree(fixture.kimiCodeHome)).toEqual(before);
    expect(result.stdout).not.toContain("read-only-token-471");
    expect(result.stdout).not.toContain("ignored-refresh-for");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 65 }],
        },
      ],
    });
  });

  it("reads a slot named by dotted keys beside an unrelated dotted key", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `default.model = "k2"
default.thinking = true

[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"
oauth.storage = "file"
oauth.key = "oauth/kimi-code-env-synthetic00000006"
oauth.oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000006",
      "dotted-key-token-283",
    );
    const preload = mockFetch(
      fixture,
      GLOBAL_USAGE_URL,
      "dotted-key-token-283",
      45,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("dotted-key-token-283");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 55 }],
        },
      ],
    });
  });

  it("honors an inline OAuth table's storage guard instead of defaulting", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
oauth = { storage = "keyring", key = "oauth/kimi-code-env-synthetic00000007" }
`,
    );
    writeCredential(fixture, "kimi-code", "contradicted-slot-token-604");
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(1);
    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("contradicted-slot-token-604");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: { error: "kimi_code_cli_credential_storage_unsupported" },
        },
      ],
    });
  });

  it("reads the slot an inline OAuth table names", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code-env-synthetic00000008", oauth_host = "https://auth.kimi.ai" }
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000008",
      "inline-table-token-119",
    );
    const preload = mockFetch(
      fixture,
      GLOBAL_USAGE_URL,
      "inline-table-token-119",
      50,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("inline-table-token-119");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 50 }],
        },
      ],
    });
  });

  it("resolves a deployment from the single endpoint a config records", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000009"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000009",
      "half-specified-token-762",
    );
    const preload = mockFetch(
      fixture,
      GLOBAL_USAGE_URL,
      "half-specified-token-762",
      15,
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("half-specified-token-762");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 85 }],
        },
      ],
    });
  });

  it("never pairs the default slot with the other deployment's host", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(fixture, "kimi-code", "mainland-only-token-355");
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(1);
    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("mainland-only-token-355");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: { error: "kimi_code_cli_region_unrecognized" },
        },
      ],
    });
  });

  it("never pairs a suffixed slot with the default deployment's host", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000010"
oauth_host = "https://auth.kimi.com"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000010",
      "global-only-token-287",
    );
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(1);
    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("global-only-token-287");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: { error: "kimi_code_cli_region_unrecognized" },
        },
      ],
    });
  });

  it("assumes no deployment for a suffixed slot that records no endpoint", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000011"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000011",
      "unplaceable-token-640",
    );
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(1);
    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("unplaceable-token-640");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: { error: "kimi_code_cli_config_invalid" },
        },
      ],
    });
  });

  it("assumes no deployment when the scan stops before a suffixed slot's endpoints", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000012"
note = "C:\\Users\\x"
oauth_host = "https://auth.kimi.ai"

[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000012",
      "partial-scan-token-733",
    );
    const preload = recordingFetch(fixture);

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(1);
    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("partial-scan-token-733");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: { error: "kimi_code_cli_config_invalid" },
        },
      ],
    });
  });

  it("never reads a slot a config it could not walk had not yet named", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
type = "kimi"
notes = "this quote is never closed

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000021"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(fixture, "kimi-code", "left-behind-mainland-token-908");
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000021",
      "current-global-token-908",
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      recordingFetch(fixture),
    );

    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("left-behind-mainland-token-908");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: {
            status: "error",
            error: "kimi_code_cli_credential_unconfirmed",
          },
        },
      ],
    });
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

  it("never reads an assumed slot's contents as the current account's quota", () => {
    const fixture = isolatedFixture();
    mkdirSync(join(fixture.kimiCodeHome, "config.toml"), { recursive: true });
    writeCredential(fixture, "kimi-code", "left-behind-mainland-token-512");
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000022",
      "current-global-token-512",
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      recordingFetch(fixture),
    );

    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(result.stdout).not.toContain("left-behind-mainland-token-512");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: {
            status: "error",
            error: "kimi_code_cli_credential_unconfirmed",
          },
        },
      ],
    });
  });

  it("never reads an assumed slot's stale credential as a sign-out", () => {
    const fixture = isolatedFixture();
    writeCredential(fixture, "kimi-code", "mainland-before-switch-628");

    const fresh = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      mockFetch(fixture, MAINLAND_USAGE_URL, "mainland-before-switch-628", 45),
    );
    expect(fresh.status).toBe(0);

    writeCredential(
      fixture,
      "kimi-code",
      "left-behind-expired-token-628",
      1_600_000_000,
    );
    mkdirSync(join(fixture.kimiCodeHome, "config.toml"), { recursive: true });

    const unreadable = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      recordingFetch(fixture),
    );

    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(JSON.parse(unreadable.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          windows: [],
          state: {
            status: "error",
            error: "kimi_code_cli_credential_unconfirmed",
          },
        },
      ],
    });
    // Not a sign-out: the verdict stays `error` rather than `auth_required`,
    // and the snapshot survives for the environment that did produce it.
    expect(cachedProviderIds(fixture)).toContain("kimi");
  });

  it("never serves one deployment's cached numbers for the other", () => {
    const fixture = isolatedFixture();
    writeCredential(fixture, "kimi-code", "mainland-cached-token-401");

    const fresh = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      mockFetch(fixture, MAINLAND_USAGE_URL, "mainland-cached-token-401", 25),
    );
    expect(fresh.status).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({
      providers: [{ provider: "kimi", source: "api" }],
    });

    const sameEnvironment = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      failingFetch(fixture),
    );
    expect(JSON.parse(sameEnvironment.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "cache",
          windows: [{ id: "weekly", percentRemaining: 75 }],
        },
      ],
    });

    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000013"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000013",
      "global-switched-token-866",
    );

    const switched = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      failingFetch(fixture),
    );

    expect(switched.status).toBe(1);
    expect(switched.stdout).not.toContain("global-switched-token-866");
    expect(JSON.parse(switched.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          windows: [],
        },
      ],
    });
  });

  /**
   * Pi brokers a credential for the default endpoint and names no Kimi Code
   * deployment, so its numbers are the default endpoint's. They stay reusable
   * for a later Pi failure and are never handed to a Kimi Code environment that
   * was never contacted, which for a global login would be another region's
   * quota reported as its own.
   */
  it("never serves a Pi reading as a Kimi Code deployment's stale numbers", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-synthetic00000041"
oauth_host = "https://auth.kimi.ai"
`,
    );
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000041",
      "global-cli-token-041",
    );
    writePiCredential(fixture, "pi-brokered-key-041");

    const brokered = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      mockFetch(fixture, MAINLAND_USAGE_URL, "pi-brokered-key-041", 90),
    );
    expect(brokered.status).toBe(0);
    expect(JSON.parse(brokered.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 10 }],
          attempts: [{ source: "pi:kimi-coding", status: "success" }],
        },
      ],
    });

    const brokeredAgain = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      failingFetch(fixture),
    );
    expect(JSON.parse(brokeredAgain.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "cache",
          windows: [{ id: "weekly", percentRemaining: 10 }],
          state: { status: "stale", error: "provider_unavailable" },
        },
      ],
    });

    rmSync(join(fixture.home, ".pi"), { recursive: true, force: true });

    const globalLogin = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      failingFetch(fixture),
    );

    expect(globalLogin.status).toBe(1);
    expect(JSON.parse(globalLogin.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          windows: [],
          state: { status: "error", error: "provider_unavailable" },
        },
      ],
    });
    expect(cachedProviderIds(fixture)).toContain("kimi");
  });

  /**
   * The assumed environment and a mainland login name the same slot on the same
   * host, so an identifier derived from that pair alone would let the mainland
   * account's snapshot be served as this global login's own stale reading. The
   * guess is what named the slot here, and a snapshot filed under a confirmed
   * environment is no more readable through it than a credential sitting in it.
   */
  it("never serves an assumed environment a confirmed one's cached numbers", () => {
    const fixture = isolatedFixture();
    writeCredential(fixture, "kimi-code", "mainland-before-switch-742");

    const fresh = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      mockFetch(fixture, MAINLAND_USAGE_URL, "mainland-before-switch-742", 25),
    );
    expect(fresh.status).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({
      providers: [{ provider: "kimi", source: "api" }],
    });

    rmSync(join(fixture.kimiCodeHome, "credentials"), {
      recursive: true,
      force: true,
    });
    writeCredential(
      fixture,
      "kimi-code-env-synthetic00000014",
      "global-after-switch-193",
    );
    mkdirSync(join(fixture.kimiCodeHome, "config.toml"), { recursive: true });

    const unreadable = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      recordingFetch(fixture),
    );

    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(unreadable.stdout).not.toContain("global-after-switch-193");
    expect(JSON.parse(unreadable.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          windows: [],
          state: {
            status: "error",
            error: "kimi_code_cli_credential_unconfirmed",
          },
        },
      ],
    });
    // Still not a sign-out: the mainland snapshot is withheld, not retired, so
    // the environment that produced it keeps it.
    expect(cachedProviderIds(fixture)).toContain("kimi");
  });

  it("still reports a sign-out when a named slot's credential is gone", () => {
    const fixture = isolatedFixture();
    writeConfig(
      fixture,
      `[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
`,
    );
    writeCredential(fixture, "kimi-code", "mainland-signed-out-508");

    const fresh = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      mockFetch(fixture, MAINLAND_USAGE_URL, "mainland-signed-out-508", 30),
    );
    expect(fresh.status).toBe(0);

    rmSync(join(fixture.kimiCodeHome, "credentials"), {
      recursive: true,
      force: true,
    });

    const signedOut = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      recordingFetch(fixture),
    );

    expect(signedOut.status).toBe(1);
    expect(requestedOrigin(fixture)).toBeUndefined();
    expect(JSON.parse(signedOut.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: { status: "auth_required" },
        },
      ],
    });
    expect(cachedProviderIds(fixture)).not.toContain("kimi");
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
  expiresAt = 4_102_444_800,
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
      expires_at: expiresAt,
    }),
    { mode: 0o600 },
  );
}

/** A Pi `kimi-coding` login, the credential source that outranks the CLI's. */
function writePiCredential(fixture: IsolatedFixture, key: string): void {
  const authPath = join(fixture.home, ".pi", "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    authPath,
    JSON.stringify({ "kimi-coding": { type: "api_key", key } }),
    { mode: 0o600 },
  );
}

/**
 * Every file under a directory with its exact bytes, so a comparison across a
 * read proves nothing was created, rewritten, or rotated in the store.
 */
function snapshotTree(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path);
      else snapshot[path] = readFileSync(join(directory, path), "utf8");
    }
  };
  walk("");
  return snapshot;
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

/** The providers the on-disk quota cache still holds a snapshot for. */
function cachedProviderIds(fixture: IsolatedFixture): string[] {
  const file = join(fixture.cacheHome, "quota-axi", "quotas.json");
  if (!existsSync(file)) return [];
  const payload = JSON.parse(readFileSync(file, "utf8")) as {
    providers?: Array<{ provider?: string }>;
  };
  return (payload.providers ?? []).flatMap((provider) =>
    provider.provider ? [provider.provider] : [],
  );
}

/** Fails every usage request transiently, so only the cache can answer. */
function failingFetch(fixture: IsolatedFixture): string {
  const preload = join(fixture.root, "failing-fetch.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = async () => new Response(null, { status: 503 });
`,
    { mode: 0o600 },
  );
  return preload;
}

/** The origin `recordingFetch` captured, or undefined when none was requested. */
function requestedOrigin(fixture: IsolatedFixture): string | undefined {
  const record = join(fixture.root, "fetch-was-called");
  return existsSync(record) ? readFileSync(record, "utf8") : undefined;
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
