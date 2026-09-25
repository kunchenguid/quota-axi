import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuota, SourceAttempt } from "../src/types.js";

/**
 * The cross-provider invariant every multi-source adapter has to hold, checked
 * against the real adapters rather than one provider's hand-written fixture.
 *
 * `credentialPresent` is what makes a broken-but-superseded store visible as a
 * degraded source, and it is currently re-derived at each adapter's own call
 * sites. That is exactly how a present-but-structurally-invalid Pi entry once
 * read as absence in four separate files. This table fails when any provider
 * regresses either half of the rule:
 *
 *   absent store              -> no `credentialPresent`, nothing degraded
 *   present but not working   -> `credentialPresent: true`, degraded
 *
 * and when a stored-expired credential is skipped instead of probed.
 */

type PiProviderCase = {
  provider: "codex" | "kimi" | "grok" | "opencode-go" | "mimo";
  /** Property name Pi stores this provider's credential under. */
  piKey: string;
  /** Attempt source name the adapter reports for its Pi store. */
  piSource: string;
  /** Credential used to exercise advisory stored expiry, when applicable. */
  expiredProbe?: {
    entry: Record<string, unknown>;
    token: string;
  };
};

const CASES: PiProviderCase[] = [
  {
    provider: "codex",
    piKey: "openai-codex",
    piSource: "pi:openai-codex",
    expiredProbe: {
      token: "pi-codex-probe-token",
      entry: {
        type: "oauth",
        access: "pi-codex-probe-token",
        refresh: "must-not-be-read",
        accountId: "acct-contract-fixture",
      },
    },
  },
  {
    provider: "kimi",
    piKey: "kimi-coding",
    piSource: "pi:kimi-coding",
    expiredProbe: {
      token: "pi-kimi-probe-token",
      entry: {
        type: "oauth",
        access: "pi-kimi-probe-token",
        refresh: "must-not-be-read",
      },
    },
  },
  {
    provider: "grok",
    piKey: "xai",
    piSource: "pi:xai",
    expiredProbe: {
      token: "pi-xai-probe-token",
      entry: {
        type: "oauth",
        access: "pi-xai-probe-token",
        refresh: "must-not-be-read",
      },
    },
  },
  {
    provider: "opencode-go",
    piKey: "opencode-go",
    piSource: "pi:opencode-go",
  },
  {
    provider: "mimo",
    piKey: "xiaomi",
    piSource: "pi:xiaomi",
  },
];

/** Present-but-unusable Pi entries: none of these is an absent source. */
const BROKEN_ENTRIES: Array<[label: string, entry: unknown]> = [
  ["empty object", {}],
  ["null", null],
  ["array", []],
  ["scalar", "token"],
  ["unknown type", { type: "totally-unknown", access: "x" }],
];

const ENV_KEYS = [
  "CODEX_HOME",
  "QUOTA_AXI_CODEX_BINARY",
  "PI_CODING_AGENT_DIR",
  "KIMI_CODE_HOME",
  "GROK_HOME",
  "GROK_AUTH",
  "GROK_AUTH_JSON",
  "GROK_AUTH_PATH",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "GITHUB_COPILOT_APPS_JSON",
  "GH_CONFIG_DIR",
  "ELEVENLABS_API_KEY",
  "MIMO_API_KEY",
  "WINDSURF_API_KEY",
  "WINDSURF_API_SERVER_URL",
  "QUOTA_AXI_OPENCODE_GO_PI_AUTH",
  "COPILOT_HOME",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-credential-contract-"));
  // Every store points into the sandbox, so the machine's real credentials
  // never decide a result here.
  process.env.CODEX_HOME = join(tempDir, "codex");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  process.env.KIMI_CODE_HOME = join(tempDir, "kimi-code");
  process.env.GROK_HOME = join(tempDir, "grok");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.XDG_DATA_HOME = join(tempDir, "data");
  process.env.QUOTA_AXI_CODEX_BINARY = join(tempDir, "no-such-codex");
  process.env.GITHUB_COPILOT_APPS_JSON = join(
    tempDir,
    "github-copilot",
    "apps.json",
  );
  process.env.GH_CONFIG_DIR = join(tempDir, "gh");
  // OpenCode Go reads its Pi store only behind this opt-in; the contract here
  // exercises that real file-to-adapter path.
  process.env.QUOTA_AXI_OPENCODE_GO_PI_AUTH = "1";
  process.env.COPILOT_HOME = join(tempDir, "copilot");
  delete process.env.GROK_AUTH;
  delete process.env.GROK_AUTH_JSON;
  delete process.env.GROK_AUTH_PATH;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.MIMO_API_KEY;
  delete process.env.WINDSURF_API_KEY;
  delete process.env.WINDSURF_API_SERVER_URL;
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  vi.doMock("../src/lib/process.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/process.js")>()),
    findCommandPath: vi.fn(async () => undefined),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/lib/process.js");
  vi.doUnmock("../src/providers/copilot-cli-credential.js");
  vi.resetModules();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function writePiStore(store: unknown): void {
  const dir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(store), { mode: 0o600 });
}

