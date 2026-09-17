import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every boundary that could reach a real credential or endpoint is mocked:
// `execFileText` covers `security` and any vendor-CLI spawn, `fetch` covers the
// quota endpoint, and HOME/XDG are redirected into a temporary directory. No
// test here can read a real store or call a real provider.
const execFileText = vi.fn();
vi.mock("../../src/lib/process.js", () => ({ execFileText }));

const ENV_TOKEN = "synthetic-env-token";
const STORED_TOKEN = "synthetic-stored-token";
const OAUTH_FILE_TOKEN = "synthetic-oauth-file-token";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const options = { allowKeychainPrompt: true, refreshCredentials: false };
const service = "Claude Code-credentials";
const keychain = "/fixture/Library/Keychains/login.keychain-db";
let home: string;
let fetchMock: ReturnType<typeof vi.fn>;

function item(modified = "20260913010000Z", name = service): string {
  const date = Buffer.from(`${modified}\0`).toString("hex");
  return `keychain: "${keychain}"
version: 512
class: "genp"
attributes:
    "acct"<blob>="fixture-user"
    "mdat"<timedate>=0x${date}  "${modified}\\000"
    "svce"<blob>="${name}"
`;
}

/**
 * Serve a synthetic Keychain credential, or a search list that conclusively
 * holds no Claude item. Conclusive absence matters: an unreadable Keychain is a
 * different state, covered separately below.
 */
function mockStore(stored?: { accessToken: string; expiresAt?: number }): void {
  execFileText.mockImplementation(async (command: string, args: string[]) => {
    expect(command).toBe("security");
    if (args[0] === "list-keychains") return `    "${keychain}"\n`;
    if (args[0] === "dump-keychain")
      return stored ? item() : item("20260913010000Z", "Some-Other-Service");
    if (!stored) throw Object.assign(new Error("absent"), { code: 44 });
    return args.includes("-w") ? JSON.stringify({ claudeAiOauth: stored }) : "";
  });
}

/** A search list quota-axi cannot read at all. */
function mockUnreadableStore(): void {
  execFileText.mockImplementation(async (command: string, args: string[]) => {
    expect(command).toBe("security");
    if (args[0] === "list-keychains") return `    "${keychain}"\n`;
    if (args[0] === "dump-keychain") return "";
    throw Object.assign(new Error("unreachable"), { code: 44 });
  });
}

/**
 * Writes the `.credentials.json` sidecar quota-axi reads as the `oauth-file`
 * source. On darwin this exists alongside the Keychain source (both are
 * checked), giving a second, independent stored candidate.
 */
function writeOauthFile(accessToken: string, expiresAt?: number): void {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } }),
  );
}

function respondWith(body: unknown, status = 200): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(status === 200 ? JSON.stringify(body) : "{}", { status }),
  );
}

function usageBearers(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/oauth/usage"))
    .map(
      ([, init]) =>
        (init as { headers: Record<string, string> }).headers.authorization,
    );
}

