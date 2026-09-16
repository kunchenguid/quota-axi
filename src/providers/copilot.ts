import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import {
  clampPercent,
  nowIso,
  percentRemaining,
  retryAfterToIso,
} from "../lib/time.js";
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
} from "./common.js";
import {
  type AttemptOutcome,
  selectCredential,
} from "./credential-selection.js";
import {
  GH_CLI_CREDENTIAL_SOURCE,
  type GhCliCredentialResolution,
  resolveGhCliCredential,
} from "./gh-cli-credential.js";

const USER_URL = "https://api.github.com/copilot_internal/user";
const USER_HOST = new URL(USER_URL).hostname;
const API_TIMEOUT_MS = 15_000;

type CopilotCredentials = {
  oauthToken: string;
  login?: string;
};

const APPS_JSON_SOURCE = "apps-json";
const SIGN_IN_REQUIRED = "GitHub Copilot sign-in required";

/**
 * GitHub Copilot's credential stores in ownership-stability order. `apps.json`
 * is Copilot's own store and answers first exactly as it always has. The GitHub
 * CLI login belongs to a sibling tool, so it is consulted only after
 * `apps.json` cannot answer for a credential reason; a transport, decoding,
 * rate-limit, or server failure is about the request and stops the search.
 */
const COPILOT_SOURCE_ORDER = [
  APPS_JSON_SOURCE,
  GH_CLI_CREDENTIAL_SOURCE,
] as const;

type CopilotSource = (typeof COPILOT_SOURCE_ORDER)[number];

/**
 * One store's local reading, before any request. The unavailable states stay
 * distinct because they are different evidence: only `absent` says the store
 * holds no credential at all.
 */
type CopilotCredentialResolution =
  | {
      status: "resolved";
      credentials: CopilotCredentials;
      report: AuthSourceReport;
    }
  | {
      status: "absent" | "structurally_invalid" | "unsupported" | "read_error";
      report: AuthSourceReport;
    };

type UnavailableResolution = Exclude<
  CopilotCredentialResolution,
  { status: "resolved" }
>;

/** A request failure from any store; it is not a sign-out. */
type CopilotFailure = {
  error: string;
  retryAfter?: string;
};

type CredentialCandidate = {
  credentials: CopilotCredentials;
  host?: string;
};

