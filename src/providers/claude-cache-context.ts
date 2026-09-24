import { createHash } from "node:crypto";
import { claudeCredentialContextId } from "../lib/fs.js";
import type { ProviderQuota } from "../types.js";

const PI_CONTEXT_DIGEST = Symbol("claudePiContextDigest");

type ClaudeContextStampedQuota = ProviderQuota & {
  [PI_CONTEXT_DIGEST]?: string;
};

export function stampClaudePiContext(
  provider: ProviderQuota,
  accessToken: string,
): void {
  (provider as ClaudeContextStampedQuota)[PI_CONTEXT_DIGEST] = createHash(
    "sha256",
  )
    .update(accessToken)
    .digest("hex");
}

export function claudeReadingContextId(provider?: ProviderQuota): string {
  const digest = provider
    ? (provider as ClaudeContextStampedQuota)[PI_CONTEXT_DIGEST]
    : undefined;
  if (!digest) return claudeCredentialContextId();
  return createHash("sha256")
    .update(
      JSON.stringify(["claude-pi-v1", claudeCredentialContextId(), digest]),
    )
    .digest("hex");
}

export function claudePiContextId(accessToken: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "claude-pi-v1",
        claudeCredentialContextId(),
        createHash("sha256").update(accessToken).digest("hex"),
      ]),
    )
    .digest("hex");
}