beforeEach(() => {
  vi.resetModules();
  execFileText.mockReset();
  home = mkdtempSync(join(tmpdir(), "quota-axi-claude-env-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("USER", "fixture-user");
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  Object.defineProperty(process, "platform", { value: "darwin" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  respondWith({ five_hour: { utilization: 12 } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(process, "platform", platform);
  rmSync(home, { recursive: true, force: true });
});

describe("Claude CLAUDE_CODE_OAUTH_TOKEN credential source", () => {
  it("actually sends the environment token when no stored credential exists", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(usageBearers()).toContain(`Bearer ${ENV_TOKEN}`);
    expect(report.windows).toMatchObject([
      { id: "five_hour", percentUsed: 12 },
    ]);
  });

  it("reports the env source as the attempt that succeeded", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.attempts).toEqual(
      expect.arrayContaining([{ source: "env", status: "success" }]),
    );
  });

  it("prefers the environment token over a healthy stored credential", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    // The stored credential is never presented: the first bearer wins and the
    // loop stops, so the store is a bystander rather than the account read.
    expect(usageBearers()[0]).toBe(`Bearer ${ENV_TOKEN}`);
    expect(usageBearers()).not.toContain(`Bearer ${STORED_TOKEN}`);
  });

  it("falls back to the stored credential when the variable is absent", async () => {
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(usageBearers()).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(report.attempts?.some((a) => a.source === "env")).toBe(false);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace-only"],
  ])("treats a %s variable as absent (%s)", async (value) => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", value);
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(usageBearers()).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(report.attempts?.some((a) => a.source === "env")).toBe(false);
  });

  it("reports a present but unusable value instead of dropping it silently", async () => {
    // A `$`-bearing value is a shell reference, never a literal bearer.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "$SOME_OTHER_VAR");
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(usageBearers()).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(report.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "env",
          error: "credentials_invalid",
          credentialPresent: true,
        }),
      ]),
    );
  });

  it("reports a 401 on the environment token as a sign-in requirement", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    respondWith({}, 401);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("auth_required");
    expect(report.windows).toEqual([]);
  });

  it("does not turn a 403 on the environment token into a sign-out verdict", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    respondWith({}, 403);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    // A 403 can be permission, entitlement, or network policy. It is reported,
    // never rewritten into quota data and never asserted as a sign-out.
    expect(report.state.status).not.toBe("auth_required");
    expect(report.state.status).not.toBe("fresh");
    expect(report.windows).toEqual([]);
    expect(report.state.error).toContain("403");
  });

  it("stops on a definitive 401 without trying a healthy stored credential", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore({ accessToken: STORED_TOKEN });
    fetchMock.mockImplementation(async (_url: string, init: unknown) => {
      const bearer = (init as { headers: Record<string, string> }).headers
        .authorization;
      if (bearer === `Bearer ${ENV_TOKEN}`) {
        return new Response("{}", { status: 401 });
      }
      // The stored credential is healthy and would succeed if tried, so a
      // fresh report here would mean quota-axi reported a bystander account.
      return new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
        status: 200,
      });
    });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("auth_required");
    expect(report.windows).toEqual([]);
    expect(usageBearers()).toEqual([`Bearer ${ENV_TOKEN}`]);
  });

  it("falls through to the stored credential when the env token fails with a non-definitive error", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore({ accessToken: STORED_TOKEN });
    fetchMock.mockImplementation(async (_url: string, init: unknown) => {
      const bearer = (init as { headers: Record<string, string> }).headers
        .authorization;
      if (bearer === `Bearer ${ENV_TOKEN}`) {
        return new Response("{}", { status: 403 });
      }
      return new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
        status: 200,
      });
    });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    // The env source's 403 is not definitive, so the loop hands over to the
    // still-untried stored credential instead of aborting.
    expect(report.state.status).toBe("fresh");
    expect(usageBearers()).toEqual([
      `Bearer ${ENV_TOKEN}`,
      `Bearer ${STORED_TOKEN}`,
    ]);
    expect(report.windows).toMatchObject([
      { id: "five_hour", percentUsed: 12 },
    ]);
  });

  it("reports a genuine stored sign-out even when the env token failed transiently first", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore({ accessToken: STORED_TOKEN });
    fetchMock.mockImplementation(async (_url: string, init: unknown) => {
      const bearer = (init as { headers: Record<string, string> }).headers
        .authorization;
      const status = bearer === `Bearer ${ENV_TOKEN}` ? 403 : 401;
      return new Response("{}", { status });
    });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    // The stored credential's definitive 401 must win over the env token's
    // earlier, merely transient 403, not be hidden behind it.
    expect(report.state.status).toBe("auth_required");
    expect(report.windows).toEqual([]);
  });

  it("purges the cache when a stored credential is definitively rejected after a transient env failure", async () => {
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { writeCachedProviders, readCachedProvider } =
      await import("../../src/cache.js");
    const fresh = await fetchQuota(options);
    expect(fresh.state.status).toBe("fresh");
    writeCachedProviders([fresh]);
    expect(readCachedProvider("claude")).toBeDefined();

    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    fetchMock.mockImplementation(async (_url: string, init: unknown) => {
      const bearer = (init as { headers: Record<string, string> }).headers
        .authorization;
      const status = bearer === `Bearer ${ENV_TOKEN}` ? 403 : 401;
      return new Response("{}", { status });
    });
    const rejected = await fetchQuota(options);

    expect(rejected.state.status).toBe("auth_required");
    expect(readCachedProvider("claude")).toBeUndefined();
  });

  it("does not purge an unrelated stored-profile cache on an env-only definitive rejection", async () => {
    // Seed a stored-profile cache with no environment variable set.
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { writeCachedProviders, readCachedProvider } =
      await import("../../src/cache.js");
    const fresh = await fetchQuota(options);
    expect(fresh.state.status).toBe("fresh");
    writeCachedProviders([fresh]);
    expect(readCachedProvider("claude")).toBeDefined();

    // A later run selects the environment token instead. Its account is
    // definitively rejected before any stored candidate is ever tried, so
    // that verdict describes only the env-selected session and must not
    // retire the unrelated stored-profile snapshot above.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    fetchMock.mockClear();
    respondWith({}, 401);
    const rejected = await fetchQuota(options);

    expect(rejected.state.status).toBe("auth_required");
    expect(usageBearers()).toEqual([`Bearer ${ENV_TOKEN}`]);
    expect(readCachedProvider("claude")).toBeDefined();
  });

  it("retains transient-before-definitive precedence for stored-only sources and does not purge the cache", async () => {
    // On darwin both the Keychain and the .credentials.json sidecar are
    // checked; Keychain is tried first. No environment variable is set, so
    // this is a stored-only combination.
    writeOauthFile(OAUTH_FILE_TOKEN);
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { writeCachedProviders, readCachedProvider } =
      await import("../../src/cache.js");
    const fresh = await fetchQuota(options);
    expect(fresh.state.status).toBe("fresh");
    writeCachedProviders([fresh]);
    expect(readCachedProvider("claude")).toBeDefined();

    // Keychain (tried first) is definitively rejected; the oauth-file sibling
    // that runs next only fails transiently, so its outcome is unresolved
    // rather than a confirmed sign-out.
    fetchMock.mockImplementation(async (_url: string, init: unknown) => {
      const bearer = (init as { headers: Record<string, string> }).headers
        .authorization;
      const status = bearer === `Bearer ${STORED_TOKEN}` ? 401 : 500;
      return new Response("{}", { status });
    });
    const report = await fetchQuota(options);

    expect(report.state.status).not.toBe("auth_required");
    expect(readCachedProvider("claude")).toBeDefined();
  });

  it("keeps a confirmed stored expiry ahead of an earlier definitive rejection", async () => {
    // Keychain is tried before the oauth-file sidecar on darwin, and the
    // environment token before both.
    writeOauthFile(OAUTH_FILE_TOKEN, Date.now() - 60_000);
    mockStore({ accessToken: STORED_TOKEN });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { writeCachedProviders, readCachedProvider } =
      await import("../../src/cache.js");
    const fresh = await fetchQuota(options);
    expect(fresh.state.status).toBe("fresh");
    writeCachedProviders([fresh]);
    expect(readCachedProvider("claude")).toBeDefined();

    // The env token fails transiently, the Keychain sibling is definitively
    // rejected, and the stored-expired sidecar that runs last is confirmed
    // expired against /profile. That confirmation is the reading's own
    // unresolved outcome, so the earlier 401 must not be promoted to a
    // sign-out that retires the snapshot above.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    fetchMock.mockImplementation(async (url: string, init: unknown) => {
      const bearer = (init as { headers: Record<string, string> }).headers
        .authorization;
      if (bearer === `Bearer ${ENV_TOKEN}`)
        return new Response("{}", { status: 500 });
      if (bearer === `Bearer ${STORED_TOKEN}`)
        return new Response("{}", { status: 401 });
      return String(url).includes("/oauth/profile")
        ? new Response("{}", { status: 401 })
        : new Response("{}", {
            status: 429,
            headers: { "retry-after": "60" },
          });
    });
    const report = await fetchQuota(options);

    expect(report.state.status).not.toBe("auth_required");
    expect(report.state.error).toBe("Claude credential expired");
    expect(readCachedProvider("claude")).toBeDefined();
  });

  it("still offers the Keychain remedy when only the identity probe answered", async () => {
    // The Keychain holds the credential but its value read is gated, the env
    // token is rejected non-definitively, and the stored-expired sidecar is
    // merely rate limited. Nothing read a credential, so the one actionable
    // remedy is the Keychain grant - the identity probe answering live must
    // not read as a source that produced a reading.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    writeOauthFile(OAUTH_FILE_TOKEN, Date.now() - 60_000);
    mockStore({ accessToken: STORED_TOKEN });
    fetchMock.mockImplementation(async (url: string, init: unknown) => {
      const bearer = (init as { headers: Record<string, string> }).headers
        .authorization;
      if (bearer === `Bearer ${ENV_TOKEN}`)
        return new Response("{}", { status: 403 });
      return String(url).includes("/oauth/profile")
        ? Response.json({ account: { uuid: "account-uuid-fixture" } })
        : new Response("{}", {
            status: 429,
            headers: { "retry-after": "60" },
          });
    });

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { annotateQuotaAdvice, KEYCHAIN_ACCESS_REASON } =
      await import("../../src/advice.js");
    const report = await fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });
    const annotated = annotateQuotaAdvice({
      generatedAt: "2026-09-18T00:00:00.000Z",
      providers: [report],
    });

    expect(report.attempts).toContainEqual({
      source: "keychain",
      status: "skipped",
      error: "keychain_prompt_required",
      credentialPresent: true,
    });
    expect(report.attempts).toContainEqual({
      source: "oauth-profile",
      status: "success",
    });
    expect(annotated.providers[0]?.state.reason).toBe(KEYCHAIN_ACCESS_REASON);
    expect(annotated.help?.join("\n") ?? "").toContain(
      "--allow-keychain-prompt",
    );
  });

  it("trims surrounding whitespace on the environment token before sending it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", `  ${ENV_TOKEN}\n`);
    mockStore();
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(usageBearers()).toContain(`Bearer ${ENV_TOKEN}`);
    expect(
      report.attempts?.some(
        (a) => a.source === "env" && a.error === "credentials_invalid",
      ),
    ).toBe(false);
  });

  it("never delegates a credential refresh for an environment token", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    respondWith({}, 401);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    // Refresh explicitly enabled: an env token has no refresh path, so the
    // vendor CLI must still never be spawned.
    await fetchQuota({ allowKeychainPrompt: true, refreshCredentials: true });

    expect(
      execFileText.mock.calls.filter(([command]) => command !== "security"),
    ).toEqual([]);
  });

  it("never writes the environment token into the quota cache or its report", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);
    const { writeCachedProviders } = await import("../../src/cache.js");
    const { cacheFilePath } = await import("../../src/lib/fs.js");
    writeCachedProviders([report]);

    expect(JSON.stringify(report)).not.toContain(ENV_TOKEN);
    expect(readFileSync(cacheFilePath(), "utf8")).not.toContain(ENV_TOKEN);
  });

  it("still withholds a sign-out verdict when the Keychain itself is unreadable", async () => {
    // Preserved behavior: a source quota-axi could not open may hold the live
    // session, so a rejection elsewhere is reported without asserting sign-out.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockUnreadableStore();
    respondWith({}, 401);
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).not.toBe("auth_required");
  });

  it("keeps advisory stored expiry probing unchanged when no variable is set", async () => {
    // Stored expiry is advisory: an expired stored credential is still probed,
    // and a live response wins.
    mockStore({ accessToken: STORED_TOKEN, expiresAt: Date.now() - 60_000 });
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota(options);

    expect(report.state.status).toBe("fresh");
    expect(usageBearers()).toEqual([`Bearer ${STORED_TOKEN}`]);
  });
});