export const copilotAdapter: ProviderAdapter = {
  id: "copilot",
  label: "GitHub Copilot",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let failure: CopilotFailure | undefined;

  for (const source of COPILOT_SOURCE_ORDER) {
    const resolution = await resolveCopilotCredential(source);
    if (resolution.status !== "resolved") {
      attempts.push(unavailableAttempt(source, resolution));
      continue;
    }

    // `apps.json` keeps its established `api` attempt name; a GitHub CLI fetch
    // is named for its store so `sourcesTried` shows which login answered.
    const attemptSource = source === APPS_JSON_SOURCE ? "api" : source;
    attempts.push({ source: attemptSource, status: "failed" });
    const selection = await selectCredential(
      [{ source, localState: "valid", credential: resolution.credentials }],
      async (
        candidate,
      ): Promise<
        AttemptOutcome<Awaited<ReturnType<typeof fetchCopilotUser>>>
      > => {
        try {
          return {
            kind: "quota",
            result: await fetchCopilotUser(candidate.credential),
          };
        } catch (error) {
          if (error instanceof CopilotAuthError) {
            return { kind: "rejected", error: error.message };
          }
          return {
            kind: "transient",
            error: errorMessage(error),
            retryAfter:
              error instanceof RateLimitError ? error.retryAfter : undefined,
          };
        }
      },
    );

    const quota = selection.result;
    if (selection.outcome === "quota" && quota) {
      attempts[attempts.length - 1] = {
        source: attemptSource,
        status: "success",
      };
      return successProvider({
        provider: "copilot",
        label: "GitHub Copilot",
        source: "api",
        plan: quota.plan,
        account: quota.account,
        windows: quota.windows,
        refreshedAt: quota.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }

    if (selection.outcome === "all_rejected") {
      attempts[attempts.length - 1] = {
        source: attemptSource,
        status: "failed",
        error: SIGN_IN_REQUIRED,
      };
      continue;
    }

    const error =
      selection.transientError ?? "GitHub Copilot quota unavailable";
    attempts[attempts.length - 1] = {
      source: attemptSource,
      status: "failed",
      error,
    };
    failure = { error, retryAfter: selection.retryAfter };
    break;
  }

  const verdict: CopilotFailure = failure ?? { error: SIGN_IN_REQUIRED };
  const cached = readCachedProvider("copilot");
  if (cached) {
    return staleFromCache(
      cached,
      verdict.error,
      sourceNames(attempts),
      attempts,
    );
  }

  return failedProvider({
    provider: "copilot",
    label: "GitHub Copilot",
    status: verdict.retryAfter
      ? "rate_limited"
      : statusFromError(verdict.error),
    error: verdict.error,
    retryAfter: verdict.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = [];
  for (const source of COPILOT_SOURCE_ORDER) {
    sources.push((await resolveCopilotCredential(source)).report);
  }
  return { provider: "copilot", sources };
}

async function resolveCopilotCredential(
  source: CopilotSource,
): Promise<CopilotCredentialResolution> {
  if (source === APPS_JSON_SOURCE) {
    const authFile = copilotAppsFile();
    return extractCredentialState(readJsonFileResult(authFile), authFile);
  }
  return fromGhCliResolution(await resolveGhCliCredential());
}

function fromGhCliResolution(
  resolution: GhCliCredentialResolution,
): CopilotCredentialResolution {
  const { path } = resolution;
  switch (resolution.status) {
    case "resolved":
      return {
        status: "resolved",
        credentials: { oauthToken: resolution.token },
        report: { source: GH_CLI_CREDENTIAL_SOURCE, path, status: "available" },
      };
    case "absent":
      return {
        status: "absent",
        report: { source: GH_CLI_CREDENTIAL_SOURCE, path, status: "missing" },
      };
    case "structurally_invalid":
      return {
        status: "structurally_invalid",
        report: {
          source: GH_CLI_CREDENTIAL_SOURCE,
          path,
          status: "invalid",
          error: "credentials_invalid",
          credentialPresent: true,
        },
      };
    case "unsupported":
      return {
        status: "unsupported",
        report: {
          source: GH_CLI_CREDENTIAL_SOURCE,
          path,
          status: "skipped",
          error: "credentials_keyring_storage",
          credentialPresent: true,
        },
      };
    case "read_error":
      return {
        status: "read_error",
        report: {
          source: GH_CLI_CREDENTIAL_SOURCE,
          path,
          status: "error",
          error: "file_read_error",
        },
      };
  }
}

function unavailableAttempt(
  source: CopilotSource,
  resolution: UnavailableResolution,
): SourceAttempt {
  if (resolution.status === "absent") {
    return { source, status: "skipped", error: "credentials_missing" };
  }
  if (resolution.status === "read_error") {
    // The store exists but could not be read, so presence is unknown either
    // way; it still did not answer, so it is named as degraded.
    return {
      source,
      status: "skipped",
      error:
        source === APPS_JSON_SOURCE
          ? "credentials_invalid"
          : "credentials_read_error",
      degraded: true,
    };
  }
  return {
    source,
    status: "skipped",
    error:
      source === GH_CLI_CREDENTIAL_SOURCE && resolution.status === "unsupported"
        ? "credentials_keyring_storage"
        : "credentials_invalid",
    credentialPresent: true,
  };
}

export function normalizeCopilotUser(raw: unknown):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      refreshedAt: string;
    }
  | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const windows = normalizeQuotaSnapshots(
    objectValue(data.quota_snapshots),
    data.quota_reset_date_utc,
  );
  const plan =
    stringValue(data.copilot_plan) ??
    stringValue(data.access_type_sku) ??
    stringValue(data.sku);
  const accountId = stringValue(data.login);
  if (windows.length === 0 && !plan && !accountId) return undefined;
  return {
    plan,
    account: accountId ? { accountId } : undefined,
    windows,
    refreshedAt: nowIso(),
  };
}

async function fetchCopilotUser(credentials: CopilotCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await providerFetch(USER_URL, {
      headers: {
        authorization: `Bearer ${credentials.oauthToken}`,
        accept: "application/json",
        "user-agent": "GitHubCopilotCLI/1.0",
      },
      signal: controller.signal,
    });
    rejectUnusableUsageResponse(response);
    const quota = normalizeCopilotUser(await response.json());
    if (!quota) throw new Error("GitHub Copilot quota unavailable");
    return quota;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeQuotaSnapshots(
  snapshots: Record<string, unknown> | undefined,
  resetFallback: unknown,
): QuotaWindow[] {
  if (!snapshots) return [];
  const windows: QuotaWindow[] = [];
  for (const [id, value] of Object.entries(snapshots)) {
    const item = objectValue(value);
    if (!item) continue;
    const remaining = numberValue(item.percent_remaining);
    if (remaining === undefined) continue;
    const percentUsed = clampPercent(100 - remaining);
    windows.push({
      id,
      label: id.replace(/_/g, " "),
      kind: "monthly",
      percentUsed,
      percentRemaining: percentRemaining(percentUsed),
      resetsAt:
        parseEpochSecondsOrMillis(item.quota_reset_at) ??
        parseEpochSecondsOrMillis(resetFallback),
    });
  }
  return windows;
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CopilotCredentialResolution {
  if (raw.status === "missing")
    return {
      status: "absent",
      report: { source: APPS_JSON_SOURCE, path, status: "missing" },
    };
  if (raw.status === "invalid")
    return {
      status:
        raw.error === "file_read_error" ? "read_error" : "structurally_invalid",
      report: {
        source: APPS_JSON_SOURCE,
        path,
        status: "invalid",
        error: raw.error,
      },
    };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "structurally_invalid",
      report: { source: APPS_JSON_SOURCE, path, status: "invalid" },
    };
  const candidates: CredentialCandidate[] = [];
  for (const [key, value] of Object.entries(data)) {
    const item = objectValue(value);
    const oauthToken = stringValue(item?.oauth_token);
    if (oauthToken) {
      candidates.push({
        credentials: { oauthToken, login: stringValue(item?.user) },
        host: credentialHost(key, item),
      });
    }
  }
  const selected =
    candidates.find(({ host }) => host && matchesUserEndpoint(host)) ??
    (candidates.some(({ host }) => host) ? undefined : candidates[0]);
  if (selected) {
    return {
      status: "resolved",
      credentials: selected.credentials,
      report: { source: APPS_JSON_SOURCE, path, status: "available" },
    };
  }
  return {
    // Tokens held only for hosts other than the public endpoint's are not
    // candidates here; a store with no token at all is equally unusable.
    status: candidates.length > 0 ? "unsupported" : "structurally_invalid",
    report: { source: APPS_JSON_SOURCE, path, status: "invalid" },
  };
}

function credentialHost(
  key: string,
  item: Record<string, unknown> | undefined,
): string | undefined {
  return (
    normalizeHost(stringValue(item?.host)) ??
    normalizeHost(stringValue(item?.hostname)) ??
    normalizeHost(stringValue(item?.github_host)) ??
    normalizeHost(stringValue(item?.githubHost)) ??
    normalizeHost(stringValue(item?.server_uri)) ??
    normalizeHost(stringValue(item?.serverUri)) ??
    normalizeHost(key)
  );
}

function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const host = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    ).hostname.toLowerCase();
    return host.includes(".") ? host : undefined;
  } catch {
    const host = trimmed
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      ?.split(":", 1)[0]
      ?.toLowerCase();
    return host && /^[a-z0-9.-]+$/.test(host) && host.includes(".")
      ? host
      : undefined;
  }
}

