import { homedir } from "node:os";
import { readBoundedFile } from "../lib/fs.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";

/**
 * Pi's GitHub Copilot login, read in place as a GitHub Copilot credential.
 *
 * Pi signs in to Copilot with GitHub's device flow and stores the result in
 * `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`) under
 * `github-copilot`. That entry holds two different credentials:
 *
 * - `refresh` is the GitHub OAuth token the device flow returned. Despite the
 *   field name it is not an OAuth refresh token: Pi sends it as a bearer to
 *   GitHub's Copilot token endpoint and writes the same value back unchanged,
 *   so it never rotates on use. It is the same kind of credential as the
 *   `oauth_token` in Copilot's own `apps.json` and in `gh`'s `hosts.yml`.
 * - `access` and `expires` are the short-lived Copilot session token Pi mints
 *   from it for model requests. GitHub's Copilot user endpoint rejects that
 *   session token, so it is never read here, and its expiry says nothing about
 *   the GitHub token.
 *
 * quota-axi sends the GitHub token only to `api.github.com` as the bearer of
 * the read-only Copilot user request, the host Pi already sends it to. It never
 * mints a session token, launches Pi, refreshes, or writes Pi's store. A login
 * Pi recorded for a GitHub Enterprise host (`enterpriseUrl`) is not sent to the
 * public endpoint. See README Provider notes.
 */
export const PI_COPILOT_CREDENTIAL_SOURCE = "pi:github-copilot";

const PI_PROVIDER_ID = "github-copilot";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;
/** The only hosts whose Pi login may reach the public Copilot user endpoint. */
const PUBLIC_GITHUB_HOSTS = new Set(["github.com", "api.github.com"]);

export type PiCopilotCredentialResolution =
  /** No Pi store, or one without a `github-copilot` entry. */
  | { status: "absent"; path: string }
  /** The entry exists but holds no usable GitHub token. */
  | { status: "structurally_invalid"; path: string }
  /** A usable entry this source cannot send to the public endpoint. */
  | {
      status: "unsupported";
      path: string;
      error: "selected_host_unsupported" | "unsupported_credential_type";
    }
  /** The store exists but could not be read. */
  | { status: "read_error"; path: string }
  | {
      status: "resolved";
      path: string;
      /** Probe use only; never log, render, or cache. */
      token: string;
    };

type PiCopilotCredentialDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export async function resolvePiCopilotCredential(
  overrides: Partial<PiCopilotCredentialDependencies> = {},
): Promise<PiCopilotCredentialResolution> {
  const dependencies: PiCopilotCredentialDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    ...overrides,
  };
  const path = resolvePiAuthFilePath(
    dependencies.environment,
    dependencies.homeDirectory,
  );

  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "absent", path }
      : { status: "read_error", path };
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) {
    return { status: "structurally_invalid", path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "structurally_invalid", path };
  }

  const classified = classifyPiAuthEntry(parsed, PI_PROVIDER_ID);
  if (classified.status === "missing") return { status: "absent", path };
  if (classified.status === "invalid") {
    return { status: "structurally_invalid", path };
  }
  return credentialFromPiEntry(classified.entry, path);
}

/**
 * Classify Pi's `github-copilot` entry. Only `type`, `enterpriseUrl`, and
 * `refresh` are read; the session token, its expiry, and the model list are
 * not, and an enterprise login's token is not read at all.
 */
export function credentialFromPiEntry(
  entry: Record<string, unknown>,
  path: string,
): PiCopilotCredentialResolution {
  const type = stringValue(entry.type)?.toLowerCase();
  if (type === undefined) return { status: "structurally_invalid", path };
  if (type !== "oauth") {
    return {
      status: "unsupported",
      path,
      error: "unsupported_credential_type",
    };
  }

  const host = enterpriseHost(entry.enterpriseUrl);
  if (host === "invalid") return { status: "structurally_invalid", path };
  if (host !== undefined && !PUBLIC_GITHUB_HOSTS.has(host)) {
    // An enterprise login's token is never read, let alone sent.
    return { status: "unsupported", path, error: "selected_host_unsupported" };
  }

  const token = usableLiteralSecret(entry.refresh);
  return token === undefined
    ? { status: "structurally_invalid", path }
    : { status: "resolved", path, token };
}

/**
 * The host Pi's login belongs to. Pi stores `enterpriseUrl` only for a GitHub
 * Enterprise sign-in and treats a missing or empty value as `github.com`.
 */
function enterpriseHost(value: unknown): string | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  try {
    const hostname = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    ).hostname.toLowerCase();
    return hostname === "" ? "invalid" : hostname;
  } catch {
    return "invalid";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
