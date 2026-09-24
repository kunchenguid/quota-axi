import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider, retireCachedSlot } from "../cache.js";
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
  staleUnlessSignOut,
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

import {
  COPILOT_CLI_KEYCHAIN_PROMPT_REQUIRED,
  COPILOT_CLI_SECURE_STORE_UNSUPPORTED,
  COPILOT_CLI_SOURCE,
  COPILOT_CLI_UNCONFIRMED_ACCOUNT,
  resolveCopilotCliCredential,
} from "./copilot-cli-credential.js";

const USER_URL = "https://api.github.com/copilot_internal/user";
const USER_HOST = new URL(USER_URL).hostname;
const API_TIMEOUT_MS = 15_000;

type CopilotCredentials = {
  oauthToken: string;
  login?: string;
};

const APPS_JSON_SOURCE = "apps-json";
const SIGN_IN_REQUIRED = "GitHub Copilot sign-in required";
const DECODE_FAILED = "GitHub Copilot quota response could not be decoded";

/**
 * GitHub Copilot's credential stores in ownership-stability order. `apps.json`
 * is Copilot's legacy store and answers first exactly as it always has. Its
 * native CLI secure-store source is next. The GitHub CLI login belongs to a sibling
 * tool and answers last. Handover is for credential problems only; transport, decoding,
 * rate-limit, or server failure is about the request and stops the search.
 */
