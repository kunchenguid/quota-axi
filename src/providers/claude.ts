import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { deleteCachedProvider, readCachedProvider } from "../cache.js";
import {
  claudeKeychainAccessMarkerPath,
  ensurePrivateParent,
  readJsonFileResult,
  type JsonFileReadResult,
} from "../lib/fs.js";
import { execFileText } from "../lib/process.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  runOverrideFlight,
  sourceNames,
  statusFromError,
  successProvider,
  withRemaining,
  type OverrideErrorVerdict,
} from "./common.js";

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_API_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.202";
const API_TIMEOUT_MS = 15_000;
const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;
const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_KEYCHAIN_ACCOUNT = "claude-code-user";
const SAFE_KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const FIVE_HOURS_SECONDS = 18_000;
const SEVEN_DAYS_SECONDS = 604_800;

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
type AdvisoryExpiredCredentialState = {
  status: "expired";
  credentials: ClaudeCredentials;
  source: AuthSourceReport;
};
type UnavailableCredentialState = {
  status: "missing" | "invalid";
  source: AuthSourceReport;
};
type SkippedCredentialState = { status: "skipped"; source: AuthSourceReport };
type CredentialState =
  | AvailableCredentialState
  | AdvisoryExpiredCredentialState
  | UnavailableCredentialState
  | SkippedCredentialState;
type KeychainItemPresence = "present" | "missing" | "unknown";
type ClaudeAccount = NonNullable<ProviderQuota["account"]>;
type ClaudeIdentityResult = {
  account: ClaudeAccount;
  error?: string;
};
type ClaudeProfileLocations = {
  credentialFile: string;
  keychainAccount: string;
  keychainService: string;
  keychainAccessMarker: string;
};

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

type ClaudeFailureOptions = {
  status?: ProviderStatus;
  definitiveAuth?: boolean;
  staleEligible?: boolean;
  retryAfter?: string;
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
  const override = options.credentialOverrides?.claude;
  if (override) {
    return runOverrideFlight({
      provider: "claude",
      label: "Claude",
      token: override.token,
      fetchWithToken: (token) => fetchOauthUsage({ accessToken: token }),
      classifyError: classifyClaudeOverrideError,
    });
  }

  const attempts: SourceAttempt[] = [];

  const credentialStates = await readCredentialStates(options);
  const credentials = credentialStates
    .filter(
      (
        state,
      ): state is AvailableCredentialState | AdvisoryExpiredCredentialState =>
        state.status === "available" || state.status === "expired",
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
    if (state.status === "available" || state.status === "expired") continue;
    if (state.status === "skipped") {
      const attempt: SourceAttempt = {
        source: state.source.source,
        status: "skipped",
        error: state.source.error,
      };
      if (state.source.credentialPresent) attempt.credentialPresent = true;
      attempts.push(attempt);
      continue;
    }
    attempts.push({
      source: state.source.source,
      status: "skipped",
      error: `credentials_${state.status}`,
    });
  }

  let definitiveFailure: ClaudeFailure | undefined;
  let transientFailure: ClaudeFailure | undefined;

  if (credentials.length > 0) {
    for (const credential of credentials) {
      attempts.push({ source: credential.source, status: "failed" });
      try {
        const quota = await fetchOauthUsage(credential);
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "success",
        };
        attempts.push(
          quota.identityError
            ? {
                source: "oauth-profile",
                status: "failed",
                error: quota.identityError,
              }
            : { source: "oauth-profile", status: "success" },
        );
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
        const failure = claudeFailureFor(error);
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "failed",
          error: failure.code,
        };
        if (failure.definitiveAuth) definitiveFailure ??= failure;
        else transientFailure = failure;
      }
    }
  } else {
    const skipped = credentialStates.find(
      (state): state is SkippedCredentialState => state.status === "skipped",
    );
    if (skipped) {
      transientFailure = new ClaudeFailure(
        skipped.source.error ?? "Claude quota unavailable",
        { staleEligible: true },
      );
    } else {
      const invalid = credentialStates.some(
        (state) => state.status === "invalid",
      );
      definitiveFailure = new ClaudeFailure(
        invalid ? "credentials_invalid" : "credentials_missing",
        { status: "auth_required", definitiveAuth: true },
      );
    }
  }

  return failureReport(
    definitiveFailure ??
      transientFailure ??
      new ClaudeFailure("Claude quota unavailable", { staleEligible: true }),
    attempts,
  );
}

