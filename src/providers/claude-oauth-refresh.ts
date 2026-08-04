import { chmodSync, renameSync, writeFileSync } from "node:fs";
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
const KEYCHAIN_WRITE_TIMEOUT_MS = 30_000;
const KEYCHAIN_READ_TIMEOUT_MS = 60_000;

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
  /** The full parsed credential container as read (file JSON or Keychain blob). */
  container: Record<string, unknown>;
  /** "claudeAiOauth" when the OAuth object is nested; undefined when top-level. */
  oauthKey?: string;
  writeBack: ClaudeCredentialWriteBack;
};

export type ClaudeRefreshResult =
  // Renewed: an access token valid until `expiresAt` (epoch ms). Write-back is
  // best-effort and never downgrades this outcome; the caller uses the token
  // for this read regardless.
  | { status: "refreshed"; accessToken: string; expiresAt: number }
  // Definitive: the refresh token itself was rejected (the session is over).
  // The caller preserves the stored credential and reports sign-in required.
  | { status: "rejected"; code: string }
  // Transient: network, timeout, rate limit, server, or malformed response.
  // The caller preserves the stored credential and the valid session.
  | { status: "unavailable"; code: string };

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
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: context.refreshToken,
      client_id: context.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
    };
    // RFC 6749 §6: omitting `scope` on a refresh keeps the originally granted
    // scopes. When the stored credential records its scopes, send exactly those
    // so renewal never narrows them; these are authoritative per-credential
    // data, not guessed constants.
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
    return {
      status: "unavailable",
      code:
        error instanceof Error && error.name === "AbortError"
          ? "refresh_timeout"
          : "refresh_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }

  // A rejected refresh token is a definitive end of session, distinct from a
  // transient failure. 429/5xx and anything else stay transient so a valid
  // session is preserved.
  if (
    response.status === 400 ||
    response.status === 401 ||
    response.status === 403
  ) {
    return { status: "rejected", code: "refresh_rejected" };
  }
  if (response.status === 429) {
    return { status: "unavailable", code: "refresh_rate_limited" };
  }
  if (!response.ok) {
    return { status: "unavailable", code: "refresh_http_error" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", code: "refresh_malformed" };
  }
  const data = objectValue(payload);
  const accessToken = data ? stringValue(data.access_token) : undefined;
  const expiresInSeconds = data ? numberValue(data.expires_in) : undefined;
  if (!accessToken || expiresInSeconds === undefined) {
    return { status: "unavailable", code: "refresh_malformed" };
  }

  const now = Date.now();
  const expiresAt = now + expiresInSeconds * 1_000;
  // Preserve refresh-token rotation: adopt a replacement when the provider
  // returns one, but never discard the still-valid refresh token when the
  // response omits it.
  const rotatedRefreshToken =
    (data ? stringValue(data.refresh_token) : undefined) ??
    context.refreshToken;
  const refreshTokenExpiresInSeconds = data
    ? numberValue(data.refresh_token_expires_in)
    : undefined;
  const refreshTokenExpiresAt =
    refreshTokenExpiresInSeconds !== undefined
      ? now + refreshTokenExpiresInSeconds * 1_000
      : undefined;

  await persistRenewedCredential(context, {
    accessToken,
    refreshToken: rotatedRefreshToken,
    expiresAt,
    refreshTokenExpiresAt,
  });

  return { status: "refreshed", accessToken, expiresAt };
}

type RenewedFields = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
};

// Persistence is best-effort: a write failure, denied Keychain access, or a
// concurrent credential change never downgrades the refreshed result — the
// caller still holds a valid access token for this read. It only ever narrows
// to a no-op, never corrupts or deletes the stored credential.
async function persistRenewedCredential(
  context: ClaudeRefreshContext,
  renewed: RenewedFields,
): Promise<void> {
  try {
    if (context.writeBack.kind === "file") {
      await persistToFile(context, renewed, context.writeBack.path);
    } else {
      await persistToKeychain(context, renewed, context.writeBack);
    }
  } catch {
    // Preserve the valid session; the next read simply refreshes again.
  }
}

async function persistToFile(
  context: ClaudeRefreshContext,
  renewed: RenewedFields,
  path: string,
): Promise<void> {
  const current = readJsonFileResult(path);
  if (current.status !== "success") return;
  const container = objectValue(current.value);
  if (!container) return;
  // Compare-and-swap on the refresh token: if another process (for example the
  // Claude CLI) already rotated it since we read, adopt that newer credential
  // rather than clobbering it.
  if (!currentRefreshTokenMatches(container, context)) return;

  const updated = mergeRenewedCredential(container, context.oauthKey, renewed);
  const serialized = `${JSON.stringify(updated, null, 2)}\n`;
  ensurePrivateParent(path);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, serialized, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

async function persistToKeychain(
  context: ClaudeRefreshContext,
  renewed: RenewedFields,
  target: { account: string; service: string },
): Promise<void> {
  // Re-read the exact pinned item and compare-and-swap on the refresh token so
  // a concurrent rotation is adopted, not overwritten.
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
      KEYCHAIN_READ_TIMEOUT_MS,
    );
  } catch {
    return;
  }
  let currentContainer: Record<string, unknown> | undefined;
  try {
    currentContainer = objectValue(JSON.parse(currentBlob));
  } catch {
    return;
  }
  if (!currentContainer) return;
  if (!currentRefreshTokenMatches(currentContainer, context)) return;

  const updated = mergeRenewedCredential(
    currentContainer,
    context.oauthKey,
    renewed,
  );
  // `-U` updates the existing item in place, scoped to the exact account and
  // service, preserving its ACL. It never touches any other Keychain item.
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
    KEYCHAIN_WRITE_TIMEOUT_MS,
  );
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
  setPreferredKey(oauth, "accessToken", "access_token", renewed.accessToken);
  setPreferredKey(oauth, "refreshToken", "refresh_token", renewed.refreshToken);
  setPreferredKey(oauth, "expiresAt", "expires_at", renewed.expiresAt);
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
