import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { execFileText } from "../lib/process.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.202";
const API_TIMEOUT_MS = 15_000;
const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;
const CREDENTIAL_FILE = join(homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

type ClaudeCredentials = {
  source: "oauth-file" | "keychain";
  accessToken: string;
  plan?: string;
  expiresAt?: number;
};

type AvailableCredentialState = {
  status: "available";
  credentials: ClaudeCredentials;
};
type UnavailableCredentialState = {
  status: "missing" | "invalid" | "expired";
  source: AuthSourceReport;
};
type SkippedCredentialState = { status: "skipped"; source: AuthSourceReport };
type CredentialState =
  | AvailableCredentialState
  | UnavailableCredentialState
  | SkippedCredentialState;
type KeychainItemPresence = "present" | "missing" | "unknown";

type RawUsageWindow = {
  utilization?: unknown;
  resets_at?: unknown;
  reset_at?: unknown;
};

type ExtraUsageWindow = RawUsageWindow & {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  decimal_places?: unknown;
};

// A scoped-limit entry as returned in the `limits` array of the OAuth usage
// response. Unlike the fixed top-level fields (five_hour, seven_day, ...),
// this array self-describes every limit the account currently has, including
// ones scoped to a specific model (scope.model.display_name).
type ScopedLimitEntry = {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: unknown;
};

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  label: "Claude",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError = "Claude quota unavailable";
  let retryAfter: string | undefined;

  const credentialStates = await readCredentialStates(options);
  const credentials = credentialStates
    .filter(
      (state): state is AvailableCredentialState =>
        state.status === "available",
    )
    .map((state) => state.credentials)
    .sort((a, b) => {
      if (process.platform === "darwin") {
        if (a.source === "keychain" && b.source !== "keychain") return -1;
        if (b.source === "keychain" && a.source !== "keychain") return 1;
      }
      return (b.expiresAt ?? 0) - (a.expiresAt ?? 0);
    });

  for (const state of credentialStates) {
    if (state.status === "available") continue;
    if (state.status === "skipped") {
      const attempt: SourceAttempt = {
        source: state.source.source,
        status: "skipped",
        error: state.source.error,
      };
      if (state.source.credentialPresent) attempt.credentialPresent = true;
      attempts.push(attempt);
      if (finalError === "Claude quota unavailable")
        finalError = state.source.error ?? finalError;
      continue;
    }
    attempts.push({
      source: state.source.source,
      status: "skipped",
      error: `credentials_${state.status}`,
    });
    finalError = "Claude sign-in required";
  }

  if (credentials.length > 0) {
    for (const credential of credentials) {
      attempts.push({ source: "oauth", status: "failed" });
      try {
        const quota = await fetchOauthUsage(credential);
        attempts[attempts.length - 1] = { source: "oauth", status: "success" };
        return successProvider({
          provider: "claude",
          label: "Claude",
          source: "oauth",
          plan: quota.plan,
          account: quota.account,
          windows: quota.windows,
          refreshedAt: quota.refreshedAt,
          sourcesTried: sourceNames(attempts),
          attempts,
        });
      } catch (error) {
        const message = errorMessage(error);
        attempts[attempts.length - 1] = {
          source: "oauth",
          status: "failed",
          error: message,
        };
        finalError = message;
        if (error instanceof RateLimitError) retryAfter = error.retryAfter;
        if (message === "Claude sign-in required") {
          continue;
        }
      }
    }
  }

  const cached = readCachedProvider("claude");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "claude",
    label: "Claude",
    status: retryAfter ? "rate_limited" : statusFromError(finalError),
    error: finalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const states = await readCredentialStates(options);
  const sources = states.map((state): AuthSourceReport => {
    if (state.status === "available") {
      return {
        source: state.credentials.source,
        path:
          state.credentials.source === "oauth-file"
            ? CREDENTIAL_FILE
            : undefined,
        status: "available",
      };
    }
    return state.source;
  });
  return { provider: "claude", sources };
}

