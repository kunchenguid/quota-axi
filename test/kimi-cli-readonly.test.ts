import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

  it("does not treat ambient KIMI_API_KEY as a Pi credential source", () => {
    const fixture = isolatedFixture();

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      undefined,
      { KIMI_API_KEY: "ambient-key-must-not-authenticate-628" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(
      "ambient-key-must-not-authenticate-628",
    );
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

  it("uses a Pi-managed credential without changing Pi auth state", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "api_key",
          key: "pi-managed-fixture-key-573",
        },
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
  if (new Headers(init?.headers).get("authorization") !== "Bearer pi-managed-fixture-key-573") {
    throw new Error("Pi-managed credential was not used");
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
    expect(result.stdout).not.toContain("pi-managed-fixture-key-573");
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

  it("names the Pi CLI as the remedy for a soft-expired Pi login and does not launch it", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    const before = JSON.stringify({
      "kimi-coding": {
        type: "oauth",
        access: "synthetic-expired-pi-access",
        refresh: "synthetic-pi-refresh-must-not-leak",
        expires: Date.now() - 60_000,
      },
    });
    writeFileSync(authPath, before, { mode: 0o600 });
    const vendorBin = vendorStubs(fixture);

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json"],
      rejectUsages(fixture),
      { PATH: vendorBin },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(spawnLog(fixture)).toBe("");
    expect(result.stdout).not.toContain("synthetic-pi-refresh-must-not-leak");
    expect(result.stdout).not.toContain("synthetic-expired-pi-access");
    const report = JSON.parse(result.stdout) as {
      help?: string[];
      providers: Array<{ state: Record<string, unknown> }>;
    };
    expect(report.providers[0]?.state).toMatchObject({
      status: "unavailable",
      authStatus: "expired_refreshable",
      error: "pi_kimi_credential_expired",
      reason: "credentials_expired",
      remedyCommand: "pi",
    });
    expect(report.help).toContain(
      "Tell your user: use a Kimi model in `pi` once so Pi refreshes its own Kimi session token; Pi refreshes a provider's token only when that provider is used. quota-axi stays read-only and never rotates Kimi credentials.",
    );

    const toon = runCli(
      fixture,
      ["--provider", "kimi"],
      rejectUsages(fixture),
      {
        PATH: vendorBin,
      },
    );
    expect(toon.stdout).toContain(
      "kimi,all,unavailable,pi_kimi_credential_expired · reason credentials_expired (auth expired_refreshable),pi",
    );
    expect(spawnLog(fixture)).toBe("");

    const readOnly = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--no-credential-refresh"],
      rejectUsages(fixture),
      { PATH: vendorBin },
    );
    expect(readOnly.stdout).toContain('"remedyCommand": "pi"');
    expect(spawnLog(fixture)).toBe("");

    const auth = runCli(
      fixture,
      ["auth", "--provider", "kimi", "--json"],
      undefined,
      { PATH: vendorBin },
    );
    expect(auth.status).toBe(0);
    expect(auth.stdout).not.toContain("synthetic-pi-refresh-must-not-leak");
    expect(spawnLog(fixture)).toBe("");
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });

  it("names the Kimi Code CLI as the remedy when that store is the soft-expired login", () => {
    const fixture = isolatedFixture();
    writeCliCredential(fixture, {
      access_token: "synthetic-expired-cli-access",
      refresh_token: "synthetic-cli-refresh-must-not-leak",
      expires_at: 1,
    });
    const vendorBin = vendorStubs(fixture);

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json", "--full"],
      rejectUsages(fixture),
      { PATH: vendorBin },
    );

    expect(result.status).toBe(1);
    expect(spawnLog(fixture)).toBe("");
    expect(result.stdout).not.toContain("synthetic-cli-refresh-must-not-leak");
    expect(JSON.parse(result.stdout)).toMatchObject({
      help: [
        "Tell your user: run a Kimi Code session with `kimi` once so Kimi Code refreshes its own session token. quota-axi stays read-only and never rotates Kimi credentials.",
      ],
      providers: [
        {
          provider: "kimi",
          state: {
            status: "unavailable",
            authStatus: "expired_refreshable",
            error: "kimi_code_cli_credential_expired",
            reason: "credentials_expired",
            remedyCommand: "kimi",
          },
        },
      ],
    });
  });

  it("keeps the Pi remedy when both Kimi stores are soft-expired", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "oauth",
          access: "synthetic-expired-pi-access",
          refresh: "synthetic-pi-refresh-must-not-leak",
          expires: Date.now() - 60_000,
        },
      }),
      { mode: 0o600 },
    );
    writeCliCredential(fixture, {
      access_token: "synthetic-expired-cli-access",
      refresh_token: "synthetic-cli-refresh-must-not-leak",
      expires_at: 1,
    });

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json"],
      rejectUsages(fixture),
      { PATH: vendorStubs(fixture) },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: [
        {
          state: {
            error: "pi_kimi_credential_expired",
            reason: "credentials_expired",
            remedyCommand: "pi",
          },
        },
      ],
    });
    expect(spawnLog(fixture)).toBe("");
  });

  it("does not advise a hard Kimi sign-out", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "oauth",
          access: "synthetic-revoked-pi-access",
          expires: Date.now() - 60_000,
        },
      }),
      { mode: 0o600 },
    );

    const result = runCli(
      fixture,
      ["--provider", "kimi", "--json"],
      rejectUsages(fixture),
      { PATH: vendorStubs(fixture) },
    );

    const state = (
      JSON.parse(result.stdout) as {
        providers: Array<{ state: Record<string, unknown> }>;
      }
    ).providers[0]?.state;
    expect(state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
    expect(state?.reason).toBeUndefined();
    expect(state?.remedyCommand).toBeUndefined();
    expect(spawnLog(fixture)).toBe("");
  });

  it("keeps the remedy on a stale Kimi snapshot after the login soft-expires", () => {
    const fixture = isolatedFixture();
    const authPath = join(fixture.home, ".pi", "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "oauth",
          access: "synthetic-live-pi-access",
          refresh: "synthetic-pi-refresh-must-not-leak",
          expires: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    );
    const vendorBin = vendorStubs(fixture);
    const fresh = runCli(
      fixture,
      ["--provider", "kimi", "--json"],
      usagesOk(fixture),
      { PATH: vendorBin },
    );
    expect(JSON.parse(fresh.stdout)).toMatchObject({
      providers: [{ state: { status: "fresh" } }],
    });

    writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-coding": {
          type: "oauth",
          access: "synthetic-expired-pi-access",
          refresh: "synthetic-pi-refresh-must-not-leak",
          expires: Date.now() - 60_000,
        },
      }),
      { mode: 0o600 },
    );
    const stale = runCli(
      fixture,
      ["--provider", "kimi", "--json"],
      rejectUsages(fixture),
      { PATH: vendorBin },
    );
    expect(JSON.parse(stale.stdout)).toMatchObject({
      providers: [
        {
          state: {
            status: "stale",
            stale: true,
            authStatus: "expired_refreshable",
            error: "pi_kimi_credential_expired",
            reason: "credentials_expired",
            remedyCommand: "pi",
          },
        },
      ],
    });
    expect(spawnLog(fixture)).toBe("");
    expect(stale.stdout).not.toContain("synthetic-pi-refresh-must-not-leak");
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

