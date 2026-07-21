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
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Kimi CLI credential inspection is read-only", () => {
  it("does not create Pi auth state while inspecting auth in an empty home", () => {
    const fixture = isolatedFixture();

    const result = runCli(fixture, [
      "auth",
      "--provider",
      "kimi",
      "--json",
      "--full",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(fixture.home, ".pi"))).toBe(false);
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

  it("does not create Pi auth state while inspecting quota in an empty home", () => {
    const fixture = isolatedFixture();

    const result = runCli(fixture, ["--provider", "kimi", "--json", "--full"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(existsSync(join(fixture.home, ".pi"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "unavailable",
          state: {
            status: "auth_required",
            sourcesTried: ["pi:kimi-coding", "kimi-code-cli"],
          },
        },
      ],
    });
  });

  it("reaches a Kimi Code CLI fallback before any Pi state exists", () => {
    const fixture = isolatedFixture();
    const credentialPath = join(
      fixture.kimiCodeHome,
      "credentials",
      "kimi-code.json",
    );
    mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      credentialPath,
      JSON.stringify({
        access_token: "synthetic-cli-token-836",
        refresh_token: "ignored-refresh-token-219",
        expires_at: 4_102_444_800,
      }),
      { mode: 0o600 },
    );
    const preload = join(fixture.root, "mock-kimi-fetch.mjs");
    writeFileSync(
      preload,
      `import { existsSync } from "node:fs";
import { join } from "node:path";

globalThis.fetch = async (input, init) => {
  if (existsSync(join(process.env.HOME, ".pi"))) {
    throw new Error("Pi state existed before Kimi Code CLI fallback");
  }
  if (String(input) !== "https://api.kimi.com/coding/v1/usages") {
    throw new Error("Unexpected Kimi request origin");
  }
  if (init?.method !== "GET" || init?.redirect !== "manual" || init?.credentials !== "omit") {
    throw new Error("Unexpected Kimi request options");
  }
  return new Response(JSON.stringify({
    usage: { limit: 100, used: 20, resetTime: "2099-01-08T00:00:00Z" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
      { mode: 0o600 },
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(fixture.home, ".pi"))).toBe(false);
    expect(result.stdout).not.toContain("synthetic-cli-token-836");
    expect(result.stdout).not.toContain("ignored-refresh-token-219");
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 80 }],
          state: {
            status: "fresh",
            sourcesTried: ["pi:kimi-coding", "kimi-code-cli"],
          },
          attempts: [
            { source: "pi:kimi-coding", status: "skipped" },
            { source: "kimi-code-cli", status: "success" },
          ],
        },
      ],
    });
  });

  it("resolves a Pi environment reference without exposing credential data", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": { type: "api_key", key: "$KIMI_API_KEY" },
      }),
      { mode: 0o600 },
    );
    const preload = join(fixture.root, "mock-pi-reference-fetch.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.kimi.com/coding/v1/usages") {
    throw new Error("Unexpected Kimi request origin");
  }
  if (new Headers(init?.headers).get("authorization") !== "Bearer pi-reference-fixture-key-628") {
    throw new Error("Pi reference was not resolved at request time");
  }
  return new Response(JSON.stringify({
    usage: { limit: 100, used: 15, resetTime: "2099-01-08T00:00:00Z" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
      { mode: 0o600 },
    );
    const before = readFileSync(authPath, "utf8");

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
      { KIMI_API_KEY: "pi-reference-fixture-key-628" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("pi-reference-fixture-key-628");
    expect(result.stdout).not.toContain("$KIMI_API_KEY");
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 85 }],
          state: {
            status: "fresh",
            sourcesTried: ["pi:kimi-coding"],
          },
        },
      ],
    });
  });

  it("trims and redacts newline-terminated Pi command output", () => {
    const fixture = isolatedFixture();
    const commandPath = join(fixture.root, "newline-credential-command.mjs");
    writeFileSync(
      commandPath,
      'process.stdout.write("newline-command-fixture-key-573\\n");\n',
      { mode: 0o600 },
    );
    const command = `!${JSON.stringify(process.execPath)} ${JSON.stringify(commandPath)}`;
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": { type: "api_key", key: command },
      }),
      { mode: 0o600 },
    );
    const preload = join(fixture.root, "mock-command-reference-fetch.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.kimi.com/coding/v1/usages") {
    throw new Error("Unexpected Kimi request origin");
  }
  if (new Headers(init?.headers).get("authorization") !== "Bearer newline-command-fixture-key-573") {
    throw new Error("Pi command output was not trimmed");
  }
  return new Response(JSON.stringify({
    usage: { limit: 100, used: 5, resetTime: "2099-01-08T00:00:00Z" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
      { mode: 0o600 },
    );
    const before = readFileSync(authPath, "utf8");

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("newline-command-fixture-key-573");
    expect(result.stdout).not.toContain(command);
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 95 }],
          state: {
            status: "fresh",
            sourcesTried: ["pi:kimi-coding"],
          },
        },
      ],
    });
  });

  it("falls back to Kimi Code CLI for an unresolved Pi reference", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "api_key",
          key: "$MISSING_PI_KIMI_REFERENCE_462",
        },
      }),
      { mode: 0o600 },
    );
    const credentialPath = join(
      fixture.kimiCodeHome,
      "credentials",
      "kimi-code.json",
    );
    mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      credentialPath,
      JSON.stringify({
        access_token: "fallback-cli-token-714",
        refresh_token: "ignored-fallback-refresh-221",
        expires_at: 4_102_444_800,
      }),
      { mode: 0o600 },
    );
    const preload = join(fixture.root, "mock-unresolved-reference-fetch.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.kimi.com/coding/v1/usages") {
    throw new Error("Unexpected Kimi request origin");
  }
  if (new Headers(init?.headers).get("authorization") !== "Bearer fallback-cli-token-714") {
    throw new Error("Unresolved Pi reference did not fall back safely");
  }
  return new Response(JSON.stringify({
    usage: { limit: 100, used: 10, resetTime: "2099-01-08T00:00:00Z" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
      { mode: 0o600 },
    );
    const before = readFileSync(authPath, "utf8");

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      preload,
      { KIMI_API_KEY: "ambient-key-must-not-win-558" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("MISSING_PI_KIMI_REFERENCE_462");
    expect(result.stdout).not.toContain("fallback-cli-token-714");
    expect(result.stdout).not.toContain("ignored-fallback-refresh-221");
    expect(result.stdout).not.toContain("ambient-key-must-not-win-558");
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          provider: "kimi",
          source: "api",
          windows: [{ id: "weekly", percentRemaining: 90 }],
          state: {
            status: "fresh",
            sourcesTried: ["pi:kimi-coding", "kimi-code-cli"],
          },
          attempts: [
            { source: "pi:kimi-coding", status: "skipped" },
            { source: "kimi-code-cli", status: "success" },
          ],
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
  const root = mkdtempSync(join(tmpdir(), "quota-axi-kimi-cli-readonly-"));
  temporaryDirectories.push(root);
  const fixture = {
    root,
    home: join(root, "home"),
    cacheHome: join(root, "cache"),
    kimiCodeHome: join(root, "kimi-code"),
  };
  mkdirSync(fixture.home, { mode: 0o700 });
  return fixture;
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
