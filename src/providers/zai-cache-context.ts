import { createHash } from "node:crypto";

/**
 * The environment credential the Z.AI SDK and the vendor coding plugins read
 * before any stored credential, so an explicit key here names the account a
 * session is actually billing. It is also the only source available when the
 * key is held in a secret manager and injected at run time rather than written
 * to a local auth file.
 */
export const ZAI_API_KEY_ENV = "ZAI_API_KEY";

/**
 * The account a Z.AI reading belongs to, as the source that produced it.
 *
 * A bare `ZAI_API_KEY` carries no other account identity, so the key itself is
 * folded into the digest: two different keys never share a snapshot and the
 * same key keeps reusing its own. A stored credential names its own source
 * instead, because Pi's entry and opencode's `auth.json` can hold different
 * accounts and neither is described by whatever key the environment happens to
 * carry. Only the one-way digest is persisted; the key itself is never stored,
 * logged, or rendered.
 */
export type ZaiCredentialIdentity =
  | { kind: "env-key"; apiKey: string }
  | { kind: "stored"; source: string };

export function zaiCredentialContextId(
  identity: ZaiCredentialIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        identity.kind === "env-key"
          ? ["zai-credential-v3", "env-key", identity.apiKey]
          : ["zai-credential-v3", "stored", identity.source],
      ),
    )
    .digest("hex");
}

/**
 * The cache identity the Z.AI reading this process produced belongs to, or
 * `undefined` when nothing has claimed one yet.
 *
 * The cache writer reads this rather than deriving an identity for itself, for
 * the reason the Kimi note beside it gives: the environment at write time is
 * not necessarily what answered. An environment key that is definitively
 * rejected hands over to a stored credential, and deriving the stamp from the
 * environment would file that stored account's numbers under the environment
 * key's identity — and then serve them back as the environment account's.
 *
 * Publishing the identity of whatever actually produced the reading is the only
 * stamp that cannot make that mistake.
 */
let readingContextId: string | undefined;

export function publishZaiReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

export function zaiReadingContextId(): string | undefined {
  return readingContextId;
}

/** Test seam: forget any identity claimed by an earlier reading. */
export function resetZaiReadingContextId(): void {
  readingContextId = undefined;
}
