import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { ensurePrivateParent, readJsonFileResult } from "../lib/fs.js";
import { execFileText } from "../lib/process.js";

// Authoritative Claude Code login-flow OAuth refresh contract, derived only
// from the vendor's own OAuth/HTTP behavior (the shipped Claude CLI): the
// short-lived access token is renewed by POSTing a `refresh_token` grant to
// Claude's token endpoint with Claude Code's public OAuth client id. This is
// the exact renewal the CLI performs on every use; quota-axi carries no
// vendored adapter code. It is credential renewal, never an interactive login:
// no browser, no authorization-code exchange, no new consent.
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.202";
const REFRESH_TIMEOUT_MS = 30_000;
// Write-back is bounded so a quota read is never held hostage by Keychain
// access: the compare-and-swap re-read and the update share one total budget,
// well below the interactive read budget used to discover the credential.
const KEYCHAIN_WRITE_BACK_BUDGET_MS = 12_000;
const KEYCHAIN_WRITE_BACK_READ_TIMEOUT_MS = 6_000;
// Guard against a hostile or broken token endpoint: only enough of an error
// body is read to recover the RFC 6749 §5.2 `error` code.
const TOKEN_ERROR_BODY_LIMIT = 8_192;

// Where the renewed short-lived credential is written back. The refresh only
// ever rewrites the exact source and credential context it was read from; it
// never crosses contexts (a different config dir, account, or service).
export type ClaudeCredentialWriteBack =
  | { kind: "file"; path: string }
  | { kind: "keychain"; account: string; service: string };

export type ClaudeRefreshContext = {
  refreshToken: string;
  clientId?: string;
  scopes?: string[];
  /** "claudeAiOauth" when the OAuth object is nested; undefined when top-level. */
  oauthKey?: string;
  writeBack: ClaudeCredentialWriteBack;
};

// The outcome of writing the renewed credential back to its source. It never
// changes the refresh outcome itself; the caller surfaces it so a lost
// rotation is visible rather than silent.
export type ClaudeRefreshPersistence =
  // The renewed credential is stored in its source.
  | { status: "persisted" }
  // The source was rotated concurrently (for example by the Claude CLI); that
  // newer credential is adopted and left untouched.
  | { status: "superseded" }
  // The store could not be updated. When the provider rotated the refresh
  // token, the stored credential is now behind the server and a real sign-in
  // may be required — an unavoidable risk of a hard write denial.
  | { status: "failed"; code: string };

export type ClaudeRefreshResult =
  // Renewed: an access token valid until `expiresAt` (epoch ms). Write-back is
  // best-effort and never downgrades this outcome; the caller uses the token
  // for this read regardless.
  | {
      status: "refreshed";
      accessToken: string;
      expiresAt: number;
      persistence: ClaudeRefreshPersistence;
    }
  // Definitive: the refresh token itself was rejected (the session is over).
  // The caller preserves the stored credential and reports sign-in required.
  | { status: "rejected"; code: string }
  // Transient: network, timeout, rate limit, server, or malformed response.
  // The caller preserves the stored credential and the valid session.
  | {
      status: "unavailable";
      code: string;
      persistence?: ClaudeRefreshPersistence;
    };

/**
 * Renew a locally expired Claude access token from its refresh token, then
 * persist the renewed short-lived credential back to the same source. Performs
 * exactly one token request. Never logs, returns, or embeds any token, refresh
 * token, authorization header, or raw response body: results carry opaque codes
 * only. Any failure preserves the caller's valid session rather than corrupting
 * or deleting credentials.
 */
export async function refreshClaudeOAuthCredential(
  context: ClaudeRefreshContext,
): Promise<ClaudeRefreshResult> {
  const exchange = await exchangeRefreshToken(context);
  if (exchange.status === "failed") return exchange.result;

  const data = exchange.data;
  const accessToken = data ? stringValue(data.access_token) : undefined;
  const expiresInSeconds = data ? numberValue(data.expires_in) : undefined;

  const now = Date.now();
  // Preserve refresh-token rotation: adopt a replacement when the provider
  // returns one, but never discard the still-valid refresh token when the
  // response omits it.
  const rotated = data ? stringValue(data.refresh_token) : undefined;
  const refreshTokenExpiresInSeconds = data
    ? numberValue(data.refresh_token_expires_in)
    : undefined;
  const refreshTokenExpiresAt =
    refreshTokenExpiresInSeconds !== undefined
      ? now + refreshTokenExpiresInSeconds * 1_000
      : undefined;

  if (!accessToken || expiresInSeconds === undefined) {
    // The response is unusable for this read, but a rotation the provider has
    // already performed is real: store the replacement refresh token alone so
    // the local credential is not left behind the server. Nothing else in the
    // stored credential is touched.
    if (rotated === undefined || rotated === context.refreshToken) {
      return { status: "unavailable", code: "refresh_malformed" };
    }
    const persistence = await persistRenewedCredential(context, {
      refreshToken: rotated,
      refreshTokenExpiresAt,
    });
    return { status: "unavailable", code: "refresh_malformed", persistence };
  }

  const expiresAt = now + expiresInSeconds * 1_000;
  const persistence = await persistRenewedCredential(context, {
    accessToken,
    refreshToken: rotated ?? context.refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
  });

  return { status: "refreshed", accessToken, expiresAt, persistence };
}

