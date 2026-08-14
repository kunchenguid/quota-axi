import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, statusFromError } from "./common.js";

// TODO(phase-2): wire Antigravity/Gemini usage endpoint. Phase 1 only detects
// the oauth token and reports auth status; no usage windows are fetched yet.

const AUTH_SOURCE = "antigravity-oauth-token";

type AgyCredentials = {
  token: string;
  authMethod?: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: AgyCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid" | "expired"; source: AuthSourceReport };

export const agyAdapter: ProviderAdapter = {
  id: "agy",
  label: "Antigravity",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const state = readCredentialState();

  if (state.status === "available") {
    // TODO(phase-2): replace this stub with a real usage-window fetch.
    const attempts: SourceAttempt[] = [
      {
        source: AUTH_SOURCE,
        status: "skipped",
        error: "phase_2_pending",
        credentialPresent: true,
      },
    ];
    return failedProvider({
      provider: "agy",
      label: "Antigravity",
      status: "unavailable",
      source: "oauth",
      error: "agy usage endpoint not yet implemented (phase 2)",
      sourcesTried: [AUTH_SOURCE],
      attempts,
    });
  }

  const error =
    state.status === "expired"
      ? "Antigravity access token expired"
      : "Antigravity sign-in required";
  const attempts: SourceAttempt[] = [
    {
      source: AUTH_SOURCE,
      status: "skipped",
      error: `credentials_${state.status}`,
      credentialPresent: false,
    },
  ];
  return failedProvider({
    provider: "agy",
    label: "Antigravity",
    status: statusFromError(error),
    error,
    sourcesTried: [AUTH_SOURCE],
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const state = readCredentialState();
  return { provider: "agy", sources: [state.source] };
}

function readCredentialState(path = agyTokenFile()): CredentialState {
  return extractCredentialState(readJsonFileResult(path), path);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return { status: "missing", source: authSource(path, "missing") };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: authSource(path, "invalid", raw.error),
    };
  const data = objectValue(raw.value);
  // Shape is {token, auth_method}. `token` may be a bare string or a nested
  // OAuth object ({access_token, refresh_token, expiry, ...}); both count as a
  // present credential.
  const tokenString = stringValue(data?.token);
  const tokenObject = objectValue(data?.token);
  const hasToken = Boolean(tokenString ?? tokenObject);
  if (!data || !hasToken)
    return { status: "invalid", source: authSource(path, "invalid") };

  // Only treat the credential as expired when an expiry is actually exposed —
  // either at the top level or inside the nested token object.
  const expiresAt =
    stringValue(data.expires_at) ??
    stringValue(data.expiresAt) ??
    stringValue(tokenObject?.expiry) ??
    stringValue(tokenObject?.expires_at) ??
    stringValue(tokenObject?.expiresAt);
  if (isExpired(expiresAt))
    return {
      status: "expired",
      source: authSource(path, "expired"),
    };

  return {
    status: "available",
    credentials: {
      token: tokenString ?? "present",
      authMethod: stringValue(data.auth_method),
    },
    source: authSource(path, "available"),
  };
}

function agyTokenFile(): string {
  return (
    stringValue(process.env.AGY_OAUTH_TOKEN) ??
    stringValue(process.env.ANTIGRAVITY_OAUTH_TOKEN) ??
    join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token")
  );
}

function authSource(
  path: string,
  status: AuthSourceReport["status"],
  error?: string,
): AuthSourceReport {
  return {
    source: AUTH_SOURCE,
    path,
    status,
    ...(error ? { error } : {}),
    credentialPresent: status === "available",
  };
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= Date.now();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
