import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, statusFromError } from "./common.js";

// TODO(phase-2): wire cline daily-free + daily-subscription usage windows
// (app.cline.bot account usage). Phase 1 only detects a local config/token
// file and reports auth status; no usage windows are fetched yet.

const AUTH_SOURCE = "cline-config";

type CredentialState =
  | { status: "available"; source: AuthSourceReport }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

export const clineAdapter: ProviderAdapter = {
  id: "cline",
  label: "Cline",
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
      provider: "cline",
      label: "Cline",
      status: "unavailable",
      source: "web",
      error: "cline usage endpoint not yet implemented (phase 2)",
      sourcesTried: [AUTH_SOURCE],
      attempts,
    });
  }

  const error = "Cline sign-in required";
  const attempts: SourceAttempt[] = [
    {
      source: AUTH_SOURCE,
      status: "skipped",
      error: `credentials_${state.status}`,
      credentialPresent: false,
    },
  ];
  return failedProvider({
    provider: "cline",
    label: "Cline",
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
  return { provider: "cline", sources: [state.source] };
}

type Candidate = { path: string; explicit: boolean };

// Field names that identify a file as an actual Cline (app.cline.bot)
// credential/config rather than an unrelated file that happens to sit at
// ~/.cline (a name other tools also use).
const CLINE_AUTH_KEYS = [
  "token",
  "apiKey",
  "api_key",
  "apiToken",
  "accessToken",
  "access_token",
  "authToken",
  "auth_token",
  "clineApiKey",
  "clineAccountId",
  "clineAccountUserId",
  "credentials",
  "sessionToken",
  "userInfo",
];

function readCredentialState(
  candidates = clineConfigCandidates(),
): CredentialState {
  // Probe candidate config/token files in priority order. A directory is
  // skipped (some tools use ~/.cline as a directory). An explicit env override
  // is authoritative: a parseable file there is available, an unparseable one
  // is invalid. Discovered (non-explicit) files must actually look like Cline
  // auth to count — this avoids false positives from unrelated JSON that
  // happens to share the path. If nothing matches, report missing cleanly.
  for (const { path, explicit } of candidates) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // missing
    }
    if (!stat.isFile()) continue; // skip directories
    const raw = readJsonFileResult(path);
    if (raw.status === "missing") continue;
    if (raw.status === "invalid") {
      if (explicit)
        return {
          status: "invalid",
          source: authSource(path, "invalid", raw.error),
        };
      continue; // corrupt/unrelated non-Cline file — keep looking
    }
    if (explicit || looksLikeClineAuth(raw.value))
      return { status: "available", source: authSource(path, "available") };
    // Parseable but not recognizable as Cline auth — keep looking.
  }
  const primary = candidates[0]?.path ?? join(homedir(), ".cline", "auth.json");
  return { status: "missing", source: authSource(primary, "missing") };
}

function looksLikeClineAuth(value: unknown): boolean {
  const data = objectValue(value);
  if (!data) return false;
  return CLINE_AUTH_KEYS.some((key) => key in data);
}

function clineConfigCandidates(): Candidate[] {
  const home = homedir();
  const candidates: Candidate[] = [];

  const envConfig = stringValue(process.env.CLINE_CONFIG);
  if (envConfig) candidates.push({ path: envConfig, explicit: true });
  const envAuth = stringValue(process.env.CLINE_AUTH);
  if (envAuth) candidates.push({ path: envAuth, explicit: true });

  // Dedicated dotfile locations.
  for (const path of [
    join(home, ".cline", "auth.json"),
    join(home, ".cline", "config.json"),
    join(home, ".config", "cline", "auth.json"),
    join(home, ".config", "cline", "config.json"),
  ]) {
    candidates.push({ path, explicit: false });
  }

  // VS Code (and forks) globalStorage for the Cline / Claude Dev extension.
  const extensionIds = ["saoudrizwan.claude-dev", "cline.cline"];
  const configFiles = [
    "auth.json",
    "config.json",
    join("settings", "cline_mcp_settings.json"),
  ];
  for (const base of vscodeGlobalStorageBases(home)) {
    for (const extensionId of extensionIds) {
      for (const file of configFiles) {
        candidates.push({ path: join(base, extensionId, file), explicit: false });
      }
    }
  }

  return candidates;
}

function vscodeGlobalStorageBases(home: string): string[] {
  const apps = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
  const roots =
    process.platform === "darwin"
      ? [join(home, "Library", "Application Support")]
      : process.platform === "win32"
        ? [process.env.APPDATA || join(home, "AppData", "Roaming")]
        : [process.env.XDG_CONFIG_HOME || join(home, ".config")];
  return roots.flatMap((root) =>
    apps.map((app) => join(root, app, "User", "globalStorage")),
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