type TokenExchange =
  | { status: "ok"; data: Record<string, unknown> | undefined }
  | { status: "failed"; result: ClaudeRefreshResult };

// The whole token exchange — connect, headers, and body — runs under one
// deadline, so an endpoint or intercepting proxy that answers with headers and
// then stalls the body can never hang the read. Persistence happens after this
// returns, under its own bound.
async function exchangeRefreshToken(
  context: ClaudeRefreshContext,
): Promise<TokenExchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      const body: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: context.refreshToken,
        client_id: context.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
      };
      // RFC 6749 §6: omitting `scope` on a refresh keeps the originally granted
      // scopes. When the stored credential records its scopes, send exactly
      // those so renewal never narrows them; these are authoritative
      // per-credential data, not guessed constants.
      if (context.scopes && context.scopes.length > 0) {
        body.scope = context.scopes.join(" ");
      }
      response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": CLAUDE_CODE_USER_AGENT,
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      return failedExchange({
        status: "unavailable",
        code: isAbortError(error) ? "refresh_timeout" : "refresh_unreachable",
      });
    }

    // Only a rejection of the refresh token itself ends the session. HTTP
    // 401/403 is that rejection; a 400 is only definitive when the endpoint
    // says `invalid_grant`, because RFC 6749 §5.2 also returns 400 for
    // invalid_client, invalid_scope, invalid_request, and
    // unsupported_grant_type — none of which mean the stored refresh token is
    // dead. Those, 429, 5xx, and anything else stay transient so a valid
    // session is preserved.
    if (response.status === 401 || response.status === 403) {
      return failedExchange({ status: "rejected", code: "refresh_rejected" });
    }
    if (response.status === 400) {
      return (await tokenErrorCode(response)) === "invalid_grant"
        ? failedExchange({ status: "rejected", code: "refresh_rejected" })
        : failedExchange({
            status: "unavailable",
            code: "refresh_grant_error",
          });
    }
    if (response.status === 429) {
      return failedExchange({
        status: "unavailable",
        code: "refresh_rate_limited",
      });
    }
    if (!response.ok) {
      return failedExchange({
        status: "unavailable",
        code: "refresh_http_error",
      });
    }

    try {
      return { status: "ok", data: objectValue(await response.json()) };
    } catch (error) {
      return failedExchange({
        status: "unavailable",
        code: isAbortError(error) ? "refresh_timeout" : "refresh_malformed",
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

function failedExchange(result: ClaudeRefreshResult): TokenExchange {
  return { status: "failed", result };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type RenewedFields = {
  accessToken?: string;
  refreshToken: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
};

// Persistence is best-effort: a write failure, denied Keychain access, or a
// concurrent credential change never downgrades the refreshed result — the
// caller still holds a valid access token for this read. It only ever narrows
// to a no-op, never corrupts or deletes the stored credential. The outcome is
// reported so a failed write-back of a rotated refresh token is visible.
async function persistRenewedCredential(
  context: ClaudeRefreshContext,
  renewed: RenewedFields,
): Promise<ClaudeRefreshPersistence> {
  try {
    if (context.writeBack.kind === "file") {
      return persistToFile(context, renewed, context.writeBack.path);
    }
    return await persistToKeychain(context, renewed, context.writeBack);
  } catch {
    // Preserve the valid session; the next read simply refreshes again.
    return { status: "failed", code: "write_back_denied" };
  }
}

function persistToFile(
  context: ClaudeRefreshContext,
  renewed: RenewedFields,
  path: string,
): ClaudeRefreshPersistence {
  const current = readJsonFileResult(path);
  if (current.status !== "success") {
    return { status: "failed", code: "write_back_unreadable" };
  }
  const container = objectValue(current.value);
  if (!container) return { status: "failed", code: "write_back_unreadable" };
  // Compare-and-swap on the refresh token: if another process (for example the
  // Claude CLI) already rotated it since we read, adopt that newer credential
  // rather than clobbering it.
  if (!currentRefreshTokenMatches(container, context)) {
    return { status: "superseded" };
  }

  const updated = mergeRenewedCredential(container, context.oauthKey, renewed);
  const serialized = `${JSON.stringify(updated, null, 2)}\n`;
  ensurePrivateParent(path);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, serialized, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    // Never leave credential material behind in an abandoned temp file.
    try {
      unlinkSync(temp);
    } catch {
      // Already gone, or the same condition that failed the write.
    }
    throw error;
  }
  chmodSync(path, 0o600);
  return { status: "persisted" };
}

async function persistToKeychain(
  context: ClaudeRefreshContext,
  renewed: RenewedFields,
  target: { account: string; service: string },
): Promise<ClaudeRefreshPersistence> {
  // Re-read the exact pinned item and compare-and-swap on the refresh token so
  // a concurrent rotation is adopted, not overwritten.
  const deadline = Date.now() + KEYCHAIN_WRITE_BACK_BUDGET_MS;
  let currentBlob: string;
  try {
    currentBlob = await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        target.account,
        "-w",
        "-s",
        target.service,
      ],
      Math.min(
        KEYCHAIN_WRITE_BACK_READ_TIMEOUT_MS,
        KEYCHAIN_WRITE_BACK_BUDGET_MS,
      ),
    );
  } catch {
    return { status: "failed", code: "write_back_unreadable" };
  }
  let currentContainer: Record<string, unknown> | undefined;
  try {
    currentContainer = objectValue(JSON.parse(currentBlob));
  } catch {
    return { status: "failed", code: "write_back_unreadable" };
  }
  if (!currentContainer) {
    return { status: "failed", code: "write_back_unreadable" };
  }
  if (!currentRefreshTokenMatches(currentContainer, context)) {
    return { status: "superseded" };
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) return { status: "failed", code: "write_back_timeout" };

  const updated = mergeRenewedCredential(
    currentContainer,
    context.oauthKey,
    renewed,
  );
  // `-U` updates the existing item in place, scoped to the exact account and
  // service, preserving its ACL. It never touches any other Keychain item.
  // The renewed blob is passed as a `security` argument, which is readable by
  // other processes running as this same user for the lifetime of that one
  // short-lived call; `security` offers no stdin path for this update, so the
  // exposure is inherent to Keychain write-back and is kept to the single
  // narrowest invocation that performs it.
  await execFileText(
    "security",
    [
      "add-generic-password",
      "-U",
      "-a",
      target.account,
      "-s",
      target.service,
      "-w",
      JSON.stringify(updated),
    ],
    remaining,
  );
  return { status: "persisted" };
}

// Read only the RFC 6749 §5.2 `error` code out of a token-endpoint failure.
// The body itself is never retained, logged, or returned.
async function tokenErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.text();
    if (body.length > TOKEN_ERROR_BODY_LIMIT) return undefined;
    const data = objectValue(JSON.parse(body));
    return data ? stringValue(data.error) : undefined;
  } catch {
    return undefined;
  }
}

