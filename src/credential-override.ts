import { readFileSync, statSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { PROVIDER_IDS } from "./types.js";
import type {
  AuthCapabilities,
  CredentialOverride,
  CredentialOverrideMap,
  ProviderId,
} from "./types.js";

/**
 * The uniform, provider-blind credential-override contract. See
 * docs/credential-override.md for the full contract; the short version:
 *
 * A caller may pass `{"schema": 1, "credentials": {"<provider>": {"kind":
 * "bearer", "token": "..."}}}` on stdin (preferred) or in a 0600 file named
 * by $QUOTA_AXI_CREDENTIALS_FILE. The named provider's adapter then uses ONLY
 * that credential for the flight: no local-source fallback, no stale-cache
 * answer, `source: "override"` attribution, and a truthful `override_rejected`
 * auth result when the provider refuses the token. When no envelope is
 * present, behavior is byte-for-byte unchanged.
 *
 * Token bytes live only in this process's memory: they are never logged,
 * printed, cached, placed in argv, or copied into the environment of any
 * child process (including the Codex app-server fallback, which never runs
 * during an override flight anyway).
 */

export const CREDENTIAL_OVERRIDE_FILE_ENV = "QUOTA_AXI_CREDENTIALS_FILE";
export const CREDENTIAL_OVERRIDE_ENVELOPE_SCHEMA = 1;
export const MAX_OVERRIDE_ENVELOPE_BYTES = 64 * 1024;
export const MAX_OVERRIDE_TOKEN_LENGTH = 4_096;

/** Advertised in the `auth --json` report for consumer feature detection. */
export const CREDENTIAL_OVERRIDE_CAPABILITY: AuthCapabilities["credentialOverride"] =
  {
    schema: CREDENTIAL_OVERRIDE_ENVELOPE_SCHEMA,
    transports: ["stdin", "file"],
  };

const ENVELOPE_FIELDS = new Set(["schema", "credentials"]);
const CREDENTIAL_FIELDS = new Set(["kind", "token"]);

export type CredentialOverrideTransport = {
  /** Default reads fd 0 unless it is a terminal. */
  stdin?: () => string | undefined;
  /** Default is process.env. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolve this invocation's credential overrides from the two supported
 * transports. Returns undefined when no envelope is present, which preserves
 * the exact pre-override behavior. Malformed envelopes fail closed with a
 * validation error: silently ignoring a broken override would report local
 * credentials to a caller that believes an override is active.
 */
export function resolveCredentialOverrides(
  transport: CredentialOverrideTransport = {},
): CredentialOverrideMap | undefined {
  const env = transport.env ?? process.env;

  let fileText: string | undefined;
  const filePath = env[CREDENTIAL_OVERRIDE_FILE_ENV]?.trim();
  if (filePath) fileText = readOverrideFile(filePath);

  const stdinText = transport.stdin ? transport.stdin() : readStdinText();

  const fileHas = hasEnvelopeBytes(fileText);
  const stdinHas = hasEnvelopeBytes(stdinText);
  if (fileHas && stdinHas) {
    throw new AxiError(
      `credential override envelope supplied via both stdin and ${CREDENTIAL_OVERRIDE_FILE_ENV}`,
      "VALIDATION_ERROR",
      ["Use exactly one credential-override transport per invocation"],
    );
  }
  const text = fileHas ? fileText : stdinText;
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, "utf8") > MAX_OVERRIDE_ENVELOPE_BYTES) {
    throw new AxiError(
      `credential override envelope exceeds ${MAX_OVERRIDE_ENVELOPE_BYTES} bytes`,
      "VALIDATION_ERROR",
      ["Send only the documented schema-1 credential envelope"],
    );
  }
  return parseCredentialOverrideEnvelope(text);
}

/**
 * Parse and validate a schema-1 envelope. Never echoes token bytes into any
 * error message; validation failures describe structure only.
 */
export function parseCredentialOverrideEnvelope(
  text: string,
): CredentialOverrideMap | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw envelopeError(
      "credential override envelope is not valid JSON",
      "Pipe the documented schema-1 JSON envelope, or leave stdin empty",
    );
  }
  const root = plainObject(raw);
  if (!root) {
    throw envelopeError(
      "credential override envelope must be a JSON object",
      'Expected {"schema": 1, "credentials": {"<provider>": {"kind": "bearer", "token": "..."}}}',
    );
  }
  for (const field of Object.keys(root)) {
    if (!ENVELOPE_FIELDS.has(field)) {
      throw envelopeError(
        `credential override envelope has unsupported field: ${field}`,
        "The schema-1 envelope carries only schema and credentials",
      );
    }
  }
  if (root.schema !== CREDENTIAL_OVERRIDE_ENVELOPE_SCHEMA) {
    throw envelopeError(
      "credential override envelope schema must be 1",
      "Check `quota-axi auth --json` capabilities.credentialOverride for the accepted schema",
    );
  }
  const credentials = plainObject(root.credentials);
  if (!credentials) {
    throw envelopeError(
      "credential override envelope credentials must be an object",
      'Expected "credentials": {"<provider>": {"kind": "bearer", "token": "..."}}',
    );
  }
  const entries = Object.entries(credentials);
  if (entries.length === 0) {
    throw envelopeError(
      "credential override envelope names no providers",
      "Remove the envelope entirely to use local credential sources",
    );
  }

  const overrides: CredentialOverrideMap = {};
  for (const [provider, value] of entries) {
    if (!isProviderId(provider)) {
      throw envelopeError(
        `credential override names unsupported provider: ${provider}`,
        `Supported providers: ${PROVIDER_IDS.join(", ")}`,
      );
    }
    overrides[provider] = parseCredentialEntry(provider, value);
  }
  return overrides;
}

