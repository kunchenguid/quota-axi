import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIAL_OVERRIDE_CAPABILITY,
  CREDENTIAL_OVERRIDE_FILE_ENV,
  MAX_OVERRIDE_TOKEN_LENGTH,
  parseCredentialOverrideEnvelope,
  resolveCredentialOverrides,
} from "../src/credential-override.js";

const BUILT_CLI_ENTRYPOINT = resolve("dist/bin/quota-axi.js");
const TOKEN = "synthetic-override-token-9f8e7d6c";
const originalFileEnv = process.env[CREDENTIAL_OVERRIDE_FILE_ENV];
let tempDir: string | undefined;

afterEach(() => {
  if (originalFileEnv === undefined)
    delete process.env[CREDENTIAL_OVERRIDE_FILE_ENV];
  else process.env[CREDENTIAL_OVERRIDE_FILE_ENV] = originalFileEnv;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function envelope(
  credentials: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ schema: 1, credentials, ...extra });
}

function bearer(token: string): Record<string, unknown> {
  return { kind: "bearer", token };
}

describe("credential override envelope parsing", () => {
  it("parses a schema-1 envelope for one provider", () => {
    expect(
      parseCredentialOverrideEnvelope(envelope({ claude: bearer(TOKEN) })),
    ).toEqual({ claude: { kind: "bearer", token: TOKEN } });
  });

  it("parses overrides for several providers in one envelope", () => {
    const parsed = parseCredentialOverrideEnvelope(
      envelope({ claude: bearer("synthetic-a"), kimi: bearer("synthetic-b") }),
    );
    expect(parsed?.claude?.token).toBe("synthetic-a");
    expect(parsed?.kimi?.token).toBe("synthetic-b");
    expect(parsed?.codex).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only input", () => {
    expect(parseCredentialOverrideEnvelope("")).toBeUndefined();
    expect(parseCredentialOverrideEnvelope("  \n\t ")).toBeUndefined();
  });

  it("rejects malformed JSON without echoing token bytes", () => {
    const malformed = `{"schema":1,"credentials":{"claude":{"kind":"bearer","token":"${TOKEN}"`;
    try {
      parseCredentialOverrideEnvelope(malformed);
      expect.unreachable("malformed JSON must be rejected");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("not valid JSON");
      expect(message).not.toContain(TOKEN);
    }
  });

  it.each([
    ["an array root", "[]"],
    ["a string root", '"token"'],
    ["a numeric root", "1"],
    ["a null root", "null"],
  ])("rejects %s as the envelope root", (_label, text) => {
    expect(() => parseCredentialOverrideEnvelope(text)).toThrow(
      "must be a JSON object",
    );
  });

  it("rejects unsupported envelope schema versions", () => {
    for (const schema of [0, 2, "1", undefined]) {
      expect(() =>
        parseCredentialOverrideEnvelope(
          JSON.stringify({ schema, credentials: { claude: bearer(TOKEN) } }),
        ),
      ).toThrow("schema must be 1");
    }
  });

  it("rejects unknown top-level and credential fields", () => {
    expect(() =>
      parseCredentialOverrideEnvelope(
        envelope({ claude: bearer(TOKEN) }, { surprise: true }),
      ),
    ).toThrow("unsupported field: surprise");
    expect(() =>
      parseCredentialOverrideEnvelope(
        envelope({ claude: { ...bearer(TOKEN), tier: "max" } }),
      ),
    ).toThrow("unsupported field: tier");
  });

  it("rejects an envelope that names no providers", () => {
    expect(() => parseCredentialOverrideEnvelope(envelope({}))).toThrow(
      "names no providers",
    );
  });

  it("rejects unsupported provider names", () => {
    expect(() =>
      parseCredentialOverrideEnvelope(envelope({ gemini: bearer(TOKEN) })),
    ).toThrow("unsupported provider: gemini");
  });

  it("rejects non-bearer credential kinds", () => {
    expect(() =>
      parseCredentialOverrideEnvelope(
        envelope({ claude: { kind: "header", token: TOKEN } }),
      ),
    ).toThrow('must use kind "bearer"');
  });

  it("rejects missing, empty, or non-string tokens", () => {
    expect(() =>
      parseCredentialOverrideEnvelope(envelope({ claude: { kind: "bearer" } })),
    ).toThrow("non-empty token");
    expect(() =>
      parseCredentialOverrideEnvelope(envelope({ claude: bearer("   ") })),
    ).toThrow("non-empty token");
    expect(() =>
      parseCredentialOverrideEnvelope(
        envelope({ claude: { kind: "bearer", token: 42 } }),
      ),
    ).toThrow("non-empty token");
  });

  it("rejects tokens with surrounding whitespace, references, or control bytes", () => {
    for (const token of [
      ` ${TOKEN}`,
      `${TOKEN}\n`,
      `!cat /tmp/secret`,
      "$HOME/token",
      `prefix$HOME`,
      `bad${String.fromCharCode(0x1f)}token`,
      `bad${String.fromCharCode(0x7f)}token`,
    ]) {
      expect(() =>
        parseCredentialOverrideEnvelope(envelope({ codex: bearer(token) })),
      ).toThrow(/credential override for codex/);
    }
  });

  it("rejects oversized tokens", () => {
    const token = "x".repeat(MAX_OVERRIDE_TOKEN_LENGTH + 1);
    expect(() =>
      parseCredentialOverrideEnvelope(envelope({ codex: bearer(token) })),
    ).toThrow("exceeds");
    expect(
      parseCredentialOverrideEnvelope(
        envelope({ codex: bearer("x".repeat(MAX_OVERRIDE_TOKEN_LENGTH)) }),
      )?.codex?.token,
    ).toHaveLength(MAX_OVERRIDE_TOKEN_LENGTH);
  });
});