function currentRefreshTokenMatches(
  container: Record<string, unknown>,
  context: ClaudeRefreshContext,
): boolean {
  const oauth = oauthObject(container, context.oauthKey);
  if (!oauth) return false;
  const current =
    stringValue(oauth.refreshToken) ?? stringValue(oauth.refresh_token);
  // Absent on disk: nothing to preserve, safe to write our renewal.
  if (current === undefined) return true;
  return current === context.refreshToken;
}

function mergeRenewedCredential(
  container: Record<string, unknown>,
  oauthKey: string | undefined,
  renewed: RenewedFields,
): Record<string, unknown> {
  const oauth = { ...(oauthObject(container, oauthKey) ?? {}) };
  if (renewed.accessToken !== undefined) {
    setPreferredKey(oauth, "accessToken", "access_token", renewed.accessToken);
  }
  setPreferredKey(oauth, "refreshToken", "refresh_token", renewed.refreshToken);
  if (renewed.expiresAt !== undefined) {
    setPreferredKey(oauth, "expiresAt", "expires_at", renewed.expiresAt);
  }
  if (renewed.refreshTokenExpiresAt !== undefined) {
    setPreferredKey(
      oauth,
      "refreshTokenExpiresAt",
      "refresh_token_expires_at",
      renewed.refreshTokenExpiresAt,
    );
  }
  if (oauthKey) return { ...container, [oauthKey]: oauth };
  return oauth;
}

function oauthObject(
  container: Record<string, unknown>,
  oauthKey: string | undefined,
): Record<string, unknown> | undefined {
  if (oauthKey) return objectValue(container[oauthKey]);
  return container;
}

// Preserve the credential's existing key style (Claude Code writes camelCase)
// so renewal edits the same field the reader consumes without duplicating it.
function setPreferredKey(
  target: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  value: string | number,
): void {
  if (snakeKey in target && !(camelKey in target)) {
    target[snakeKey] = value;
    return;
  }
  target[camelKey] = value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