function parseCredentialEntry(
  provider: ProviderId,
  value: unknown,
): CredentialOverride {
  const entry = plainObject(value);
  if (!entry) {
    throw envelopeError(
      `credential override for ${provider} must be an object`,
      'Expected {"kind": "bearer", "token": "..."}',
    );
  }
  for (const field of Object.keys(entry)) {
    if (!CREDENTIAL_FIELDS.has(field)) {
      throw envelopeError(
        `credential override for ${provider} has unsupported field: ${field}`,
        'Schema 1 carries only {"kind": "bearer", "token": "..."} per provider',
      );
    }
  }
  if (entry.kind !== "bearer") {
    throw envelopeError(
      `credential override for ${provider} must use kind "bearer"`,
      'The schema-1 envelope supports only {"kind": "bearer"} bearer tokens',
    );
  }
  return { kind: "bearer", token: validatedToken(provider, entry.token) };
}

// Mirrors the literal-secret rules used for Pi auth.json entries: a token is
// a header-safe literal, never an environment, template, or command reference.
function validatedToken(provider: ProviderId, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw envelopeError(
      `credential override for ${provider} requires a non-empty token string`,
      "Token bytes are never echoed; check the supplied credential material",
    );
  }
  if (value !== value.trim()) {
    throw envelopeError(
      `credential override for ${provider} token has surrounding whitespace`,
      "Token bytes are never echoed; check the supplied credential material",
    );
  }
  if (value.length > MAX_OVERRIDE_TOKEN_LENGTH) {
    throw envelopeError(
      `credential override for ${provider} token exceeds ${MAX_OVERRIDE_TOKEN_LENGTH} characters`,
      "Token bytes are never echoed; check the supplied credential material",
    );
  }
  if (value.startsWith("!") || value.includes("$")) {
    throw envelopeError(
      `credential override for ${provider} token looks like a command or environment reference`,
      "Pass the literal token value; references are never resolved",
    );
  }
  if ([...value].some(isControlCharacter)) {
    throw envelopeError(
      `credential override for ${provider} token contains control characters`,
      "Token bytes are never echoed; check the supplied credential material",
    );
  }
  return value;
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

function readOverrideFile(path: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw envelopeError(
      `${CREDENTIAL_OVERRIDE_FILE_ENV} file is not readable`,
      "Create the override file with 0600 permissions before invoking quota-axi",
    );
  }
  if (!stat.isFile()) {
    throw envelopeError(
      `${CREDENTIAL_OVERRIDE_FILE_ENV} must name a regular file`,
      "Create the override file with 0600 permissions before invoking quota-axi",
    );
  }
  if (stat.size > MAX_OVERRIDE_ENVELOPE_BYTES) {
    throw envelopeError(
      `${CREDENTIAL_OVERRIDE_FILE_ENV} file exceeds ${MAX_OVERRIDE_ENVELOPE_BYTES} bytes`,
      "Send only the documented schema-1 credential envelope",
    );
  }
  // POSIX mode bits are the contract; Windows ACLs are owned by the caller.
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw envelopeError(
      `${CREDENTIAL_OVERRIDE_FILE_ENV} file must not be readable by group or others (expected 0600)`,
      `chmod 600 the override file, or prefer the stdin transport`,
    );
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw envelopeError(
      `${CREDENTIAL_OVERRIDE_FILE_ENV} file is not readable`,
      "Create the override file with 0600 permissions before invoking quota-axi",
    );
  }
}

/**
 * Read the envelope from the inherited stdin pipe. A terminal stdin means no
 * envelope (interactive runs never carry one); an empty or unreadable stdin
 * also means no envelope. A pipe is read to EOF, so the sender must close it
 * after writing - the standard filter contract shared with tools like jq.
 */
function readStdinText(): string | undefined {
  if (process.stdin.isTTY === true) return undefined;
  try {
    return readFileSync(0, "utf8");
  } catch {
    return undefined;
  }
}

function hasEnvelopeBytes(text: string | undefined): boolean {
  return text !== undefined && text.trim().length > 0;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function envelopeError(message: string, remedy: string): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", [remedy]);
}
