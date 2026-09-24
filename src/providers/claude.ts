import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { deleteCachedProvider, readCachedClaudeProvider } from "../cache.js";
import {
  claudeCredentialContextId,
  claudeKeychainAccessMarkerPath,
  ensurePrivateParent,
  readJsonFileResult,
  type JsonFileReadResult,
} from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_OAUTH_TOKEN_ENV,
  claudeEnvOauthToken,
  isOpaqueSuffixedKeychainService,
  claudeProfileLocations,
} from "../lib/claude-profile.js";
import { execFileText } from "../lib/process.js";
import { listRunningCommandLines } from "../lib/running-processes.js";
import { redactSecret } from "../lib/secret.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderAuthStatus,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  servableStaleWindows,
  sourceNames,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";
import {
  refreshDelegateAttempt,
  runRefreshDelegate,
  REFRESH_LIVE_VENDOR_PROCESS,
  REFRESH_VENDOR_UNKNOWN,
  type RefreshDelegate,
} from "./delegated-refresh.js";
import { withUsageFetchFailure } from "./usage-fetch-failure.js";
import { fetchClaudeNativeQuota } from "./claude-native-quota.js";
import { traceInput } from "../lib/input-trace.js";

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_API_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.202";
const API_TIMEOUT_MS = 15_000;
const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
/** `security` exit 44 is cannot-reach (locked, TCC, daemon), not item-absent. */
const KEYCHAIN_ITEM_UNREACHABLE_EXIT_CODE = 44;
const KEYCHAIN_UNREACHABLE_ERROR = "keychain_unreachable";
const DEFAULT_KEYCHAIN_ACCOUNT = "claude-code-user";
const SAFE_KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const FIVE_HOURS_SECONDS = 18_000;
const SEVEN_DAYS_SECONDS = 604_800;

type ClaudeCredentials = {
  source: "env" | "oauth-file" | "keychain";
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
  /**
   * Whether the same store holds a refresh token beside the expired access
   * token. Presence only: quota-axi never reads that value, and the Claude CLI
   * is the only thing that ever exchanges it.
   */
  refreshable: boolean;
};
type UnavailableCredentialState = {
  status: "missing" | "invalid";
  source: AuthSourceReport;
};
type SkippedCredentialState = {
  status: "skipped";
  source: AuthSourceReport;
  /** Overrides the attempt's derived degraded classification when set. */
  degraded?: boolean;
};
type CredentialState =
  | AvailableCredentialState
  | AdvisoryExpiredCredentialState
  | UnavailableCredentialState
  | SkippedCredentialState;
type KeychainItemPresence = "present" | "missing" | "unknown" | "unreachable";
type KeychainCandidate = {
  service: string;
  keychain: string;
};
type KeychainSelection =
  | { status: "present"; item: KeychainCandidate }
  | { status: "missing" | "unknown" };
type ClaudeAccount = NonNullable<ProviderQuota["account"]>;
type ClaudeIdentityResult = {
  account: ClaudeAccount;
  error?: string;
};
type ClaudeProfileLocations = {
  credentialFile?: string;
  keychainAccount: string;
  keychainService: string;
  acceptsOpaqueDefaultItem: boolean;
  keychainPath?: string;
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
  authUsable?: boolean;
  authStatus?: ProviderAuthStatus;
  envProfileScopeDenied?: boolean;
  windows?: QuotaWindow[];
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

/**
 * `claude doctor` is the smallest observed non-interactive Claude Code command
 * that makes the CLI renew its own expired OAuth session and rewrite whichever
 * store it owns (the macOS Keychain item, or `.credentials.json`). It prints an
 * installation health summary and exits: it starts no session, sends no model
 * request, spends no quota, opens no browser, and - unlike `claude mcp list` -
 * does not connect to configured MCP servers.
 *
 * Observed behavior that supports delegating to it: with the access token
 * expired it performs the refresh exchange, and a network failure during that
 * exchange leaves the stored session untouched. Only Anthropic definitively
 * rejecting the refresh token clears the session, which is Claude Code's own
 * handling of a session that has genuinely ended.
 *
 * That last property is exactly why the budget is generous and never enforced
 * with a signal: the run being delegated is a single-use refresh-token
 * exchange, so the dangerous outcome is not a slow `claude doctor` but a
 * half-finished one. quota-axi waits, then walks away (see
 * {@link runRefreshDelegate}).
 */
const CLAUDE_CLI_REFRESH_DELEGATE: RefreshDelegate = {
  source: "claude-cli-refresh",
  command: "claude",
  args: ["doctor"],
  waitBudgetMs: 45_000,
};

type ClaudeQuotaPass =
  | { kind: "success"; report: ProviderQuota }
  | {
      kind: "failure";
      failure: ClaudeFailure;
      /** The same expired, refreshable credential was definitively rejected. */
      refreshableExpiredRejected: boolean;
      /** A Keychain value read was withheld, so its store cannot be re-read. */
      keychainWithheld: boolean;
      /**
       * The reported failure is the environment token's own definitive
       * rejection, reached with no stored candidate ever tried. It must not
       * be treated as a verdict on, or invalidate the cache of, an unrelated
       * stored-profile account.
       */
      definitiveFailureIsEnvOnly: boolean;
    };

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  if (isProfileOnly(options)) return fetchProfileOnlyQuota();

  const attempts: SourceAttempt[] = [];
  const credentialContextId = claudeCredentialContextId();

  let pass = await attemptClaudeQuota(options, attempts);
  if (pass.kind === "success") return pass.report;

  // Soft expiry the Claude CLI can fix: hand the rotation to the CLI that owns
  // the credential store, then read back the session it rewrote.
  if (shouldDelegateClaudeRefresh(options, pass)) {
    const blocker = await liveClaudeRefreshBlocker();
    if (blocker) {
      attempts.push({
        source: CLAUDE_CLI_REFRESH_DELEGATE.source,
        status: "skipped",
        error: blocker,
      });
    } else {
      const run = await runRefreshDelegate(CLAUDE_CLI_REFRESH_DELEGATE);
      attempts.push(refreshDelegateAttempt(CLAUDE_CLI_REFRESH_DELEGATE, run));
      if (run.status === "ran") {
        const retry = await attemptClaudeQuota(options, attempts);
        if (retry.kind === "success") return retry.report;
        pass = retry;
      } else if (run.status === "unconfirmed") {
        pass = { ...pass, failure: unconfirmedRefreshFailure() };
      }
    }
  }

  // The env context id is presence-only (AGENTS.md), so it cannot distinguish
  // which account supplied the token. A stale cache read under it could hand
  // back a different account's snapshot, so an env-selected run never falls
  // back to stale cache.
  return failureReport(
    pass.failure,
    attempts,
    credentialContextId,
    claudeEnvOauthToken() !== undefined,
    pass.definitiveFailureIsEnvOnly,
  );
}

