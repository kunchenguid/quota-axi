import { createHash } from "node:crypto";
import { resolve } from "node:path";

let readingContextId: string | undefined;

/** Opaque identity for the Pi credential-store path selected for a Meta read. */
export function metaCredentialContextId(path: string): string {
  const credentialPath = resolve(path.normalize("NFC"));
  return createHash("sha256")
    .update(`meta-pi-auth-path:${credentialPath}`)
    .digest("hex");
}

/** Claims the credential-store context that produced the next Meta snapshot. */
export function publishMetaReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

export function metaReadingContextId(): string | undefined {
  return readingContextId;
}
