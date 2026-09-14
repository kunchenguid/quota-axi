import { createHash } from "node:crypto";
import type { ProviderQuota } from "../types.js";

/**
 * Non-serializable evidence attached to a fresh Cursor report. The account ID
 * came from Cursor's remote profile response, never from a token or local
 * credential metadata. Object spreads preserve this symbol until the cache
 * writer sees it; JSON output ignores symbol keys.
 */
const CURSOR_CACHE_CONTEXT = Symbol("cursor-cache-context");

type CursorContextCarrier = ProviderQuota & {
  [CURSOR_CACHE_CONTEXT]?: string;
};

/** Attach the opaque account scope used only by the quota cache. */
export function withCursorCacheContext(
  provider: ProviderQuota,
  remoteAccountId: string | undefined,
): ProviderQuota {
  if (remoteAccountId === undefined) return provider;
  const carrier: CursorContextCarrier = {
    ...provider,
    [CURSOR_CACHE_CONTEXT]: cursorAccountContextId(remoteAccountId),
  };
  return carrier;
}

/** Read account evidence carried by the report without exposing the raw ID. */
export function cursorCacheContextId(
  provider: ProviderQuota,
): string | undefined {
  return (provider as CursorContextCarrier)[CURSOR_CACHE_CONTEXT];
}

/**
 * Hash only Cursor's remotely reported stable account identity. Credential
 * bytes never enter this identifier or any other cache/output field.
 */
export function cursorAccountContextId(remoteAccountId: string): string {
  return createHash("sha256")
    .update(`cursor-account:${remoteAccountId}`)
    .digest("hex");
}