function isProfileOnly(options: ProviderOptions): boolean {
  return (
    (options as ProviderOptions & { credentialMode?: "profile-only" })
      .credentialMode === "profile-only"
  );
}

/**
 * The identity lookup is not a credential source, so its failure never marks
 * the source that answered as superseded; `account` already reports the
 * unverified identity.
 */
function oauthProfileAttempt(error?: string): SourceAttempt {
  return error
    ? { source: "oauth-profile", status: "failed", error, degraded: false }
    : { source: "oauth-profile", status: "success" };
}

/**
 * Read exactly the profile selected by CLAUDE_CONFIG_DIR. This path is kept
 * separate from normal discovery so profile isolation can never reach the
 * default home, Keychain, refresh delegate, or quota cache.
 */
async function fetchProfileOnlyQuota(): Promise<ProviderQuota> {
  const credentialFile = profileOnlyCredentialFile();
  if (!credentialFile) {
    return profileOnlyFailure(
      new ClaudeFailure("Claude profile selector missing", {
        status: "unavailable",
      }),
      [
        {
          source: "oauth-file",
          status: "skipped",
          error: "profile_selector_missing",
        },
      ],
    );
  }

  const raw = readJsonFileResult(credentialFile);
  if (raw.status === "missing") {
    return profileOnlyFailure(
      new ClaudeFailure("Claude profile credentials missing", {
        status: "unavailable",
      }),
      [
        {
          source: "oauth-file",
          status: "skipped",
          error: "credentials_missing",
        },
      ],
    );
  }
  if (raw.status === "invalid") {
    const reason =
      raw.error === "file_read_error" ? "file_read_error" : "json_parse_error";
    const error =
      reason === "file_read_error"
        ? "Claude credential file unreadable"
        : "Claude credential file malformed";
    return profileOnlyFailure(new ClaudeFailure(error, { status: "error" }), [
      {
        source: "oauth-file",
        status: "skipped",
        error: reason,
        credentialPresent: true,
      },
    ]);
  }

  const state = extractCredentialState(raw, "oauth-file", credentialFile);
  if (state.status === "invalid") {
    return profileOnlyFailure(
      new ClaudeFailure("Claude credential invalid", { status: "error" }),
      [
        {
          source: "oauth-file",
          status: "skipped",
          error: "credentials_invalid",
          credentialPresent: true,
        },
      ],
    );
  }
  if (!("credentials" in state)) {
    return profileOnlyFailure(
      new ClaudeFailure("Claude credential invalid", { status: "error" }),
      [
        {
          source: "oauth-file",
          status: "skipped",
          error: "credentials_invalid",
          credentialPresent: true,
        },
      ],
    );
  }

  const attempts: SourceAttempt[] = [
    { source: "oauth-file", status: "failed" },
  ];
  try {
    // Stored expiry is advisory here too: the selected bearer is always tested.
    const quota = await fetchOauthUsage(state.credentials);
    attempts[0] = { source: "oauth-file", status: "success" };
    attempts.push(oauthProfileAttempt(quota.identityError));
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
    const failure = profileOnlyClaudeFailureFor(
      error,
      state.credentials.accessToken,
    );
    attempts[0] = {
      source: "oauth-file",
      status: "failed",
      error: failure.code,
    };
    return profileOnlyFailure(failure, attempts);
  }
}