describe("credential override transports", () => {
  it("reads the envelope from the injected stdin transport", () => {
    expect(
      resolveCredentialOverrides({
        stdin: () => envelope({ grok: bearer(TOKEN) }),
        env: {},
      }),
    ).toEqual({ grok: { kind: "bearer", token: TOKEN } });
  });

  it("treats an absent or empty stdin as no envelope", () => {
    expect(
      resolveCredentialOverrides({ stdin: () => undefined, env: {} }),
    ).toBeUndefined();
    expect(
      resolveCredentialOverrides({ stdin: () => " \n", env: {} }),
    ).toBeUndefined();
  });

  it("reads the envelope from a 0600 file named by the environment", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-"));
    const file = join(tempDir, "overrides.json");
    writeFileSync(file, envelope({ copilot: bearer(TOKEN) }), {
      mode: 0o600,
    });
    chmodSync(file, 0o600);

    expect(
      resolveCredentialOverrides({
        stdin: () => undefined,
        env: { [CREDENTIAL_OVERRIDE_FILE_ENV]: file },
      }),
    ).toEqual({ copilot: { kind: "bearer", token: TOKEN } });
  });

  it("rejects a group- or world-readable override file", () => {
    if (process.platform === "win32") return;
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-"));
    const file = join(tempDir, "overrides.json");
    writeFileSync(file, envelope({ copilot: bearer(TOKEN) }));
    chmodSync(file, 0o644);

    expect(() =>
      resolveCredentialOverrides({
        stdin: () => undefined,
        env: { [CREDENTIAL_OVERRIDE_FILE_ENV]: file },
      }),
    ).toThrow("0600");
  });

  it("rejects a missing override file and a directory path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-"));
    expect(() =>
      resolveCredentialOverrides({
        stdin: () => undefined,
        env: { [CREDENTIAL_OVERRIDE_FILE_ENV]: join(tempDir, "missing.json") },
      }),
    ).toThrow("not readable");
    expect(() =>
      resolveCredentialOverrides({
        stdin: () => undefined,
        env: { [CREDENTIAL_OVERRIDE_FILE_ENV]: tempDir },
      }),
    ).toThrow("regular file");
  });

  it("fails closed when both transports carry envelope bytes", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-"));
    const file = join(tempDir, "overrides.json");
    writeFileSync(file, envelope({ copilot: bearer(TOKEN) }), {
      mode: 0o600,
    });

    expect(() =>
      resolveCredentialOverrides({
        stdin: () => envelope({ grok: bearer(TOKEN) }),
        env: { [CREDENTIAL_OVERRIDE_FILE_ENV]: file },
      }),
    ).toThrow("both stdin");
  });

  it("treats an empty override file as no file-side envelope", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-"));
    const file = join(tempDir, "overrides.json");
    writeFileSync(file, "  ", { mode: 0o600 });

    expect(
      resolveCredentialOverrides({
        stdin: () => envelope({ grok: bearer(TOKEN) }),
        env: { [CREDENTIAL_OVERRIDE_FILE_ENV]: file },
      }),
    ).toEqual({ grok: { kind: "bearer", token: TOKEN } });
  });

  it("rejects oversized envelopes", () => {
    const huge = envelope(
      { claude: bearer(TOKEN) },
      {
        padding: "x".repeat(70 * 1024),
      },
    );
    expect(() =>
      resolveCredentialOverrides({ stdin: () => huge, env: {} }),
    ).toThrow("exceeds");
  });
});