describe("Claude cache context identity", () => {
  it("separates an environment-token reading from a stored-credential one", async () => {
    const { claudeCredentialContextId } = await import("../../src/lib/fs.js");
    const withoutEnv = claudeCredentialContextId();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);

    expect(claudeCredentialContextId()).not.toBe(withoutEnv);
  });

  it("leaves the identity untouched when no variable is set", async () => {
    const { claudeCredentialContextId } = await import("../../src/lib/fs.js");
    const before = claudeCredentialContextId();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

    // An empty variable selects nothing, so existing cached snapshots stay
    // addressable rather than being withheld by a changed identity.
    expect(claudeCredentialContextId()).toBe(before);
  });

  it("derives the identity from presence only, never from the token", async () => {
    const { claudeCredentialContextId } = await import("../../src/lib/fs.js");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    const first = claudeCredentialContextId();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "a-different-synthetic-token");

    expect(claudeCredentialContextId()).toBe(first);
  });
});

// Source selection driven through the real command bodies, not helper units.
// The CLI is exercised in-process with every credential, filesystem, process
// and HTTP boundary mocked, so no real store or endpoint is reachable.
describe("Claude env-token stale cache fallback", () => {
  it("never serves a stale cached snapshot for an env-selected reading", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { writeCachedProviders } = await import("../../src/cache.js");
    const fresh = await fetchQuota(options);
    expect(fresh.state.status).toBe("fresh");
    writeCachedProviders([fresh]);

    // A different account's env token, presence-only identity notwithstanding:
    // a transient failure here must never resurrect the previous account's cache.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "a-different-synthetic-token");
    respondWith({}, 403);
    const retry = await fetchQuota(options);

    expect(retry.state.status).not.toBe("stale");
    expect(retry.windows).toEqual([]);
  });
});

