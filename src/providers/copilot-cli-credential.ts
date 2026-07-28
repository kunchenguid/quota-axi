import { homedir } from "node:os";
import { join } from "node:path";
import {
  errorCode,
  nonempty,
  objectValue,
  readBoundedFile,
} from "../lib/credential-file.js";
import { matchesUserEndpoint, normalizeHost } from "./copilot.js";

export const COPILOT_CLI_CREDENTIAL_SOURCE = "copilot-cli-config";

const CREDENTIAL_FILE_LIMIT_BYTES = 1024 * 1024;

export type CopilotCliCredentialResolution =
  | { status: "available"; oauthToken: string; login?: string; host?: string }
  | { status: "missing" }
  | { status: "invalid"; reason?: "cli_config_parse_error" }
  | { status: "skipped"; reason: "unsupported_platform" };

export type CopilotCliCredentialInspection =
  CopilotCliCredentialResolution["status"];

export type CopilotCliCredentialSource = {
  resolve(): Promise<CopilotCliCredentialResolution>;
  inspect(): Promise<CopilotCliCredentialInspection>;
};

type CredentialSourceDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  platform: () => NodeJS.Platform;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

type TokenCandidate = {
  key: string;
  host: string;
  login: string;
  token: string;
};

export function copilotCliConfigPath(
  overrides: Partial<
    Pick<CredentialSourceDependencies, "environment" | "homeDirectory">
  > = {},
): string {
  const environment = overrides.environment ?? process.env;
  const homeDirectory = overrides.homeDirectory ?? homedir;
  const configured = nonempty(environment.GITHUB_COPILOT_CLI_CONFIG);
  if (configured) return configured;
  const home = nonempty(environment.HOME) ?? homeDirectory();
  return join(home, ".copilot", "config.json");
}

export function createCopilotCliCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): CopilotCliCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    platform: () => process.platform,
    readFile: readBoundedFile,
    ...overrides,
  };

  const inspect = async (): Promise<CopilotCliCredentialInspection> =>
    (await resolveCredential(dependencies)).status;

  return {
    resolve: () => resolveCredential(dependencies),
    inspect,
  };
}

async function resolveCredential(
  dependencies: CredentialSourceDependencies,
): Promise<CopilotCliCredentialResolution> {
  if (dependencies.platform() === "win32") {
    return { status: "skipped", reason: "unsupported_platform" };
  }

  const path = copilotCliConfigPath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, CREDENTIAL_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  }
  if (contents.byteLength > CREDENTIAL_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCommentLines(contents.toString("utf8")));
  } catch {
    return { status: "invalid", reason: "cli_config_parse_error" };
  }

  const config = objectValue(parsed);
  const selected = config ? selectToken(config) : undefined;
  if (!selected) return { status: "invalid" };

  return {
    status: "available",
    oauthToken: selected.token,
    login: selected.login,
    host: normalizeHost(selected.host) ?? selected.host,
  };
}

/**
 * Strips only lines whose trimmed content begins with "//". A greedy
 * `//.*$` regex would truncate `copilotTokens` keys such as
 * `"https://github.com:adibirzu"` mid-string; whole-line filtering leaves
 * every quoted JSON value untouched. Inline trailing comments are out of
 * scope by design (PRD R1).
 */
function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/**
 * Deterministic token selection over `copilotTokens` (PRD R2/R3), restricted
 * to entries whose host normalises to the public user endpoint — host-scoped
 * GitHub Enterprise tokens are treated as unavailable here, matching the
 * apps-json invariant (only public GitHub host tokens are ever sent to the
 * public endpoint):
 * 1. exact match on `${lastLoggedInUser.host}:${lastLoggedInUser.login}`;
 * 2. else the first public-endpoint entry;
 * 3. else undefined (no public-endpoint token).
 */
function selectToken(
  config: Record<string, unknown>,
): TokenCandidate | undefined {
  const tokens = objectValue(config.copilotTokens);
  if (!tokens) return undefined;

  const candidates: TokenCandidate[] = [];
  for (const [key, rawValue] of Object.entries(tokens)) {
    const token = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!token) continue;
    const separatorIndex = key.lastIndexOf(":");
    if (separatorIndex === -1) continue;
    const host = key.slice(0, separatorIndex);
    const normalized = normalizeHost(host);
    if (normalized === undefined || !matchesUserEndpoint(normalized)) continue;
    candidates.push({
      key,
      host,
      login: key.slice(separatorIndex + 1),
      token,
    });
  }
  if (candidates.length === 0) return undefined;

  const lastLoggedInUser = objectValue(config.lastLoggedInUser);
  const lastHost = stringValue(lastLoggedInUser?.host);
  const lastLogin = stringValue(lastLoggedInUser?.login);
  if (lastHost !== undefined && lastLogin !== undefined) {
    const composedKey = `${lastHost}:${lastLogin}`;
    const exact = candidates.find((candidate) => candidate.key === composedKey);
    if (exact) return exact;
  }

  return candidates[0];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