function matchesUserEndpoint(host: string): boolean {
  return (
    host === USER_HOST ||
    (USER_HOST === "api.github.com" && host === "github.com")
  );
}

function copilotAppsFile(): string {
  if (process.env.GITHUB_COPILOT_APPS_JSON)
    return process.env.GITHUB_COPILOT_APPS_JSON;
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "github-copilot",
      "apps.json",
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "github-copilot",
    "apps.json",
  );
}

function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 429 || response.status === 403) {
    const rateLimit = rateLimitSignal(response);
    if (response.status === 429 || rateLimit.limited) {
      throw new RateLimitError(rateLimit.retryAfter);
    }
  }
  if (response.status === 401 || response.status === 403) {
    throw new CopilotAuthError();
  }
  if (!response.ok)
    throw new Error(`GitHub Copilot quota unavailable (${response.status})`);
}

function rateLimitSignal(response: Response): {
  limited: boolean;
  retryAfter?: string;
} {
  const retryAfter = retryAfterToIso(response.headers.get("retry-after"));
  if (retryAfter) return { limited: true, retryAfter };
  const remaining = response.headers.get("x-ratelimit-remaining")?.trim();
  if (remaining === "0") {
    return {
      limited: true,
      retryAfter: parseEpochSecondsOrMillis(
        response.headers.get("x-ratelimit-reset"),
      ),
    };
  }
  return { limited: false };
}

function parseEpochSecondsOrMillis(value: unknown): string | undefined {
  const number = numberValue(value);
  if (number !== undefined) {
    return new Date(
      number > 10_000_000_000 ? number : number * 1000,
    ).toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parseEpochSecondsOrMillis(parsed);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "GitHub Copilot quota request timed out";
  return error instanceof Error
    ? error.message
    : "GitHub Copilot quota unavailable";
}

/** A first-party 401/403: the only probe outcome that is an auth verdict. */
class CopilotAuthError extends Error {
  constructor() {
    super(SIGN_IN_REQUIRED);
  }
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("GitHub Copilot quota endpoint rate limited");
  }
}