describe("credential override CLI contract (spawned)", () => {
  function runCli(
    argv: string[],
    options: { input?: string; env?: NodeJS.ProcessEnv } = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      [BUILT_CLI_ENTRYPOINT, ...argv],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        ...(options.input !== undefined ? { input: options.input } : {}),
        env: options.env ?? process.env,
      },
    );
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it("advertises credentialOverride capabilities in auth --json", () => {
    const { status, stdout } = runCli(
      ["auth", "--provider", "claude", "--json"],
      {
        input: "",
      },
    );
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as {
      schemaVersion: number;
      capabilities: { credentialOverride: unknown };
      auth: { provider: string; sources: { source: string }[] }[];
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.capabilities.credentialOverride).toEqual(
      CREDENTIAL_OVERRIDE_CAPABILITY,
    );
    // No envelope was supplied, so no override source row may appear.
    const claude = report.auth.find((entry) => entry.provider === "claude");
    expect(claude?.sources.some((source) => source.source === "override")).toBe(
      false,
    );
  });

  it("reports the override source row in auth --json when the envelope arrives on stdin", () => {
    const { status, stdout } = runCli(
      ["auth", "--provider", "claude", "--json"],
      { input: envelope({ claude: bearer(TOKEN) }) },
    );
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as {
      auth: {
        provider: string;
        sources: {
          source: string;
          status: string;
          credentialPresent?: boolean;
        }[];
      }[];
    };
    const claude = report.auth.find((entry) => entry.provider === "claude");
    expect(claude?.sources).toContainEqual({
      source: "override",
      status: "available",
      credentialPresent: true,
    });
    expect(stdout).not.toContain(TOKEN);
  });

  it("rejects a malformed stdin envelope with exit 2 and never echoes token bytes", () => {
    const malformed = `{"schema":1,"credentials":{"claude":{"kind":"bearer","token":"${TOKEN}"`;
    const { status, stdout, stderr } = runCli(
      ["--provider", "claude", "--json"],
      {
        input: malformed,
      },
    );
    expect(status).toBe(2);
    expect(`${stdout}${stderr}`).toContain("not valid JSON");
    expect(`${stdout}${stderr}`).not.toContain(TOKEN);
  });

  it("rejects using stdin and the file transport together with exit 2", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-e2e-"));
    const file = join(tempDir, "overrides.json");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(file, envelope({ claude: bearer("synthetic-file-token") }), {
      mode: 0o600,
    });

    const { status, stdout, stderr } = runCli(
      ["auth", "--provider", "claude", "--json"],
      {
        input: envelope({ claude: bearer(TOKEN) }),
        env: {
          ...process.env,
          [CREDENTIAL_OVERRIDE_FILE_ENV]: file,
        },
      },
    );
    expect(status).toBe(2);
    expect(`${stdout}${stderr}`).toContain("both stdin");
    expect(`${stdout}${stderr}`).not.toContain(TOKEN);
    expect(`${stdout}${stderr}`).not.toContain("synthetic-file-token");
  });

  it("rejects an insecure override file with exit 2", () => {
    if (process.platform === "win32") return;
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-override-e2e-"));
    const file = join(tempDir, "overrides.json");
    writeFileSync(file, envelope({ claude: bearer(TOKEN) }));
    chmodSync(file, 0o644);

    const { status, stdout, stderr } = runCli(
      ["auth", "--provider", "claude", "--json"],
      {
        input: "",
        env: { ...process.env, [CREDENTIAL_OVERRIDE_FILE_ENV]: file },
      },
    );
    expect(status).toBe(2);
    expect(`${stdout}${stderr}`).toContain("0600");
    expect(`${stdout}${stderr}`).not.toContain(TOKEN);
  });
});