export function normalizeClaudeApiUsage(
  raw: unknown,
  plan?: string,
): { plan?: string; windows: QuotaWindow[]; refreshedAt: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;

  // The `limits` array (when present) is the vendor's own authoritative list
  // of every window the account currently has, including ones scoped to a
  // specific model (e.g. Fable, Opus). Prefer it over the fixed top-level
  // fields so newly introduced scoped limits show up without code changes.
  const scopedWindows = normalizeScopedLimits(data.limits);
  const windows =
    scopedWindows.length > 0
      ? scopedWindows
      : [
          normalizeWindow(data.five_hour, "five_hour", "session", "session"),
          normalizeWindow(data.seven_day, "seven_day", "week", "weekly"),
          normalizeWindow(
            data.seven_day_opus,
            "seven_day_opus",
            "opus week",
            "model",
          ),
        ].filter((window): window is QuotaWindow => Boolean(window));

  const extraUsage = normalizeExtraUsage(data.extra_usage);
  if (extraUsage) windows.push(extraUsage);

  if (windows.length === 0) return undefined;
  return { plan, windows, refreshedAt: nowIso() };
}

function normalizeScopedLimits(raw: unknown): QuotaWindow[] {
  if (!Array.isArray(raw)) return [];
  const windows: QuotaWindow[] = [];
  for (const entry of raw) {
    const window = normalizeScopedLimitEntry(entry);
    if (window) windows.push(window);
  }
  return windows;
}

function normalizeScopedLimitEntry(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as ScopedLimitEntry;
  const percent = typeof entry.percent === "number" ? entry.percent : undefined;
  if (percent === undefined) return undefined;
  const resetsAt = stringValue(entry.resets_at);

  const scope = objectValue(entry.scope);
  const model = scope ? objectValue(scope.model) : undefined;
  const modelName = model ? stringValue(model.display_name) : undefined;
  if (modelName) {
    const modelKey = stringValue(model?.id) ?? slugify(modelName);
    return withRemaining({
      id: `model:${modelKey}`,
      label: `${modelName} week`,
      kind: "model",
      percentUsed: clampPercent(percent),
      resetsAt,
    });
  }

  const group = stringValue(entry.group);
  if (group === "session") {
    return withRemaining({
      id: "five_hour",
      label: "session",
      kind: "session",
      percentUsed: clampPercent(percent),
      resetsAt,
    });
  }
  if (group === "weekly") {
    return withRemaining({
      id: "seven_day",
      label: "week",
      kind: "weekly",
      percentUsed: clampPercent(percent),
      resetsAt,
    });
  }

  const kind = stringValue(entry.kind);
  return withRemaining({
    id: kind ?? "limit",
    label: kind ?? "limit",
    kind: "unknown",
    percentUsed: clampPercent(percent),
    resetsAt,
  });
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function readCredentialStates(
  options: ProviderOptions,
): Promise<CredentialState[]> {
  const states: CredentialState[] = [];

  const fileState = extractCredentialState(
    readJsonFileResult(CREDENTIAL_FILE),
    "oauth-file",
    CREDENTIAL_FILE,
  );
  states.push(fileState);

  if (process.platform === "darwin") {
    if (!options.allowKeychainPrompt) {
      states.push(await readSkippedKeychainCredentialState());
    } else {
      states.push(await readKeychainCredentialState());
    }
  }

  return states;
}

async function readSkippedKeychainCredentialState(): Promise<CredentialState> {
  const presence = await readKeychainItemPresence();
  if (presence === "present") {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
    };
  }
  if (presence === "missing") {
    return {
      status: "missing",
      source: { source: "keychain", status: "missing" },
    };
  }
  return {
    status: "skipped",
    source: {
      source: "keychain",
      status: "skipped",
      error: "keychain_presence_check_failed",
    },
  };
}