function failureReport(
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      deleteCachedProvider("claude");
    } catch {
      // Current authentication remains definitive when cache I/O is blocked.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = readCachedProvider("claude");
      const stale = cached
        ? staleClaudeReport(cached, failure, attempts, Date.now())
        : undefined;
      if (stale) return stale;
    } catch {
      // Cache I/O cannot replace the current bounded provider failure.
    }
  }

  return failedProvider({
    provider: "claude",
    label: "Claude",
    status: failure.status,
    error: failure.code,
    retryAfter: failure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

function staleClaudeReport(
  cached: ProviderQuota,
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "claude" ||
    cached.source !== "oauth" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  ) {
    return undefined;
  }
  const refreshedAt = Date.parse(cached.state.refreshedAt);
  if (!Number.isFinite(refreshedAt) || refreshedAt > now) return undefined;
  const ageMilliseconds = now - refreshedAt;
  if (ageMilliseconds >= SEVEN_DAYS_MS) return undefined;

  const windows = cached.windows.filter((window) => {
    if (window.resetsAt !== undefined) {
      const resetsAt = Date.parse(window.resetsAt);
      return Number.isFinite(resetsAt) && resetsAt > now;
    }
    const maxAge = resetlessWindowMaxAge(window);
    return maxAge !== undefined && ageMilliseconds < maxAge;
  });
  if (windows.length === 0) return undefined;

  return {
    provider: "claude",
    label: "Claude",
    source: "cache",
    ...(cached.plan ? { plan: cached.plan } : {}),
    windows,
    state: {
      status: "stale",
      stale: true,
      refreshedAt: cached.state.refreshedAt,
      error: failure.code,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: [...new Set([...sourceNames(attempts), "cache"])],
    },
    attempts,
  };
}

function resetlessWindowMaxAge(window: QuotaWindow): number | undefined {
  if (window.kind === "weekly" || window.kind === "model") {
    return SEVEN_DAYS_MS;
  }
  if (
    window.kind === "session" ||
    window.kind === "monthly" ||
    window.kind === "credits"
  ) {
    return FIVE_HOURS_MS;
  }
  return undefined;
}

function claudeFailureFor(error: unknown): ClaudeFailure {
  if (error instanceof ClaudeFailure) return error;
  return new ClaudeFailure(errorMessage(error), { staleEligible: true });
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const locations = resolveClaudeProfileLocations();
  const states = await readCredentialStates(options, locations);
  const sources = states.map((state): AuthSourceReport => {
    if (state.status === "available") {
      return {
        source: state.credentials.source,
        path:
          state.credentials.source === "oauth-file"
            ? locations.credentialFile
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

export function normalizeClaudeProfile(
  raw: unknown,
): ClaudeAccount | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const account = objectValue(data.account);
  const accountId = stringValue(account?.uuid);
  if (!accountId) return undefined;

  const organization = objectValue(data.organization);
  return {
    accountId,
    email:
      stringValue(account?.email) ??
      stringValue(account?.email_address) ??
      stringValue(account?.emailAddress) ??
      stringValue(data.email_address) ??
      stringValue(data.emailAddress) ??
      stringValue(data.email),
    organization:
      stringValue(organization?.name) ??
      stringValue(data.organization_name) ??
      stringValue(data.organizationName),
    identityStatus: "verified",
  };
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
      windowSeconds: SEVEN_DAYS_SECONDS,
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
      windowSeconds: FIVE_HOURS_SECONDS,
    });
  }
  if (group === "weekly") {
    return withRemaining({
      id: "seven_day",
      label: "week",
      kind: "weekly",
      percentUsed: clampPercent(percent),
      resetsAt,
      windowSeconds: SEVEN_DAYS_SECONDS,
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
  locations = resolveClaudeProfileLocations(),
): Promise<CredentialState[]> {
  const states: CredentialState[] = [];

  const fileState = extractCredentialState(
    readJsonFileResult(locations.credentialFile),
    "oauth-file",
    locations.credentialFile,
  );
  states.push(fileState);

  if (process.platform === "darwin") {
    if (options.allowKeychainPrompt || hasKeychainAccessMarker(locations)) {
      states.push(await readKeychainCredentialState(locations));
    } else {
      states.push(await readSkippedKeychainCredentialState(locations));
    }
  }

  return states;
}

async function readSkippedKeychainCredentialState(
  locations: ClaudeProfileLocations,
): Promise<CredentialState> {
  const presence = await readKeychainItemPresence(locations);
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

async function readKeychainItemPresence(
  locations: ClaudeProfileLocations,
): Promise<KeychainItemPresence> {
  try {
    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        locations.keychainAccount,
        "-s",
        locations.keychainService,
      ],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return "present";
  } catch (error) {
    return isKeychainItemNotFound(error) ? "missing" : "unknown";
  }
}

async function readKeychainCredentialState(
  locations: ClaudeProfileLocations,
): Promise<CredentialState> {
  let blob: string;
  try {
    blob = await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        locations.keychainAccount,
        "-w",
        "-s",
        locations.keychainService,
      ],
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    return keychainFailureState(error);
  }
  writeKeychainAccessMarkerBestEffort(locations);
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

function hasKeychainAccessMarker(locations: ClaudeProfileLocations): boolean {
  return existsSync(locations.keychainAccessMarker);
}

function writeKeychainAccessMarkerBestEffort(
  locations: ClaudeProfileLocations,
): void {
  try {
    const file = locations.keychainAccessMarker;
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "granted\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

export function claudeCredentialFile(): string {
  return resolveClaudeProfileLocations().credentialFile;
}

export function claudeKeychainService(): string {
  return resolveClaudeProfileLocations().keychainService;
}

export function claudeKeychainAccount(): string {
  let candidate = process.env.USER;
  if (!candidate) {
    try {
      candidate = userInfo().username;
    } catch {
      candidate = undefined;
    }
  }
  return candidate && SAFE_KEYCHAIN_ACCOUNT.test(candidate)
    ? candidate
    : DEFAULT_KEYCHAIN_ACCOUNT;
}

function resolveClaudeProfileLocations(): ClaudeProfileLocations {
  const configuredDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = (configuredDir ?? join(homedir(), ".claude")).normalize(
    "NFC",
  );
  const keychainConfigDir = configuredDir ? configDir : undefined;
  const keychainAccount = claudeKeychainAccount();
  return {
    credentialFile: join(configDir, ".credentials.json"),
    keychainAccount,
    keychainService: keychainServiceForConfigDir(keychainConfigDir),
    keychainAccessMarker: claudeKeychainAccessMarkerPath(
      keychainAccount,
      keychainConfigDir,
    ),
  };
}

function keychainServiceForConfigDir(configDir?: string): string {
  if (!configDir) return DEFAULT_KEYCHAIN_SERVICE;
  const suffix = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8);
  return `${DEFAULT_KEYCHAIN_SERVICE}-${suffix}`;
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
  const plan =
    stringValue(oauth.subscriptionType) ?? stringValue(data.subscriptionType);
  const credentials = { source, accessToken, plan, expiresAt };
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return {
      status: "expired",
      credentials,
      source: { source, path, status: "expired" },
    };
  }
  return {
    status: "available",
    credentials,
  };
}

async function fetchOauthUsage(
  credentials: Pick<ClaudeCredentials, "accessToken" | "plan">,
): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  identityError?: string;
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
    const identity = await fetchOauthProfile(credentials);
    return {
      ...quota,
      account: identity.account,
      identityError: identity.error,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOauthProfile(
  credentials: Pick<ClaudeCredentials, "accessToken">,
): Promise<ClaudeIdentityResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(PROFILE_API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return unverifiedClaudeIdentity(
        `identity_profile_http_${response.status}`,
      );
    }
    const account = normalizeClaudeProfile(await response.json());
    return account
      ? { account }
      : unverifiedClaudeIdentity("identity_profile_unrecognized");
  } catch (error) {
    return unverifiedClaudeIdentity(
      error instanceof Error && error.name === "AbortError"
        ? "identity_profile_timeout"
        : "identity_profile_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}

function unverifiedClaudeIdentity(error: string): ClaudeIdentityResult {
  return {
    account: { identityStatus: "unverified" },
    error,
  };
}

// Anthropic's OAuth usage endpoint follows plain HTTP semantics: 401/403 mean
// the access token no longer authenticates, and 429 means the caller must
// back off, honoring the standard `Retry-After` header (RFC 9110 - either a
// delay in seconds or an HTTP-date).
function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new ClaudeFailure("Claude sign-in required", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (response.status === 429) {
    throw new ClaudeFailure("Claude quota endpoint rate limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: retryAfterToIso(response.headers.get("retry-after")),
    });
  }
  if (!response.ok) {
    throw new ClaudeFailure(`Claude quota unavailable (${response.status})`, {
      staleEligible: true,
    });
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
  const windowSeconds = trustedClaudeWindowSeconds(id, kind);
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: clampPercent(used),
    resetsAt: stringValue(data.resets_at) ?? stringValue(data.reset_at),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  });
}

function trustedClaudeWindowSeconds(
  id: string,
  kind: QuotaWindow["kind"],
): number | undefined {
  if (id === "five_hour" || kind === "session") return FIVE_HOURS_SECONDS;
  if (
    id === "seven_day" ||
    id === "seven_day_opus" ||
    kind === "weekly" ||
    kind === "model"
  ) {
    return SEVEN_DAYS_SECONDS;
  }
  return undefined;
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

function classifyClaudeOverrideError(error: unknown): OverrideErrorVerdict {
  const failure = error instanceof ClaudeFailure ? error : undefined;
  if (failure?.definitiveAuth) return { kind: "rejected" };
  if (failure?.status === "rate_limited") {
    return {
      kind: "rate_limited",
      error: failure.code,
      retryAfter: failure.retryAfter,
    };
  }
  return { kind: "other", error: failure?.code ?? errorMessage(error) };
}

class ClaudeFailure extends Error {
  readonly status: ProviderStatus;
  readonly definitiveAuth: boolean;
  readonly staleEligible: boolean;
  readonly retryAfter: string | undefined;

  constructor(
    readonly code: string,
    options: ClaudeFailureOptions = {},
  ) {
    super(code);
    this.name = "ClaudeFailure";
    this.status = options.status ?? statusFromError(code);
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.staleEligible = options.staleEligible ?? false;
    this.retryAfter = options.retryAfter;
  }
}
