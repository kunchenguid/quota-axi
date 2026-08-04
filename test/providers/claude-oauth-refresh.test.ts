import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaudeRefreshContext,
  ClaudeCredentialWriteBack,
} from "../../src/providers/claude-oauth-refresh.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.useRealTimers();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function useTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-refresh-"));
  return tempDir;
}

function writeCredentialFile(
  path: string,
  oauth: Record<string, unknown>,
): void {
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }), {
    mode: 0o600,
  });
}

function readOauth(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    claudeAiOauth: Record<string, unknown>;
  };
  return parsed.claudeAiOauth;
}

function fileContext(
  path: string,
  oauth: Record<string, unknown>,
  overrides: Partial<ClaudeRefreshContext> = {},
): ClaudeRefreshContext {
  return {
    refreshToken:
      (oauth.refreshToken as string | undefined) ?? "refresh-token-original",
    clientId: oauth.clientId as string | undefined,
    scopes: oauth.scopes as string[] | undefined,
    oauthKey: "claudeAiOauth",
    writeBack: { kind: "file", path } satisfies ClaudeCredentialWriteBack,
    ...overrides,
  };
}

function okTokenResponse(
  body: Record<string, unknown>,
): () => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("Claude OAuth refresh (module)", () => {
  it("posts the authoritative refresh_token grant and returns the renewed access token", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    const oauth = {
      accessToken: "old-access",
      refreshToken: "refresh-1",
      expiresAt: 0,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      clientId: "stored-client",
    };
    writeCredentialFile(path, oauth);
    const fetchMock = vi.fn(
      okTokenResponse({
        access_token: "renewed-access",
        refresh_token: "refresh-2",
        expires_in: 3600,
        refresh_token_expires_in: 1_000_000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const before = Date.now();
    const result = await refreshClaudeOAuthCredential(fileContext(path, oauth));

    expect(result.status).toBe("refreshed");
    expect(result).toMatchObject({ accessToken: "renewed-access" });
    // expiresAt is epoch ms: now + expires_in seconds.
    expect(
      result.status === "refreshed" && result.expiresAt,
    ).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "stored-client",
      scope: "user:inference user:profile",
    });
  });

  it("falls back to Claude Code's public client id when the credential stores none", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    const oauth = {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: 0,
    };
    writeCredentialFile(path, oauth);
    const fetchMock = vi.fn(
      okTokenResponse({ access_token: "renewed", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    await refreshClaudeOAuthCredential(fileContext(path, oauth));

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.client_id).toBe(CLIENT_ID);
    expect(body).not.toHaveProperty("scope");
  });

  it("writes back a rotated refresh token to the exact file source, 0600", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    const oauth = {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: 0,
      subscriptionType: "max",
    };
    writeCredentialFile(path, oauth);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        okTokenResponse({
          access_token: "renewed",
          refresh_token: "refresh-2",
          expires_in: 3600,
        }),
      ),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    await refreshClaudeOAuthCredential(fileContext(path, oauth));

    const written = readOauth(path);
    expect(written.accessToken).toBe("renewed");
    expect(written.refreshToken).toBe("refresh-2");
    expect(written.subscriptionType).toBe("max");
    expect(typeof written.expiresAt).toBe("number");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("retains the still-valid refresh token when the response omits a replacement", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    const oauth = {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: 0,
    };
    writeCredentialFile(path, oauth);
    vi.stubGlobal(
      "fetch",
      vi.fn(okTokenResponse({ access_token: "renewed", expires_in: 3600 })),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    await refreshClaudeOAuthCredential(fileContext(path, oauth));

    const written = readOauth(path);
    expect(written.accessToken).toBe("renewed");
    expect(written.refreshToken).toBe("refresh-1");
  });

  it("adopts a concurrently rotated on-disk credential instead of clobbering it", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    // The context was built from refresh-1, but another process has since
    // rotated the stored credential to refresh-sibling.
    const stored = {
      accessToken: "sibling-access",
      refreshToken: "refresh-sibling",
      expiresAt: 0,
    };
    writeCredentialFile(path, stored);
    const context = fileContext(path, {
      accessToken: "our-old",
      refreshToken: "refresh-1",
      expiresAt: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        okTokenResponse({
          access_token: "our-renewed",
          refresh_token: "refresh-2",
          expires_in: 3600,
        }),
      ),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential(context);

    // The read still succeeds for this quota read...
    expect(result.status).toBe("refreshed");
    // ...but the sibling's newer credential is preserved untouched.
    const written = readOauth(path);
    expect(written.accessToken).toBe("sibling-access");
    expect(written.refreshToken).toBe("refresh-sibling");
  });

  it.each([
    [
      400,
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    ],
    [401, async () => new Response(null, { status: 401 })],
    [403, async () => new Response(null, { status: 403 })],
  ])(
    "reports a rejected refresh token (HTTP %i) as definitive and never writes",
    async (_status, responder) => {
      const dir = useTempDir();
      const path = join(dir, ".credentials.json");
      const oauth = {
        accessToken: "old",
        refreshToken: "refresh-1",
        expiresAt: 0,
      };
      writeCredentialFile(path, oauth);
      vi.stubGlobal("fetch", vi.fn(responder as () => Promise<Response>));

      const { refreshClaudeOAuthCredential } =
        await import("../../src/providers/claude-oauth-refresh.js");
      const result = await refreshClaudeOAuthCredential(
        fileContext(path, oauth),
      );

      expect(result).toEqual({ status: "rejected", code: "refresh_rejected" });
      expect(readOauth(path)).toEqual(oauth);
    },
  );

  it.each([
    ["invalid_client", JSON.stringify({ error: "invalid_client" })],
    ["invalid_scope", JSON.stringify({ error: "invalid_scope" })],
    ["invalid_request", JSON.stringify({ error: "invalid_request" })],
    ["a non-JSON body", "something went wrong"],
  ])(
    "keeps the session on a 400 grant error (%s) that is not invalid_grant",
    async (_label, body) => {
      const dir = useTempDir();
      const path = join(dir, ".credentials.json");
      const oauth = {
        accessToken: "old",
        refreshToken: "refresh-1",
        expiresAt: 0,
      };
      writeCredentialFile(path, oauth);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 400 })),
      );

      const { refreshClaudeOAuthCredential } =
        await import("../../src/providers/claude-oauth-refresh.js");
      const result = await refreshClaudeOAuthCredential(
        fileContext(path, oauth),
      );

      expect(result).toEqual({
        status: "unavailable",
        code: "refresh_grant_error",
      });
      expect(readOauth(path)).toEqual(oauth);
    },
  );

  it.each([
    [
      "network",
      async () => {
        throw new TypeError("network down");
      },
      "refresh_unreachable",
    ],
    [
      "429",
      async () => new Response(null, { status: 429 }),
      "refresh_rate_limited",
    ],
    [
      "500",
      async () => new Response(null, { status: 500 }),
      "refresh_http_error",
    ],
  ])(
    "reports %s as a transient failure that preserves the session and never writes",
    async (_label, responder, code) => {
      const dir = useTempDir();
      const path = join(dir, ".credentials.json");
      const oauth = {
        accessToken: "old",
        refreshToken: "refresh-1",
        expiresAt: 0,
      };
      writeCredentialFile(path, oauth);
      vi.stubGlobal("fetch", vi.fn(responder as () => Promise<Response>));

      const { refreshClaudeOAuthCredential } =
        await import("../../src/providers/claude-oauth-refresh.js");
      const result = await refreshClaudeOAuthCredential(
        fileContext(path, oauth),
      );

      expect(result).toEqual({ status: "unavailable", code });
      expect(readOauth(path)).toEqual(oauth);
    },
  );

  it("treats a malformed 200 response as transient and never writes", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    const oauth = {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: 0,
    };
    writeCredentialFile(path, oauth);
    vi.stubGlobal("fetch", vi.fn(okTokenResponse({ token_type: "Bearer" })));

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential(fileContext(path, oauth));

    expect(result).toEqual({
      status: "unavailable",
      code: "refresh_malformed",
    });
    expect(readOauth(path)).toEqual(oauth);
  });

  it("still stores a rotated refresh token when the rest of the 200 response is unusable", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    const oauth = {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: 0,
    };
    writeCredentialFile(path, oauth);
    vi.stubGlobal(
      "fetch",
      vi.fn(okTokenResponse({ refresh_token: "refresh-2" })),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential(fileContext(path, oauth));

    expect(result).toEqual({
      status: "unavailable",
      code: "refresh_malformed",
      persistence: { status: "persisted" },
    });
    // The provider already rotated, so the replacement is stored; nothing else
    // in the credential is touched.
    expect(readOauth(path)).toEqual({ ...oauth, refreshToken: "refresh-2" });
  });

  it("reports a failed write-back instead of losing the rotation silently", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    // No credential file exists at the write-back path, so the compare-and-swap
    // re-read fails and the rotated token cannot be stored.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        okTokenResponse({
          access_token: "renewed",
          refresh_token: "refresh-2",
          expires_in: 3600,
        }),
      ),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential({
      refreshToken: "refresh-1",
      oauthKey: "claudeAiOauth",
      writeBack: { kind: "file", path },
    });

    expect(result).toMatchObject({
      status: "refreshed",
      accessToken: "renewed",
      persistence: { status: "failed", code: "write_back_unreadable" },
    });
  });

  it("reports an adopted concurrent rotation as superseded rather than failed", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    writeCredentialFile(path, {
      accessToken: "sibling-access",
      refreshToken: "refresh-sibling",
      expiresAt: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(okTokenResponse({ access_token: "renewed", expires_in: 3600 })),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential({
      refreshToken: "refresh-1",
      oauthKey: "claudeAiOauth",
      writeBack: { kind: "file", path },
    });

    expect(result).toMatchObject({ persistence: { status: "superseded" } });
  });

  it("updates the exact pinned Keychain item, scoped to its account and service", async () => {
    const currentBlob = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: "refresh-1",
        expiresAt: 0,
      },
    });
    const calls: Array<{ args: string[] }> = [];
    const execFileText = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === "find-generic-password") return currentBlob;
      return "";
    });
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        okTokenResponse({
          access_token: "renewed",
          refresh_token: "refresh-2",
          expires_in: 3600,
        }),
      ),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential({
      refreshToken: "refresh-1",
      oauthKey: "claudeAiOauth",
      writeBack: {
        kind: "keychain",
        account: "fixture-user",
        service: "Claude Code-credentials-abcd1234",
      },
    });

    expect(result.status).toBe("refreshed");
    const write = calls.find((c) => c.args[0] === "add-generic-password");
    expect(write?.args.slice(0, 6)).toEqual([
      "add-generic-password",
      "-U",
      "-a",
      "fixture-user",
      "-s",
      "Claude Code-credentials-abcd1234",
    ]);
    // The written blob carries the renewed tokens under the same account/service.
    const passwordFlag = write?.args.indexOf("-w") ?? -1;
    const blob = JSON.parse(String(write?.args[passwordFlag + 1])) as {
      claudeAiOauth: Record<string, unknown>;
    };
    expect(blob.claudeAiOauth.accessToken).toBe("renewed");
    expect(blob.claudeAiOauth.refreshToken).toBe("refresh-2");
  });

  it("does not overwrite the Keychain item when it was concurrently rotated", async () => {
    const currentBlob = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sibling",
        refreshToken: "refresh-sibling",
        expiresAt: 0,
      },
    });
    const execFileText = vi.fn(async (_cmd: string, args: string[]) =>
      args[0] === "find-generic-password" ? currentBlob : "",
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    vi.stubGlobal(
      "fetch",
      vi.fn(okTokenResponse({ access_token: "renewed", expires_in: 3600 })),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential({
      refreshToken: "refresh-1",
      oauthKey: "claudeAiOauth",
      writeBack: {
        kind: "keychain",
        account: "fixture-user",
        service: "Claude Code-credentials",
      },
    });

    expect(result.status).toBe("refreshed");
    expect(
      execFileText.mock.calls.some(
        ([, args]) => args[0] === "add-generic-password",
      ),
    ).toBe(false);
  });

  it("never places a token or refresh token in the returned result codes", async () => {
    const dir = useTempDir();
    const path = join(dir, ".credentials.json");
    const oauth = {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: 0,
    };
    writeCredentialFile(path, oauth);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 401 })),
    );

    const { refreshClaudeOAuthCredential } =
      await import("../../src/providers/claude-oauth-refresh.js");
    const result = await refreshClaudeOAuthCredential(fileContext(path, oauth));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("refresh-1");
    expect(serialized).not.toContain("old");
  });
});