async function readKeychainItemPresence(): Promise<KeychainItemPresence> {
  try {
    await execFileText(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return "present";
  } catch (error) {
    return isKeychainItemNotFound(error) ? "missing" : "unknown";
  }
}

async function readKeychainCredentialState(): Promise<CredentialState> {
  let blob: string;
  try {
    blob = await execFileText(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    return keychainFailureState(error);
  }
  try {
    return extractCredentialState(
      { status: "success", value: JSON.parse(blob) },
      "keychain",
    );
  } catch {
    return {
      status: "invalid",
      source: {
        source: "keychain",
        status: "invalid",
        error: "json_parse_error",
      },
    };
  }
}

function isKeychainItemNotFound(error: unknown): boolean {
  return (
    (error as { code?: number | string | null }).code ===
    KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE
  );
}

function keychainFailureState(error: unknown): CredentialState {
  const failure = error as {
    killed?: boolean;
    signal?: string | null;
    code?: number | string | null;
  };
  if (failure.killed || failure.signal) {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_timeout",
      },
    };
  }
  if (isKeychainItemNotFound(error)) {
    return {
      status: "missing",
      source: { source: "keychain", status: "missing" },
    };
  }
  return {
    status: "skipped",
    source: {
      source: "keychain",
      status: "skipped",
      error: "keychain_access_denied",
    },
  };
}

function extractCredentialState(
  raw: JsonFileReadResult,
  source: ClaudeCredentials["source"],
  path?: string,
): CredentialState {
  if (raw.status === "missing")
    return { status: "missing", source: { source, path, status: "missing" } };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: { source, path, status: "invalid", error: raw.error },
    };
  const data = objectValue(raw.value);
  if (!data)
    return { status: "invalid", source: { source, path, status: "invalid" } };
  const oauth =
    data.claudeAiOauth && typeof data.claudeAiOauth === "object"
      ? (data.claudeAiOauth as Record<string, unknown>)
      : data;
  const accessToken =
    stringValue(oauth.accessToken) ?? stringValue(oauth.access_token);
  if (!accessToken)
    return { status: "invalid", source: { source, path, status: "invalid" } };
  const expiresAt = expiresAtMillis(oauth.expiresAt);
  if (expiresAt !== undefined && expiresAt <= Date.now())
    return { status: "expired", source: { source, path, status: "expired" } };
  const plan =
    stringValue(oauth.subscriptionType) ?? stringValue(data.subscriptionType);
  return {
    status: "available",
    credentials: { source, accessToken, plan, expiresAt },
  };
}

async function fetchOauthUsage(credentials: ClaudeCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    rejectUnusableUsageResponse(response);
    const quota = normalizeClaudeApiUsage(
      await response.json(),
      credentials.plan,
    );
    if (!quota) throw new Error("Claude quota unavailable");
    return quota;
  } finally {
    clearTimeout(timer);
  }
}

// Anthropic's OAuth usage endpoint follows plain HTTP semantics: 401/403 mean
// the access token no longer authenticates, and 429 means the caller must
// back off, honoring the standard `Retry-After` header (RFC 9110 - either a
// delay in seconds or an HTTP-date).
function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error("Claude sign-in required");
  }
  if (response.status === 429) {
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  }
  if (!response.ok) {
    throw new Error(`Claude quota unavailable (${response.status})`);
  }
}

function normalizeWindow(
  raw: unknown,
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as RawUsageWindow;
  const used =
    typeof data.utilization === "number" ? data.utilization : undefined;
  if (used === undefined) return undefined;
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: clampPercent(used),
    resetsAt: stringValue(data.resets_at) ?? stringValue(data.reset_at),
  });
}

function normalizeExtraUsage(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as ExtraUsageWindow;
  if (data.is_enabled !== true) return undefined;
  const decimalPlaces =
    typeof data.decimal_places === "number" ? data.decimal_places : 2;
  const minorUnitDivisor = 10 ** decimalPlaces;
  const spentUsd =
    typeof data.used_credits === "number"
      ? data.used_credits / minorUnitDivisor
      : undefined;
  const limitUsd =
    typeof data.monthly_limit === "number"
      ? data.monthly_limit / minorUnitDivisor
      : undefined;
  const percentUsed =
    typeof data.utilization === "number"
      ? clampPercent(data.utilization)
      : spentUsd !== undefined && limitUsd && limitUsd > 0
        ? clampPercent((spentUsd / limitUsd) * 100)
        : undefined;
  return withRemaining({
    id: "extra_usage",
    label: "extra usage",
    kind: "credits",
    percentUsed,
    spentUsd,
    limitUsd,
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expiresAtMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Claude quota request timed out";
  return error instanceof Error ? error.message : "Claude quota unavailable";
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Claude quota endpoint rate limited");
  }
}