const COPILOT_SOURCE_ORDER = [
  APPS_JSON_SOURCE,
  COPILOT_CLI_SOURCE,
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
      silent?: false;
    }
  | {
      status: "absent" | "structurally_invalid" | "unsupported" | "read_error";
      report: AuthSourceReport;
      silent?: boolean;
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
  // A GitHub CLI login is not evidence of Copilot access (see the source order
  // above), so a user with only `gh` reads as not set up rather than broken.
  incidentalSources: [GH_CLI_CREDENTIAL_SOURCE],
  // A native CLI configuration that cannot be confirmed, or an account whose
  // secure-store value still awaits consent, says nothing either way, so it
  // keeps Copilot in view with its remedy instead of reading as absent.
  isUncertainSkip: (attempt) =>
    attempt.error === COPILOT_CLI_UNCONFIRMED_ACCOUNT ||
    attempt.error === COPILOT_CLI_SECURE_STORE_UNSUPPORTED ||
    attempt.error === COPILOT_CLI_KEYCHAIN_PROMPT_REQUIRED,
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let failure: CopilotFailure | undefined;
  let unavailable: string | undefined;
  let nativeSilent = false;
  let nativeResolved = false;
  let nativePromptRequired = false;

  for (const source of COPILOT_SOURCE_ORDER) {
    const resolution = await resolveCopilotCredential(source, options);
    if (source === COPILOT_CLI_SOURCE) {
      nativeResolved = true;
      nativeSilent = resolution.silent ?? false;
      nativePromptRequired =
        resolution.report.error === "keychain_prompt_required";
    }
    if (resolution.status !== "resolved") {
      attempts.push(unavailableAttempt(source, resolution));
      // An item awaiting consent still names an account, so it speaks for the
      // verdict (unmeasured, not signed out) without counting as degraded.
      if (
        source === COPILOT_CLI_SOURCE &&
        (!resolution.silent ||
          resolution.report.error === "keychain_prompt_required")
      ) {
        unavailable ??= resolution.report.error ?? "credentials_unavailable";
      }
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
        source: source === COPILOT_CLI_SOURCE ? "cli" : "api",
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
        error:
          source === COPILOT_CLI_SOURCE
            ? "GitHub Copilot credential rejected or quota access denied"
            : SIGN_IN_REQUIRED,
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

  if (!nativeResolved) {
    const resolution = await resolveCopilotCredential(
      COPILOT_CLI_SOURCE,
      options,
      "silence",
    );
    nativeSilent = resolution.silent ?? false;
    nativePromptRequired =
      resolution.report.error === "keychain_prompt_required";
  }

  const diagnostic = unavailable;
  const verdict: CopilotFailure = failure ?? {
    error: diagnostic ?? SIGN_IN_REQUIRED,
  };
  // Native snapshots have no established revalidation contract across CLI
  // profile/account changes. Never serve them as stale, or substitute an older
  // legacy source snapshot for a present but unmeasurable native selection.
  const cached = readCachedProvider("copilot");
  const signOut = verdict.error === SIGN_IN_REQUIRED;
  const stale = staleUnlessSignOut(
    cached && cached.source !== "cli" && nativeSilent && !nativePromptRequired
      ? cached
      : undefined,
    verdict.error,
    sourceNames(attempts),
    attempts,
    {
      definitive: signOut,
      retire: () => retireCachedSlot("copilot"),
      incidentalSources: copilotAdapter.incidentalSources,
    },
  );
  if (stale) return stale;

  const result = failedProvider({
    provider: "copilot",
    label: "GitHub Copilot",
    status:
      !failure && diagnostic
        ? "unavailable"
        : verdict.retryAfter
          ? "rate_limited"
          : statusFromError(verdict.error),
    error: verdict.error,
    retryAfter: verdict.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  return nativePromptRequired ? withPromptRemedy(result) : result;
}

function withPromptRemedy(result: ProviderQuota): ProviderQuota {
  result.state.reason = "keychain_access_required";
  result.state.remedyCommand =
    "quota-axi --provider copilot --allow-keychain-prompt";
  return result;
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = [];
  for (const source of COPILOT_SOURCE_ORDER) {
    sources.push(
      (
        await resolveCopilotCredential(
          source,
          options,
          !options.allowKeychainPrompt,
        )
      ).report,
    );
  }
  return { provider: "copilot", sources };
}

async function resolveCopilotCredential(
  source: CopilotSource,
  options: ProviderOptions,
  presenceOnly: boolean | "silence" = false,
): Promise<CopilotCredentialResolution> {
  if (source === APPS_JSON_SOURCE) {
    const authFile = copilotAppsFile();
    return extractCredentialState(readJsonFileResult(authFile), authFile);
  }
  if (source === COPILOT_CLI_SOURCE) {
    const result = await resolveCopilotCliCredential(options, presenceOnly);
    return result.status === "resolved"
      ? {
          status: "resolved",
          credentials: { oauthToken: result.token },
          report: result.report,
          silent: result.silent,
        }
      : { ...result };
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
        silent: false,
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
  if (source === COPILOT_CLI_SOURCE) {
    // An unsupported selection or a consent gate is a structural non-answer
    // rather than a broken store; the resolver already withholds
    // `credentialPresent` where no account was selected at all.
    return {
      source,
      status: "skipped",
      error: resolution.report.error ?? "credentials_missing",
      ...(resolution.report.credentialPresent
        ? { credentialPresent: true }
        : {}),
      ...(resolution.silent || resolution.status === "unsupported"
        ? { degraded: false }
        : {}),
    };
  }
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
      redirect: "error",
      headers: {
        authorization: `Bearer ${credentials.oauthToken}`,
        accept: "application/json",
        "user-agent": "GitHubCopilotCLI/1.0",
      },
      signal: controller.signal,
    });
    rejectUnusableUsageResponse(response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // A decode failure's message quotes the response body; name the failure
      // instead of echoing whatever the endpoint returned.
      throw new Error(DECODE_FAILED);
    }
    const quota = normalizeCopilotUser(payload);
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
        parseSnapshotReset(item.quota_reset_at) ??
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

function parseSnapshotReset(value: unknown): string | undefined {
  const number = numberValue(value);
  if (number !== undefined && number <= 0) return undefined;
  return parseEpochSecondsOrMillis(value);
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
  if (error instanceof RateLimitError) return error.message;
  if (
    error instanceof Error &&
    (error.message === DECODE_FAILED ||
      /^GitHub Copilot quota unavailable(?: \(\d{3}\))?$/.test(error.message))
  )
    return error.message;
  const code = transportFailureCode(error);
  return code
    ? `GitHub Copilot quota request failed (${code})`
    : "GitHub Copilot quota request failed";
}

/**
 * A proxy, DNS, or TLS misconfiguration has to stay distinguishable from a
 * server hiccup, so the failure's own code travels; free-form messages, which
 * can quote a URL or a response body, do not.
 */
function transportFailureCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
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