describe("CLI source selection", () => {
  it("reports Claude quota from the environment token", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    const { quotaCommand } = await import("../../src/commands.js");
    const output = await quotaCommand(
      ["--provider", "claude", "--no-credential-refresh", "--json", "--full"],
      undefined,
    );
    const report = JSON.parse(output) as {
      providers: { attempts?: { source: string; status: string }[] }[];
    };

    expect(output).not.toContain(ENV_TOKEN);
    expect(report.providers[0]?.attempts).toEqual(
      expect.arrayContaining([{ source: "env", status: "success" }]),
    );
    expect(usageBearers()).toEqual([`Bearer ${ENV_TOKEN}`]);
  });

  it("lists the environment source in the read-only auth command", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ENV_TOKEN);
    mockStore();
    const { authCommand } = await import("../../src/commands.js");
    const output = await authCommand(["--provider", "claude"], undefined);

    expect(output).toContain("env");
    expect(output).not.toContain(ENV_TOKEN);
    // The read-only auth command never sends the credential anywhere.
    expect(usageBearers()).toEqual([]);
  });

  it("leaves Claude on the stored credential when no variable is set", async () => {
    mockStore({ accessToken: STORED_TOKEN });
    const { quotaCommand } = await import("../../src/commands.js");
    // The stored path still needs its Keychain grant; the environment source
    // above needed no such opt-in, which is the point of the contrast.
    const output = await quotaCommand(
      [
        "--provider",
        "claude",
        "--no-credential-refresh",
        "--allow-keychain-prompt",
        "--json",
        "--full",
      ],
      undefined,
    );
    const report = JSON.parse(output) as {
      providers: { attempts?: { source: string }[] }[];
    };

    expect(report.providers[0]?.attempts?.some((a) => a.source === "env")).toBe(
      false,
    );
    expect(usageBearers()).toEqual([`Bearer ${STORED_TOKEN}`]);
  });
});