/** Rejects every bearer, so only credential enrolment is under test here. */
function stubRejectingApi(): { bearers: string[] } {
  const bearers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(null, { status: 401 });
    }),
  );
  return { bearers };
}

async function readQuota(provider: string): Promise<ProviderQuota> {
  const { PROVIDERS } = await import("../src/providers/index.js");
  return PROVIDERS[provider as keyof typeof PROVIDERS].fetchQuota({
    allowKeychainPrompt: false,
    refreshCredentials: false,
  });
}

const attemptsFor = (result: ProviderQuota, source: string): SourceAttempt[] =>
  (result.attempts ?? []).filter((attempt) => attempt.source === source);

describe("credential source contract", { timeout: 30_000 }, () => {
  describe.each(CASES)("$provider", (testCase) => {
    it("leaves an absent Pi entry unmarked, so nothing reads as degraded", async () => {
      // A store that exists but holds no entry for this provider: the machine
      // simply does not use Pi for it.
      writePiStore({ "some-other-provider": { type: "oauth" } });
      stubRejectingApi();

      const result = await readQuota(testCase.provider);

      for (const attempt of attemptsFor(result, testCase.piSource)) {
        expect(attempt.credentialPresent).toBeUndefined();
      }
    });

    it.each(BROKEN_ENTRIES)(
      "marks a present but broken Pi entry (%s) as a credential that exists",
      async (_label, entry) => {
        writePiStore({ [testCase.piKey]: entry });
        stubRejectingApi();

        const result = await readQuota(testCase.provider);
        const piAttempts = attemptsFor(result, testCase.piSource);

        expect(piAttempts.length).toBeGreaterThan(0);
        for (const attempt of piAttempts) {
          expect(attempt.credentialPresent).toBe(true);
        }
      },
    );

    const expiredProbe = testCase.expiredProbe;
    if (expiredProbe) {
      it("probes a stored-expired Pi credential instead of skipping it", async () => {
        // Stored expiry is advisory ordering. The endpoint, not the `expires`
        // field, is the only thing allowed to produce an auth verdict.
        writePiStore({
          [testCase.piKey]: {
            ...expiredProbe.entry,
            expires: Date.now() - 1,
          },
        });
        const api = stubRejectingApi();

        await readQuota(testCase.provider);

        expect(api.bearers).toContain(`Bearer ${expiredProbe.token}`);
      });
    }
  });

  /**
   * Copilot source ordering and unsupported-storage verdicts are documented
   * in README Provider notes. Present but unusable stores must remain visible
   * when a sibling source answers.
   */
  describe("copilot", () => {
    it.each([
      "credential_not_found",
      "credential_logon_session_unavailable",
      "credential_binding_mismatch",
    ] as const)("keeps Windows %s visible when gh answers", async (reason) => {
      const dir = join(tempDir, ".copilot");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          lastLoggedInUser: {
            host: "https://github.com",
            login: "synthetic-user",
          },
        }),
      );
      vi.doMock(
        "../src/providers/copilot-cli-credential.js",
        async (importOriginal) => {
          const native =
            await importOriginal<
              typeof import("../src/providers/copilot-cli-credential.js")
            >();
          return {
            ...native,
            resolveCopilotCliCredential: (
              options: Parameters<typeof native.resolveCopilotCliCredential>[0],
              presenceOnly: boolean,
            ) =>
              native.resolveCopilotCliCredential(options, presenceOnly, {
                platform: "win32",
                environment: {},
                homeDirectory: () => tempDir,
                hasGrant: () => true,
                readWindows: async () => ({ status: "unavailable", reason }),
              }),
          };
        },
      );
      writeGhHosts("github.com:\n  oauth_token: gho_synthetic\n");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ copilot_plan: "individual" })),
        ),
      );
      const result = await readQuota("copilot");
      expect(result.state.status).toBe("fresh");
      expect(attemptsFor(result, "copilot-cli:keychain")[0]).toMatchObject({
        error: reason,
        credentialPresent: true,
      });
      expect(attemptsFor(result, "gh:hosts.yml")[0].status).toBe("success");
    });

    const copilotSources = [
      "apps-json",
      "copilot-cli:keychain",
      "gh:hosts.yml",
    ];

    function writeAppsJson(text: string): void {
      const path = process.env.GITHUB_COPILOT_APPS_JSON!;
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    }

    function writeGhHosts(text: string): void {
      const dir = process.env.GH_CONFIG_DIR!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "hosts.yml"), text, { mode: 0o600 });
    }

    it("leaves absent stores unmarked, so nothing reads as degraded", async () => {
      // A GitHub CLI store with only an enterprise login holds nothing for
      // the public endpoint.
      writeGhHosts("ghe.example.test:\n  oauth_token: enterprise-fixture\n");
      stubRejectingApi();

      const result = await readQuota("copilot");

      for (const source of copilotSources) {
        const attempts = attemptsFor(result, source);
        expect(attempts.length).toBeGreaterThan(0);
        for (const attempt of attempts) {
          expect(attempt.credentialPresent).toBeUndefined();
        }
      }
    });

    it.each([
      ["malformed JSON", "{not json"],
      ["a scalar", '"token"'],
      ["no token", '{"github.com":{"user":"fixture"}}'],
    ])(
      "marks a present but broken apps.json (%s) as a credential that exists",
      async (_label, text) => {
        writeAppsJson(text);
        stubRejectingApi();

        const result = await readQuota("copilot");
        const attempts = attemptsFor(result, "apps-json");

        expect(attempts.length).toBeGreaterThan(0);
        for (const attempt of attempts) {
          expect(attempt.credentialPresent).toBe(true);
        }
      },
    );

    it.each([
      ["keyring storage", "github.com:\n  user: fixture-user\n"],
      ["tab indentation", "github.com:\n\toauth_token: gho_fixture\n"],
      ["a scalar host", "github.com: gho_fixture\n"],
      ["a token reference", "github.com:\n  oauth_token: $GH_TOKEN\n"],
    ])(
      "marks a present but unusable GitHub CLI store (%s) as a credential that exists",
      async (_label, text) => {
        writeGhHosts(text);
        stubRejectingApi();

        const result = await readQuota("copilot");
        const attempts = attemptsFor(result, "gh:hosts.yml");

        expect(attempts.length).toBeGreaterThan(0);
        for (const attempt of attempts) {
          expect(attempt.credentialPresent).toBe(true);
        }
        expect(result.state.status).toBe("auth_required");
      },
    );

    it.each([
      "{invalid",
      JSON.stringify({
        lastLoggedInUser: {
          host: "https://github.com",
          login: "synthetic-user",
        },
      }),
    ])(
      "keeps a present unsupported native source visible when a sibling answers",
      async (text) => {
        const dir = process.env.COPILOT_HOME!;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "config.json"), text);
        writeGhHosts("github.com:\n  oauth_token: gho_synthetic\n");
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(JSON.stringify({ copilot_plan: "individual" })),
          ),
        );
        const result = await readQuota("copilot");
        expect(result.state.status).toBe("fresh");
        const attempt = attemptsFor(result, "copilot-cli:keychain")[0];
        expect(attempt.status).toBe("skipped");
        expect(
          attempt.credentialPresent === true || attempt.degraded === false,
        ).toBe(true);
      },
    );

    it("probes every readable store's token, in declared order, before a sign-in verdict", async () => {
      writeAppsJson('{"github.com":{"oauth_token":"apps-probe-token"}}');
      writeGhHosts("github.com:\n  oauth_token: gho_probe_fixture\n");
      const api = stubRejectingApi();

      const result = await readQuota("copilot");

      expect(api.bearers).toEqual([
        "Bearer apps-probe-token",
        "Bearer gho_probe_fixture",
      ]);
      expect(result.state.status).toBe("auth_required");
    });
  });

  /**
   * ElevenLabs has one deliberately supplied credential and no stored expiry.
   * The same two halves of the rule still apply: an unset variable is an absent
   * source, and a variable holding something unusable is a credential that
   * exists and failed - never a silent absence, and never sent as a header.
   */
  describe("elevenlabs", () => {
    const source = "env:ELEVENLABS_API_KEY";

    /** Records every request, so "never sent" is checked rather than assumed. */
    function stubRejectingApiKey(): { keys: string[] } {
      const keys: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          keys.push(new Headers(init?.headers).get("xi-api-key") ?? "");
          return new Response(null, { status: 401 });
        }),
      );
      return { keys };
    }

    it("leaves an unset variable unmarked, so nothing reads as degraded", async () => {
      const api = stubRejectingApiKey();

      const result = await readQuota("elevenlabs");

      const attempts = attemptsFor(result, source);
      expect(attempts.length).toBeGreaterThan(0);
      for (const attempt of attempts) {
        expect(attempt.credentialPresent).toBeUndefined();
      }
      expect(api.keys).toEqual([]);
      expect(result.state.status).toBe("auth_required");
    });

    it.each([
      ["a blank value", "   "],
      ["an environment reference", "$ELEVENLABS_API_KEY"],
      ["a command reference", "!op read op://vault/key"],
      ["a control byte", "xi-\u0007-fixture"],
    ])("never sends %s as a header value", async (_label, value) => {
      process.env.ELEVENLABS_API_KEY = value;
      const api = stubRejectingApiKey();

      const result = await readQuota("elevenlabs");

      expect(api.keys).toEqual([]);
      expect(result.state.status).toBe("auth_required");
    });

    it.each([
      ["an environment reference", "$ELEVENLABS_API_KEY"],
      ["a command reference", "!op read op://vault/key"],
    ])(
      "marks a present but unusable variable (%s) as a credential that exists",
      async (_label, value) => {
        process.env.ELEVENLABS_API_KEY = value;
        stubRejectingApiKey();

        const result = await readQuota("elevenlabs");
        const attempts = attemptsFor(result, source);

        expect(attempts.length).toBeGreaterThan(0);
        for (const attempt of attempts) {
          expect(attempt.credentialPresent).toBe(true);
        }
      },
    );

    it("probes a usable key with the vendor's own header, never as a bearer", async () => {
      process.env.ELEVENLABS_API_KEY = "elevenlabs-probe-fixture";
      const api = stubRejectingApiKey();
      const bearers: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          api.keys.push(headers.get("xi-api-key") ?? "");
          bearers.push(headers.get("authorization") ?? "");
          return new Response(null, { status: 401 });
        }),
      );

      const result = await readQuota("elevenlabs");

      expect(api.keys).toEqual(["elevenlabs-probe-fixture"]);
      expect(bearers).toEqual([""]);
      expect(result.state.status).toBe("auth_required");
    });
  });

  /**
   * Devin has two sources and no stored expiry. An unset or blank variable is
   * absence; a non-blank value that is not a usable secret is a credential that
   * exists and is never sent. A usable key is posted as Connect-JSON `apiKey`.
   */
  describe("devin", () => {
    const source = "env:WINDSURF_API_KEY";

    function stubRejectingApiKey(): { keys: string[] } {
      const keys: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            metadata?: { apiKey?: string };
          };
          keys.push(body.metadata?.apiKey ?? "");
          return new Response(null, { status: 401 });
        }),
      );
      return { keys };
    }

    it("leaves an unset variable unmarked, so nothing reads as degraded", async () => {
      const api = stubRejectingApiKey();

      const result = await readQuota("devin");

      const attempts = attemptsFor(result, source);
      expect(attempts.length).toBeGreaterThan(0);
      for (const attempt of attempts) {
        expect(attempt.credentialPresent).toBeUndefined();
      }
      expect(api.keys).toEqual([]);
      expect(result.state.status).toBe("auth_required");
    });

    it.each([
      ["a blank value", "   ", "auth_required"],
      ["an environment reference", "$WINDSURF_API_KEY", "error"],
      ["a command reference", "!op read op://vault/key", "error"],
      ["a control byte", "devin-\u0007-fixture", "error"],
    ])("never sends %s", async (_label, value, status) => {
      process.env.WINDSURF_API_KEY = value;
      const api = stubRejectingApiKey();

      const result = await readQuota("devin");

      expect(api.keys).toEqual([]);
      expect(result.state.status).toBe(status);
    });

    it("marks a present but unusable variable as a credential that exists", async () => {
      process.env.WINDSURF_API_KEY = "$WINDSURF_API_KEY";
      stubRejectingApiKey();

      const result = await readQuota("devin");
      const attempts = attemptsFor(result, source);

      expect(attempts.length).toBeGreaterThan(0);
      for (const attempt of attempts) {
        expect(attempt.credentialPresent).toBe(true);
      }
    });

    it("probes a usable key in the Connect-JSON body, never as a bearer", async () => {
      process.env.WINDSURF_API_KEY = "devin-probe-fixture";
      const api = stubRejectingApiKey();
      const bearers: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            metadata?: { apiKey?: string };
          };
          api.keys.push(body.metadata?.apiKey ?? "");
          bearers.push(headers.get("authorization") ?? "");
          return new Response(null, { status: 401 });
        }),
      );

      const result = await readQuota("devin");

      expect(api.keys).toEqual(["devin-probe-fixture"]);
      expect(bearers).toEqual([""]);
      expect(result.state.status).toBe("auth_required");
    });
  });
});
