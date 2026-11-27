import { createHash } from "node:crypto";
import { join } from "node:path";
import { collapseHome, readJsonFileResult } from "../lib/fs.js";
import { usableLiteralSecret } from "../lib/secret.js";

/** The auth source name a Bob browser sign-in is reported under. */
export const BOB_LOGIN_SOURCE = "file:bob-auth";

/**
 * Bob stores a browser sign-in as one JSON string per gateway, under
 * `<prefix>-<gateway origin>`, in a file beside its settings. Only the default
 * gateway is read here: a deployment naming any other gateway is blocked before
 * this file is consulted, exactly like an API key.
 */
const LOGIN_KEY_PREFIX = "bob.auth.tokens";
const LOGIN_FILE = ["settings", "auth-secrets.json"] as const;

export type BobLoginResolution =
  | {
      status: "available";
      source: typeof BOB_LOGIN_SOURCE;
      path: string;
      /** The bearer token. It is sent once and never stored, cached or rendered. */
      token: string;
      /** The owner of this login; see {@link bobLoginCacheContextId}. */
      identity: string;
      /**
       * The stored expiry has passed. It is advisory, never a verdict: only the
       * profile endpoint can say whether the token is dead, so the token is
       * still probed in its declared position.
       */
      expired: boolean;
    }
  | {
      status: "missing" | "invalid" | "error";
      source: typeof BOB_LOGIN_SOURCE;
      path: string;
    };

export function bobLoginFilePath(home: string): string {
  return join(home, ".bob", ...LOGIN_FILE);
}

/**
 * Read Bob's own stored browser sign-in, read-only.
 *
 * Two JSON revivers keep everything else out of memory as objects: the file
 * keeps only the one gateway entry (it also holds a telemetry identifier), and
 * the entry keeps only `token`, `expiresAt` and `userId`. Its `refreshToken` is
 * dropped while the entry is parsed, is never read into a field, and is never
 * exchanged: quota-axi renews nothing, so an expired login is left to Bob, which
 * renews it the next time it starts.
 *
 * A file that cannot be read, or is not a JSON object, is an operational
 * failure (`error`), never a sign-out: Bob may be rewriting it right now. Only
 * an entry that does not have the stored shape is `invalid`.
 *
 * @param home the user's home directory
 * @param gatewayOrigin the gateway whose stored login is wanted
 * @param nowMs the current time in milliseconds
 */
export function resolveBobLogin(
  home: string,
  gatewayOrigin: string,
  nowMs: number,
): BobLoginResolution {
  const path = bobLoginFilePath(home);
  const base = { source: BOB_LOGIN_SOURCE, path: collapseHome(path) } as const;
  const entryKey = `${LOGIN_KEY_PREFIX}-${gatewayOrigin}`;

  const file = readJsonFileResult(path, (name, value) =>
    name === "" || name === entryKey ? value : undefined,
  );
  if (file.status === "missing") return { status: "missing", ...base };
  if (file.status === "invalid") return { status: "error", ...base };
  const store = objectValue(file.value);
  if (!store) return { status: "error", ...base };
  if (!Object.hasOwn(store, entryKey)) return { status: "missing", ...base };

  const entry = parseEntry(store[entryKey]);
  if (!entry) return { status: "invalid", ...base };
  const { token, userId: identity, expiresAt } = entry;
  return {
    status: "available",
    token,
    identity,
    expired: nowMs / 1000 >= expiresAt,
    ...base,
  };
}

function parseEntry(
  value: unknown,
): { token: string; userId: string; expiresAt: number } | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value, (name, member) =>
      name === "" ||
      name === "token" ||
      name === "userId" ||
      name === "expiresAt"
        ? member
        : undefined,
    );
  } catch {
    return undefined;
  }
  const entry = objectValue(parsed);
  if (!entry) return undefined;
  const token = usableLiteralSecret(entry.token);
  const userId =
    typeof entry.userId === "string" && entry.userId.trim().length > 0
      ? entry.userId
      : undefined;
  const expiresAt = entry.expiresAt;
  if (
    !token ||
    !userId ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= 0
  ) {
    return undefined;
  }
  return { token, userId, expiresAt };
}

/**
 * Opaque SHA-256 of the answering source plus a one-way digest of the login's
 * owner. The owner is the stored `userId`, not the token: the token is
 * replaced every few hours by Bob's own renewal, and keying the cache on it
 * would turn each renewal into a cache miss. A different sign-in has a
 * different owner, so the previous account's budget is never served for it,
 * and neither the token nor the owner can be recovered from the digest.
 */
export function bobLoginCacheContextId(
  source: string,
  identity: string,
): string {
  const ownerDigest = createHash("sha256")
    .update(`bob-login-v1\0${identity}`)
    .digest("hex");
  return createHash("sha256")
    .update(`bob\0${source}\0${ownerDigest}`)
    .digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