function vendorStubs(fixture: IsolatedFixture): string {
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const marker = JSON.stringify(join(fixture.root, "spawned"));
  for (const name of ["pi", "kimi"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho ${name} >> ${marker}\n`, {
      mode: 0o700,
    });
    chmodSync(path, 0o700);
  }
  return bin;
}

function spawnLog(fixture: IsolatedFixture): string {
  const marker = join(fixture.root, "spawned");
  return existsSync(marker) ? readFileSync(marker, "utf8") : "";
}

function writeCliCredential(
  fixture: IsolatedFixture,
  body: Record<string, unknown>,
): void {
  const credentialPath = join(
    fixture.kimiCodeHome,
    "credentials",
    "kimi-code.json",
  );
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
  writeFileSync(credentialPath, JSON.stringify(body), { mode: 0o600 });
}

function rejectUsages(fixture: IsolatedFixture): string {
  return writePreload(
    fixture,
    "reject-usages.mjs",
    `globalThis.fetch = async () => new Response(null, { status: 401 });`,
  );
}

function usagesOk(fixture: IsolatedFixture): string {
  return writePreload(
    fixture,
    "usages-ok.mjs",
    `globalThis.fetch = async () => new Response(JSON.stringify({
      usage: { limit: 100, used: 20, resetTime: "2099-01-08T00:00:00Z" },
    }), { status: 200, headers: { "content-type": "application/json" } });`,
  );
}

function writePreload(
  fixture: IsolatedFixture,
  name: string,
  source: string,
): string {
  const preload = join(fixture.root, name);
  writeFileSync(preload, source, { mode: 0o600 });
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