/**
 * Keep the real cause of a profile-only failure - a refused connection, a
 * malformed response - so a single-account probe stays diagnosable, with the
 * probed bearer stripped out of it.
 */
function profileOnlyClaudeFailureFor(
  error: unknown,
  accessToken: string,
): ClaudeFailure {
  if (error instanceof ClaudeFailure) return error;
  return new ClaudeFailure(redactSecret(errorMessage(error), accessToken), {
    status: "error",
  });
}

function profileOnlyCredentialFile(): string | undefined {
  const selector = process.env.CLAUDE_CONFIG_DIR;
  if (!selector || !selector.trim()) return undefined;
  return join(selector, ".credentials.json");
}

function profileOnlyFailure(
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
): ProviderQuota {
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

/**
 * Delegate only on soft expiry of a store quota-axi can read back: a stored
 * session that still carries a refresh token was definitively rejected. A
 * transient failure, a missing or malformed store, and a withheld Keychain
 * value all stay read-only - the last one keeps its existing Keychain advice,
 * because the CLI would rewrite a store quota-axi still could not read.
 */
function shouldDelegateClaudeRefresh(
  options: ProviderOptions,
  pass: Extract<ClaudeQuotaPass, { kind: "failure" }>,
): boolean {
  return (
    options.refreshCredentials &&
    pass.refreshableExpiredRejected &&
    !pass.keychainWithheld
  );
}

/**
 * A best-effort concurrency check on top of
 * {@link shouldDelegateClaudeRefresh}: quota-axi proceeds past this check only
 * when its process snapshot shows no Claude Code process already running.
 *
 * Claude Code owns its own session and refreshes it on its own schedule, and
 * the refresh token behind that session is single-use. A second refresher
 * racing a live session is how one holder ends up presenting a spent token, so
 * when the snapshot contains a live Claude Code process, quota-axi's
 * `claude doctor` is at best redundant and at worst the thing that signs the
 * user out. A quota reader loses nothing by standing down: the process that
 * owns the store is already doing the work, and the next read picks up the
 * session it wrote.
 *
 * Not knowing is treated the same as knowing a session is live, so an
 * unlistable process table (Windows, no effective uid, no `ps`) stays read-only
 * rather than guessing. The check and spawn are not atomic: a Claude Code
 * session starting after the check or another concurrent quota-axi read can
 * still overlap the delegate. This narrows the common repeated five-minute
 * `--tui` versus live-session collision and, together with never signaling the
 * delegate, is strictly safer than force-killing without adding a failure mode
 * beyond the pre-existing vendor-owned race. The skipped reason is recorded so
 * `--full` shows why no refresh happened.
 */
async function liveClaudeRefreshBlocker(): Promise<string | undefined> {
  const processes = await listRunningCommandLines();
  if (processes.status === "unavailable") return REFRESH_VENDOR_UNKNOWN;
  return processes.processes.some(
    ({ pid, commandLine }) =>
      pid !== process.pid && isLiveClaudeCodeProcess(commandLine),
  )
    ? REFRESH_LIVE_VENDOR_PROCESS
    : undefined;
}

/**
 * Recognize a running Claude Code process other than quota-axi itself from its
 * command line. The PID check in the caller is essential because quota-axi's
 * own argv may contain a standalone `claude` provider argument.
 *
 * Matches the installed `claude` executable (native installer or a versioned
 * shim) and the npm package running under a Node runtime. The executable is
 * argv[0], so a token whose basename is `claude` names it only in that
 * position: either the first token (a bare `claude` resolved on PATH) or a
 * later path fragment when an installation path contains a space and `ps`
 * splits it across tokens. A bare `claude` token inside another process's
 * arguments is ordinary prose, not a session, and must not stand the refresh
 * down.
 */
function isLiveClaudeCodeProcess(commandLine: string): boolean {
  const tokens = commandLine.split(/\s+/);
  if (
    tokens.some(
      (token, index) =>
        token.split("/").pop() === "claude" &&
        (index === 0 || token.includes("/")),
    )
  ) {
    return true;
  }
  return commandLine.includes("@anthropic-ai/claude-code/");
}

/**
 * A stored-expired session that still carries a refresh token and was rejected
 * is soft expiry, not a sign-out (Kimi and Grok report the same class): status
 * `unavailable`, `authStatus: expired_refreshable`, and the cache survives.
 * Only presence of the refresh token was inspected; rotation stays the Claude
 * CLI's.
 */
function refreshableExpiryFailure(): ClaudeFailure {
  return new ClaudeFailure("Claude access token expired", {
    status: "unavailable",
    staleEligible: true,
    authStatus: "expired_refreshable",
  });
}

/**
 * The vendor outran the wait and was left running, so quota-axi does not know
 * what the credential store now holds. It refuses to turn that into a sign-out
 * verdict: the report is an unmeasured provider (stale cache when one applies),
 * and the cached snapshot is kept rather than retired.
 */
function unconfirmedRefreshFailure(): ClaudeFailure {
  return new ClaudeFailure("claude_refresh_unconfirmed", {
    status: "unavailable",
    staleEligible: true,
  });
}

/**
 * Ask `/api/oauth/profile` whether a stored-expired bearer the usage endpoint
 * rate limited is genuinely dead. The probe is recorded like the success path's
 * identity lookup, so `--full` shows the evidence behind a reclassified
 * verdict.
 *
 * A profile 401 is not authoritative on its own, and nothing here treats it
 * that way: the identity lookup on the success path reports exactly the same
 * rejection as an unverified identity and keeps the live quota the usage
 * endpoint just returned. It carries weight only in combination with the
 * caller's own two signals - the usage endpoint rate limited this bearer, and
 * the store that holds it already recorded it as expired.
 *
 * @returns true only when the vendor explicitly rejected the bearer
 */
async function confirmClaudeStoredExpiry(
  credential: ClaudeCredentials,
  attempts: SourceAttempt[],
): Promise<boolean> {
  const identity = await fetchOauthProfile(credential);
  attempts.push(oauthProfileAttempt(identity.error));
  return identity.error === "identity_profile_http_401";
}

async function attemptClaudeQuota(
  options: ProviderOptions,
  attempts: SourceAttempt[],
): Promise<ClaudeQuotaPass> {
  const credentialStates = await readCredentialStates(options);
  const credentialCandidates = credentialStates
    .filter(
      (
        state,
      ): state is AvailableCredentialState | AdvisoryExpiredCredentialState =>
        state.status === "available" || state.status === "expired",
    )
    .sort((a, b) => {
      // The vendor resolves this token before any stored credential, so it names
      // the account a live session is actually using. Ordering it first keeps
      // quota-axi reading the same account rather than a bystander store.
      if (a.credentials.source === "env" && b.credentials.source !== "env")
        return -1;
      if (b.credentials.source === "env" && a.credentials.source !== "env")
        return 1;
      if (process.platform === "darwin") {
        if (
          a.credentials.source === "keychain" &&
          b.credentials.source !== "keychain"
        )
          return -1;
        if (
          b.credentials.source === "keychain" &&
          a.credentials.source !== "keychain"
        )
          return 1;
      }
      return (b.credentials.expiresAt ?? 0) - (a.credentials.expiresAt ?? 0);
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
      if (state.degraded !== undefined) attempt.degraded = state.degraded;
      attempts.push(attempt);
      continue;
    }
    attempts.push({
      source: state.source.source,
      status: "skipped",
      error: `credentials_${state.status}`,
      // A malformed store is not confirmed absent; retain its diagnostic
      // even when a sibling source answers.
      ...(state.status === "invalid" ? { credentialPresent: true } : {}),
    });
  }

  let definitiveFailure: ClaudeFailure | undefined;
  let definitiveFailureIsEnv = false;
  let transientFailure: ClaudeFailure | undefined;
  let transientFailureIsEnv = false;
  let confirmedExpiryFailure: ClaudeFailure | undefined;

  if (credentialCandidates.length > 0) {
    for (const state of credentialCandidates) {
      const credential = state.credentials;
      attempts.push({ source: credential.source, status: "failed" });
      try {
        const quota = await fetchOauthUsage(credential);
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "success",
        };
        attempts.push(oauthProfileAttempt(quota.identityError));
        return {
          kind: "success",
          report: successProvider({
            provider: "claude",
            label: "Claude",
            source: "oauth",
            plan: quota.plan,
            account: quota.account,
            windows: quota.windows,
            refreshedAt: quota.refreshedAt,
            sourcesTried: sourceNames(attempts),
            attempts,
          }),
        };
      } catch (error) {
        let failure = claudeFailureFor(error);
        const softRefreshable =
          failure.definitiveAuth &&
          state.status === "expired" &&
          state.refreshable;
        if (softRefreshable) failure = refreshableExpiryFailure();
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "failed",
          error: failure.code,
        };
        if (credential.source === "env" && failure.envProfileScopeDenied) {
          attempts[attempts.length - 1]!.degraded = false;
          if (options.allowClaudeInference) {
            attempts.push({
              source: "claude-native-inference",
              status: "failed",
            });
            const native = await fetchClaudeNativeQuota();
            if (native.kind === "success") {
              attempts[attempts.length - 1] = {
                source: "claude-native-inference",
                status: "success",
              };
              const report = successProvider({
                provider: "claude",
                label: "Claude",
                source: "cli",
                windows: native.windows,
                refreshedAt: native.refreshedAt,
                sourcesTried: sourceNames(attempts),
                attempts,
              });
              report.state.authStatus = "usable";
              return { kind: "success", report };
            }
            attempts[attempts.length - 1] = {
              source: "claude-native-inference",
              status: "failed",
              error: native.error,
              degraded: false,
            };
            transientFailure = new ClaudeFailure(native.error, {
              status: native.status,
              retryAfter: native.retryAfter,
              authUsable: true,
              windows: native.windows,
            });
          } else {
            transientFailure = failure;
          }
          transientFailureIsEnv = true;
          break;
        }
        if (softRefreshable || failure.definitiveAuth) {
          // A stored-expired session that still carries a refresh token is
          // rejected only because its access token lapsed; the vendor rotates
          // it, so it is not a sign-out and never retires the cache. Among
          // resolved rejections the highest-priority candidate's verdict
          // wins, whichever class it is: a bystander file must not speak for
          // the session the source order names first.
          if (!definitiveFailure) {
            definitiveFailure = failure;
            definitiveFailureIsEnv = credential.source === "env";
          }
          // The env token names the account a live session actually uses, so
          // its own definitive rejection is a verdict on that session: it must
          // stop here rather than reporting a bystander stored account as the
          // selected credential's result. A definitive failure from a stored
          // source still lets a remaining sibling stored source be tried,
          // matching the existing behavior for stored-only candidates.
          if (credential.source === "env") break;
        } else {
          // Stored expiry is advisory only - a stored-expired credential can
          // still be live vendor-side, so a 429 here might be a genuine rate
          // limit whose Retry-After should not be discarded. Confirm real
          // expiry against /api/oauth/profile, the same call the vendor
          // answers with an explicit "access token has expired" 401, before
          // reclassifying. Any other outcome (live, transient, or unclear)
          // leaves the original rate-limited failure untouched.
          const expiryConfirmed =
            state.status === "expired" &&
            failure.status === "rate_limited" &&
            (await confirmClaudeStoredExpiry(credential, attempts));
          if (expiryConfirmed) {
            if (!confirmedExpiryFailure && !definitiveFailure) {
              confirmedExpiryFailure = new ClaudeFailure(
                "Claude credential expired",
                {
                  status: "unavailable",
                  staleEligible: true,
                  ...(state.refreshable
                    ? { authStatus: "expired_refreshable" as const }
                    : {}),
                },
              ).withUsageFetchFailure();
              // A confirmed expiry replaces an earlier env transient, as it
              // did before source-priority tracking was added. Later sibling
              // confirmations must not replace this first resolved verdict.
              transientFailure = confirmedExpiryFailure;
              transientFailureIsEnv = credential.source === "env";
            }
          } else if (!expiryConfirmed) {
            transientFailure = failure.withUsageFetchFailure();
            transientFailureIsEnv = credential.source === "env";
          }
          // The env token is an independent source the vendor merely resolves
          // first; its non-definitive failure must not withhold a still-untried
          // stored source. An unresolved (transient) failure from a stored
          // source still stops the loop, matching the existing within-source
          // rule. A confirmed expiry is instead a resolved verdict on that one
          // source, so it hands over to a remaining sibling exactly as the
          // definitive branch above does - otherwise a live sibling would go
          // unread while quota-axi asserts the account's credential expired.
          if (!expiryConfirmed && credential.source !== "env") break;
        }
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

  const keychainFailure = credentialStates.find(
    (state): state is SkippedCredentialState =>
      state.status === "skipped" &&
      state.source.source === "keychain" &&
      [
        "keychain_access_denied",
        "keychain_prompt_required",
        "keychain_prompt_timeout",
        "keychain_presence_check_failed",
        KEYCHAIN_UNREACHABLE_ERROR,
      ].includes(state.source.error ?? ""),
  );
  // Stored-only candidates keep the established rule that an unresolved
  // (transient) sibling source must never be hidden behind an earlier
  // definitive verdict. The env token is the one narrowly scoped exception:
  // its own non-definitive failure must not mask a stored source's genuine
  // definitive rejection, since that stored verdict is still fully resolved.
  let failure =
    confirmedExpiryFailure ??
    (transientFailureIsEnv ? definitiveFailure : undefined) ??
    transientFailure ??
    definitiveFailure ??
    new ClaudeFailure("Claude quota unavailable", { staleEligible: true });
  // A failed Keychain discovery/read never saw the live session. A 401 from a leftover
  // oauth-file sidecar is not evidence the user is signed out of Claude.
  // A refreshable soft expiry from that sidecar is no better evidence.
  if (
    keychainFailure &&
    (failure.definitiveAuth || failure.authStatus === "expired_refreshable") &&
    !definitiveFailureIsEnv
  ) {
    failure = new ClaudeFailure(keychainFailure.source.error!, {
      staleEligible: true,
    });
  }

  return {
    kind: "failure",
    failure,
    refreshableExpiredRejected:
      failure === definitiveFailure &&
      failure.authStatus === "expired_refreshable",
    keychainWithheld: credentialStates.some(
      (state) =>
        state.status === "skipped" && state.source.source === "keychain",
    ),
    definitiveFailureIsEnvOnly:
      failure === definitiveFailure && definitiveFailureIsEnv,
  };
}

function failureReport(
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
  credentialContextId: string,
  envSelected: boolean,
  definitiveFailureIsEnvOnly: boolean,
): ProviderQuota {
  // The env token's own rejection describes only the env-selected session; it
  // never resolved a stored candidate, so it must not retire a cached snapshot
  // that belongs to an unrelated stored-profile account.
  if (failure.definitiveAuth && !definitiveFailureIsEnvOnly) {
    try {
      deleteCachedProvider("claude");
    } catch {
      // Current authentication remains definitive when cache I/O is blocked.
    }
  }

  if (failure.staleEligible && !envSelected) {
    try {
      const cached = readCachedClaudeProvider(credentialContextId);
      const stale = cached
        ? staleClaudeReport(cached, failure, attempts, Date.now())
        : undefined;
      if (stale) return stale;
    } catch {
      // Cache I/O cannot replace the current bounded provider failure.
    }
  }

  const observedWindows =
    failure.windows && failure.windows.length > 0 ? failure.windows : undefined;
  const report = failedProvider({
    provider: "claude",
    label: "Claude",
    status: failure.status,
    error: failure.code,
    retryAfter: failure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
    ...(observedWindows ? { source: "cli" } : {}),
  });
  if (failure.authUsable) report.state.authStatus = "usable";
  if (failure.authStatus) report.state.authStatus = failure.authStatus;
  if (observedWindows) report.windows = observedWindows;
  return report;
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

  const windows = servableStaleWindows(cached, now).filter((window) => {
    if (window.resetsAt && Number.isFinite(Date.parse(window.resetsAt))) {
      return true;
    }
    const maxAge = resetlessWindowMaxAge(window);
    return maxAge !== undefined && ageMilliseconds < maxAge;
  });
  if (windows.length === 0) return undefined;

  const report: ProviderQuota = {
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
  if (failure.authStatus) report.state.authStatus = failure.authStatus;
  return failure.usageFetchFailure ? withUsageFetchFailure(report) : report;
}

function resetlessWindowMaxAge(window: QuotaWindow): number | undefined {
  if (window.kind === "weekly" || window.kind === "model") {
    return SEVEN_DAYS_MS;
  }
  if (window.kind === "session" || window.kind === "monthly") {
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

/**
 * Resolve the explicitly supplied environment credential.
 *
 * Claude Code checks this variable before it opens any credential store, so a
 * token here is the account a live session is using and takes precedence over
 * anything discovery finds. It is an access token alone: it carries no
 * `expiresAt` to order it by and no refresh token, so it is never advisory-
 * expired and never eligible for the delegated refresh, and quota-axi never
 * writes it to a store or a cache.
 *
 * An absent, empty, or whitespace-only variable resolves to `undefined` and
 * reports nothing at all, leaving the stored-credential path exactly as it was.
 * A non-blank value that is still unusable as a literal bearer is a real
 * credential problem and is reported as such rather than silently dropped.
 *
 * @returns the credential state, or undefined when no token is supplied
 */
function readEnvCredentialState(): CredentialState | undefined {
  const accessToken = claudeEnvOauthToken();
  if (accessToken !== undefined)
    return { status: "available", credentials: { source: "env", accessToken } };
  // Blank is how an exported-but-unset variable reads, so it selects nothing
  // rather than standing in as a broken credential.
  if (process.env[CLAUDE_OAUTH_TOKEN_ENV]?.trim())
    return {
      status: "invalid",
      source: {
        source: "env",
        status: "invalid",
        credentialPresent: true,
      },
    };
  return undefined;
}

async function readCredentialStates(
  options: ProviderOptions,
  locations = resolveClaudeProfileLocations(),
): Promise<CredentialState[]> {
  const states: CredentialState[] = [];

  const envState = readEnvCredentialState();
  if (envState) states.push(envState);

  if (locations.credentialFile !== undefined)
    states.push(
      extractCredentialState(
        readJsonFileResult(locations.credentialFile),
        "oauth-file",
        locations.credentialFile,
      ),
    );

  if (process.platform === "darwin") {
    const selection = await listKeychainItem(locations);
    if (selection.status === "missing") {
      states.push(keychainPresenceState("missing"));
      return states;
    }
    // Inconclusive metadata never establishes sign-out. The exact vendor
    // service/account lookup still searches the whole Keychain search list.
    if (selection.status === "present")
      locations = withDiscoveredKeychainItem(locations, selection.item);
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
  const presence = locations.keychainPath
    ? "present"
    : await readKeychainItemPresence(locations);
  return keychainPresenceState(presence);
}

function keychainPresenceState(
  presence: KeychainItemPresence,
): CredentialState {
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
  // A store that could not be checked still stays visible behind a sibling
  // that answered, without claiming the item is there.
  return {
    status: "skipped",
    degraded: true,
    source: {
      source: "keychain",
      status: "skipped",
      error:
        presence === "unreachable"
          ? KEYCHAIN_UNREACHABLE_ERROR
          : "keychain_presence_check_failed",
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
    return isKeychainItemUnreachable(error) ? "unreachable" : "unknown";
  }
}

// Re-resolve metadata on each credential pass: a TUI must notice replaced
// items and changed search lists without retaining a stale service/path pin.
async function listKeychainItem(
  locations: ClaudeProfileLocations,
): Promise<KeychainSelection> {
  try {
    const output = await execFileText(
      "security",
      ["list-keychains"],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    const paths: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const path = /^\s*"(\/[^"\n]+)"\s*$/.exec(line)?.[1];
      if (!path) return { status: "unknown" };
      if (!paths.includes(path)) paths.push(path);
    }
    if (!paths.length) return { status: "unknown" };
    // Search the same keychains as an unqualified exact read. Metadata only:
    // no -d (values), -r (raw data), -a (ACLs), or -i (ACL editing). One bounded
    // dump (5s / 16 MiB) covers the list; failure withholds any absence verdict.
    const metadata = await execFileText(
      "security",
      ["dump-keychain", ...paths],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return selectKeychainItem(metadata, locations, paths);
  } catch {
    return { status: "unknown" };
  }
}

function selectKeychainItem(
  metadata: string,
  locations: ClaudeProfileLocations,
  paths: string[],
): KeychainSelection {
  let exactItem: KeychainCandidate | undefined;
  // Keyed by service: the same item can appear in several search-list
  // keychains, and only distinct services are distinct candidates.
  const opaqueItems = new Map<string, KeychainCandidate>();
  const seenKeychains = new Set<string>();
  let inconclusive = false;
  for (const record of metadata.split(/(?=^keychain: )/m)) {
    if (!record.trim()) continue;
    const keychain = keychainMetadataValue(
      /^keychain: (.+)$/m.exec(record)?.[1],
    );
    const kind = /^class: (.+)$/m.exec(record)?.[1];
    if (!keychain || !paths.includes(keychain) || !kind) {
      inconclusive = true;
      continue;
    }
    seenKeychains.add(keychain);
    if (kind !== '"genp"') continue;
    const service = keychainMetadataValue(
      /^\s+"svce"<blob>=(.+)$/m.exec(record)?.[1],
    );
    const itemAccount = keychainMetadataValue(
      /^\s+"acct"<blob>=(.+)$/m.exec(record)?.[1],
    );
    if (service === undefined || itemAccount === undefined) {
      inconclusive = true;
      continue;
    }
    // Another account name can own the live session's item, and an unfamiliar
    // Claude-prefixed item can belong to a profile this process did not
    // select. Never open those or use them to assert a sign-out.
    const claudeOwned = service.startsWith(CLAUDE_KEYCHAIN_SERVICE);
    if (itemAccount !== locations.keychainAccount) {
      if (claudeOwned) inconclusive = true;
      continue;
    }
    const opaque =
      locations.acceptsOpaqueDefaultItem &&
      isOpaqueSuffixedKeychainService(service);
    if (service !== locations.keychainService && !opaque) {
      if (claudeOwned) inconclusive = true;
      continue;
    }
    // Duplicates follow the vendor's lookup ordering, independent of dump order.
    const earlier = opaque ? opaqueItems.get(service) : exactItem;
    if (earlier && paths.indexOf(earlier.keychain) <= paths.indexOf(keychain))
      continue;
    if (opaque) opaqueItems.set(service, { service, keychain });
    else exactItem = { service, keychain };
  }
  // The exact selector always wins. Failing that, a default selection cannot
  // re-derive its own opaque suffix, so it accepts one only when a single
  // eligible item exists; several are indistinguishable and none is opened.
  if (exactItem) return { status: "present", item: exactItem };
  // Uniqueness, like absence, requires the whole search list: incomplete or
  // inconclusive metadata can hide the selected item or a competing profile.
  if (inconclusive || paths.some((path) => !seenKeychains.has(path)))
    return { status: "unknown" };
  if (opaqueItems.size === 1)
    return { status: "present", item: [...opaqueItems.values()][0]! };
  if (opaqueItems.size > 1) return { status: "unknown" };
  return { status: "missing" };
}

// security's print_buffer emits printable bytes in quotes, or hex followed by
// an optional ASCII annotation. Decode only the small metadata fields we use.
function keychainMetadataValue(raw?: string): string | undefined {
  if (!raw || raw.length > 8192) return undefined;
  if (raw === "<NULL>") return "";
  const hex = /^0x((?:[0-9a-fA-F]{2})+)(?:\s|$)/.exec(raw)?.[1];
  if (hex) return Buffer.from(hex, "hex").toString("utf8");
  return /^"(.*)"$/.exec(raw)?.[1];
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
        ...(locations.keychainPath ? [locations.keychainPath] : []),
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

function withDiscoveredKeychainItem(
  locations: ClaudeProfileLocations,
  item: KeychainCandidate,
): ClaudeProfileLocations {
  return {
    ...locations,
    keychainService: item.service,
    keychainPath: item.keychain,
    keychainAccessMarker: claudeKeychainAccessMarkerPath(
      locations.keychainAccount,
      item.service,
    ),
  };
}

function hasKeychainAccessMarker(locations: ClaudeProfileLocations): boolean {
  traceInput(locations.keychainAccessMarker);
  return existsSync(locations.keychainAccessMarker);
}

function writeKeychainAccessMarkerBestEffort(
  locations: ClaudeProfileLocations,
): void {
  try {
    const file = locations.keychainAccessMarker;
    if (existsSync(file)) return;
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

export function claudeCredentialFile(): string | undefined {
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
  const {
    configDir,
    secureStorageSelected,
    keychainService,
    acceptsOpaqueDefaultItem,
  } = claudeProfileLocations();
  const keychainAccount = claudeKeychainAccount();
  return {
    credentialFile:
      secureStorageSelected && process.platform === "darwin"
        ? undefined
        : join(configDir, ".credentials.json"),
    keychainAccount,
    keychainService,
    acceptsOpaqueDefaultItem,
    keychainAccessMarker: claudeKeychainAccessMarkerPath(
      keychainAccount,
      keychainService,
    ),
  };
}

function isKeychainItemUnreachable(error: unknown): boolean {
  return (
    (error as { code?: number | string | null }).code ===
    KEYCHAIN_ITEM_UNREACHABLE_EXIT_CODE
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
        credentialPresent: true,
      },
    };
  }
  if (isKeychainItemUnreachable(error)) {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: KEYCHAIN_UNREACHABLE_ERROR,
        credentialPresent: true,
      },
    };
  }
  return {
    status: "skipped",
    source: {
      source: "keychain",
      status: "skipped",
      error: "keychain_access_denied",
      credentialPresent: true,
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
      refreshable: hasRefreshToken(oauth),
    };
  }
  return {
    status: "available",
    credentials,
  };
}

/**
 * Presence check only. The value of a Claude refresh token never enters
 * quota-axi: Anthropic rotates it on use, so exchanging it here would spend the
 * Claude CLI's own single-use token and sign the user out of Claude Code.
 */
function hasRefreshToken(oauth: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(oauth, "refreshToken") ||
    Object.hasOwn(oauth, "refresh_token")
  );
}

async function fetchOauthUsage(credentials: ClaudeCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  identityError?: string;
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await providerFetch(API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    await rejectUnusableUsageResponse(response, credentials.source === "env");
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
  credentials: ClaudeCredentials,
): Promise<ClaudeIdentityResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await providerFetch(PROFILE_API_URL, {
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

// Anthropic's OAuth usage endpoint uses 401 for failed authentication. A 403
// can also be a network-policy or WAF denial, so it is not sufficient evidence
// for a sign-out verdict. 429 follows standard Retry-After semantics (RFC 9110).
async function rejectUnusableUsageResponse(
  response: Response,
  envSelected: boolean,
): Promise<void> {
  if (response.status === 401) {
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
  if (
    response.status === 403 &&
    envSelected &&
    (await isClaudeEnvProfileScopeDenial(response))
  ) {
    throw new ClaudeFailure("claude_env_usage_scope_unavailable", {
      status: "unavailable",
      authUsable: true,
      envProfileScopeDenied: true,
    });
  }
  if (!response.ok) {
    throw new ClaudeFailure(`Claude quota unavailable (${response.status})`, {
      staleEligible: true,
    });
  }
}

/**
 * Read a bounded 403 envelope and recognize only the exact `user:profile`
 * scope-denial shape established by the vendor response. Any other body -
 * another scope, a generic envelope, non-JSON, oversized, or one that never
 * completes - is simply not that denial. The body never leaves this function.
 */
export async function isClaudeEnvProfileScopeDenial(
  response: Response,
  options: { maxBytes?: number; deadlineMs?: number } = {},
): Promise<boolean> {
  const maxBytes = options.maxBytes ?? 16 * 1024;
  const deadlineMs = options.deadlineMs ?? 1_000;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return false;

  const body = await readBoundedResponseBody(response, maxBytes, deadlineMs);
  if (body === undefined) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const error = objectValue(objectValue(parsed)?.error);
  const message = stringValue(error?.message);
  return (
    stringValue(error?.type) === "permission_error" &&
    message !== undefined &&
    /^OAuth token does not meet scope requirement user:profile\.?$/i.test(
      message.trim(),
    )
  );
}

/** Resolves undefined when the body is oversized or does not complete in time. */
async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  deadlineMs: number,
): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<string | undefined> => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  };

  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
          void reader.cancel().catch(() => undefined);
        }, deadlineMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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

class ClaudeFailure extends Error {
  readonly status: ProviderStatus;
  readonly definitiveAuth: boolean;
  readonly staleEligible: boolean;
  readonly retryAfter: string | undefined;
  readonly authUsable: boolean;
  readonly authStatus: ProviderAuthStatus | undefined;
  readonly envProfileScopeDenied: boolean;
  readonly windows: QuotaWindow[] | undefined;
  usageFetchFailure = false;

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
    this.authUsable = options.authUsable ?? false;
    this.authStatus = options.authStatus;
    this.envProfileScopeDenied = options.envProfileScopeDenied ?? false;
    this.windows = options.windows;
  }

  withUsageFetchFailure(): this {
    this.usageFetchFailure = true;
    return this;
  }
}
