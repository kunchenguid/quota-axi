import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import {
  deleteCachedProvider,
  readCachedCodexProvider,
  readCachedProvider,
  stampCodexStoredAccountId,
} from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { findCommandPath, terminateChild } from "../lib/process.js";
import { redactSecret } from "../lib/secret.js";
import {
  clampPercent,
  nowIso,
  parseEpochOrIso,
  retryAfterToIso,
} from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAccount,
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
import {
  selectCredential,
  type AttemptOutcome,
  type CredentialCandidate,
  type CredentialSelection,
} from "./credential-selection.js";
import {
  createPiCodexCredentialBroker,
  PI_CODEX_BUILTIN_ID,
  piCodexSource,
  type PiCodexCredentialBroker,
  type PiCodexCredentialInspection,
  type PiCodexCredentialResolution,
} from "./pi-codex-credential.js";

const ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
];
const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 8_000;
const CODEX_BINARY_ENV = "QUOTA_AXI_CODEX_BINARY";
const PI_CODEX_CREDENTIAL_SOURCE = piCodexSource(PI_CODEX_BUILTIN_ID);

type CodexBinaryState =
  | { status: "available"; path: string }
  | { status: "missing"; path?: string; error?: string };

type CodexCredentials = {
  accessToken: string;
  accountId?: string;
};

type AvailableCredentialState = {
  status: "available";
  credentials: CodexCredentials;
  source: AuthSourceReport;
};
/**
 * Stored-expired, and still carrying its credentials so the bounded read-only
 * quota probe tests it in its source's declared position. The endpoint, not
 * the store's own field, decides the verdict.
 */
type AdvisoryExpiredCredentialState = {
  status: "expired";
  credentials: CodexCredentials;
  source: AuthSourceReport;
};
type UnavailableCredentialState = {
  status: "missing" | "invalid";
  source: AuthSourceReport;
};
type CredentialState =
  | AvailableCredentialState
  | AdvisoryExpiredCredentialState
  | UnavailableCredentialState;

/** Opaque attempt payload for the shared credential-selection loop. */
type CodexAttemptCredential = {
  source: ProviderQuota["source"];
  credentials: CodexCredentials;
};

type NormalizedCodexQuota = {
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
};

type RawWindow = {
  used_percent?: unknown;
  usedPercent?: unknown;
  reset_at?: unknown;
  resetsAt?: unknown;
  reset_after_seconds?: unknown;
  limit_window_seconds?: unknown;
  windowDurationMins?: unknown;
};

type CodexDependencies = {
  piCodexBroker: PiCodexCredentialBroker;
};

const defaultCodexDependencies: CodexDependencies = {
  piCodexBroker: createPiCodexCredentialBroker(),
};

export function createCodexAdapter(
  overrides: Partial<CodexDependencies> = {},
): ProviderAdapter {
  const dependencies: CodexDependencies = {
    ...defaultCodexDependencies,
    ...overrides,
  };
  return {
    id: "codex",
    label: "Codex",
    discoverAccounts: () => discoverCodexAccounts(dependencies),
    fetchQuota: (options) => fetchQuotaWithDependencies(dependencies, options),
    inspectAuth: (_options) => inspectAuthWithDependencies(dependencies),
  };
}

export const codexAdapter = createCodexAdapter();

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWithDependencies(defaultCodexDependencies, options);
}

const CODEX_HOME_ACCOUNT_KEY = "codex-home";

/**
 * `cacheKey` is the lane's cache slot and must be the key the collection will
 * publish: it stays absent on the legacy single-winner path and on a lone
 * discovered lane, both of which are cached under the provider's default slot.
 */
type CodexAccountContext =
  | {
      kind: "native";
      cacheKey?: string;
      includesBuiltinPi: boolean;
    }
  | {
      kind: "pi";
      piProviderId: string;
      cacheKey?: string;
      extraPiProviderIds?: string[];
    };

async function discoverCodexAccounts(
  dependencies: CodexDependencies,
): Promise<ProviderAccount[] | undefined> {
  const ids = await listPiCodexProviderIds(dependencies);
  if (
    ids.length === 0 ||
    (ids.length === 1 && ids[0] === PI_CODEX_BUILTIN_ID)
  ) {
    return undefined;
  }

  const nativeState = readCredentialState();
  const nativeStoredAccountId =
    nativeState.status === "available" || nativeState.status === "expired"
      ? nativeState.credentials.accountId
      : undefined;
  const nativeAccount: Extract<CodexAccountContext, { kind: "native" }> = {
    kind: "native",
    includesBuiltinPi: false,
  };
  const cliOnly =
    nativeState.status === "missing" &&
    (await resolveCodexBinary()).status === "available";
  const hasNativeLane = nativeState.status !== "missing" || cliOnly;

  const piLanes: {
    account: Extract<CodexAccountContext, { kind: "pi" }>;
    storedAccountId?: string;
    reading?: Promise<ProviderQuota>;
  }[] = [];
  const piLaneByAccountId = new Map<string, (typeof piLanes)[number]>();
  for (const piProviderId of ids) {
    const resolution = await resolvePiEntry(dependencies, piProviderId);
    const storedAccountId = resolvedAccountId(resolution);
    if (storedAccountId !== undefined) {
      if (
        nativeState.status !== "missing" &&
        piProviderId === PI_CODEX_BUILTIN_ID &&
        storedAccountId === nativeStoredAccountId
      ) {
        nativeAccount.includesBuiltinPi = true;
        continue;
      }
      const existing = piLaneByAccountId.get(storedAccountId);
      if (existing) {
        (existing.account.extraPiProviderIds ??= []).push(piProviderId);
        continue;
      }
    }
    const lane = {
      account: {
        kind: "pi" as const,
        piProviderId,
      },
      storedAccountId,
    };
    piLanes.push(lane);
    if (storedAccountId !== undefined) {
      piLaneByAccountId.set(storedAccountId, lane);
    }
  }

  if ((hasNativeLane ? 1 : 0) + piLanes.length > 1) {
    nativeAccount.cacheKey = CODEX_HOME_ACCOUNT_KEY;
    for (const lane of piLanes) {
      lane.account.cacheKey = lane.account.piProviderId;
    }
  }

  // Lanes are read once per collection and reconciled on the vendor account
  // id each reading reports, falling back to the stored one. A native login
  // for the same account as a Pi lane is not a second lane: the Pi lane owns
  // the account and shows the fresher of the two readings.
  let nativeReading: Promise<ProviderQuota | undefined> | undefined;
  const readNative = (options: ProviderOptions) =>
    (nativeReading ??= cliOnly
      ? fetchCliAccountQuota()
      : fetchQuotaWithDependencies(dependencies, options, nativeAccount));
  const readPi = (lane: (typeof piLanes)[number], options: ProviderOptions) =>
    (lane.reading ??= fetchQuotaWithDependencies(
      dependencies,
      options,
      lane.account,
    ));
  const accounts: ProviderAccount[] = [];
  if (hasNativeLane) {
    accounts.push({
      accountKey: CODEX_HOME_ACCOUNT_KEY,
      fetchQuota: async (options) => {
        const reading = await readNative(options);
        const accountId =
          reading && laneIdentity(reading, nativeStoredAccountId);
        if (!reading || !accountId) return reading;
        for (const lane of piLanes) {
          const piReading = await readPi(lane, options);
          if (laneIdentity(piReading, lane.storedAccountId) !== accountId) {
            continue;
          }
          if (
            reading.state.status === "fresh" ||
            piReading.state.status === "fresh"
          ) {
            retireCodexHomeSnapshot();
          }
          return undefined;
        }
        return reading;
      },
      inspectAuth: () =>
        inspectAuthWithDependencies(dependencies, nativeAccount),
    });
  }
  for (const lane of piLanes) {
    accounts.push({
      accountKey: lane.account.piProviderId,
      fetchQuota: async (options) => {
        const report = await readPi(lane, options);
        const accountId = laneIdentity(report, lane.storedAccountId);
        if (report.state.status === "fresh" || !hasNativeLane || !accountId) {
          return report;
        }
        const reading = await readNative(options);
        if (
          !reading ||
          laneIdentity(reading, nativeStoredAccountId) !== accountId ||
          !(
            reading.state.status === "fresh" ||
            (reading.state.stale && !report.state.stale)
          )
        ) {
          return report;
        }
        const attempts = [
          ...(report.attempts ?? []),
          ...(reading.attempts ?? []),
        ];
        return {
          ...reading,
          attempts,
          state: { ...reading.state, sourcesTried: sourceNames(attempts) },
        };
      },
      inspectAuth: () =>
        inspectAuthWithDependencies(dependencies, lane.account),
    });
  }
  return accounts.length > 0 ? accounts : undefined;
}

function laneIdentity(
  reading: ProviderQuota,
  storedAccountId: string | undefined,
): string | undefined {
  return reading.state.status === "fresh"
    ? (reading.account?.accountId ?? storedAccountId)
    : storedAccountId;
}

function retireCodexHomeSnapshot(): void {
  try {
    deleteCachedProvider("codex", CODEX_HOME_ACCOUNT_KEY);
  } catch {
    return;
  }
}

async function fetchCliAccountQuota(): Promise<ProviderQuota | undefined> {
  try {
    return codexSuccessReport(await probeCodexCli(), "cli-rpc", [
      { source: "cli-rpc", status: "success" },
    ]);
  } catch (error) {
    if (error instanceof CodexCliSignedOutError) {
      retireCodexHomeSnapshot();
      return undefined;
    }
    if (
      !(error instanceof CodexCliAccountReadingError) &&
      !readCachedProvider("codex", CODEX_HOME_ACCOUNT_KEY)
    ) {
      return undefined;
    }
    const message = errorMessage(error);
    return codexFailureReport(
      message,
      undefined,
      [{ source: "cli-rpc", status: "failed", error: message }],
      undefined,
      CODEX_HOME_ACCOUNT_KEY,
    );
  }
}

/** The account a Pi entry says it belongs to, as stored, when it names one. */
function resolvedAccountId(
  resolution: PiCodexCredentialResolution,
): string | undefined {
  return resolution.status === "available" || resolution.status === "expired"
    ? resolution.credentials?.accountId
    : undefined;
}

async function listPiCodexProviderIds(
  dependencies: CodexDependencies,
): Promise<string[]> {
  try {
    return await dependencies.piCodexBroker.listProviderIds();
  } catch {
    return [];
  }
}

async function resolvePiEntry(
  dependencies: CodexDependencies,
  providerId: string,
): Promise<PiCodexCredentialResolution> {
  try {
    return await dependencies.piCodexBroker.resolveEntry(providerId);
  } catch {
    return { status: "error" };
  }
}

async function inspectPiEntry(
  dependencies: CodexDependencies,
  providerId: string,
): Promise<PiCodexCredentialInspection> {
  try {
    return await dependencies.piCodexBroker.inspectEntry(providerId);
  } catch {
    return {
      path: "",
      status: "error",
      error: "credential_resolution_failed",
    };
  }
}

async function fetchPiAccountQuota(
  dependencies: CodexDependencies,
  account: Extract<CodexAccountContext, { kind: "pi" }>,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const piCandidates: CredentialCandidate<CodexAttemptCredential>[] = [];
  const storedAccountIds = new Map<string, string>();
  const providerIds = [
    account.piProviderId,
    ...(account.extraPiProviderIds ?? []),
  ];
  let lastResolution: PiCodexCredentialResolution | undefined;
  for (const piProviderId of providerIds) {
    const source = piCodexSource(piProviderId);
    const piResolution = await resolvePiEntry(dependencies, piProviderId);
    lastResolution = piResolution;
    const storedAccountId = resolvedAccountId(piResolution);
    if (storedAccountId) storedAccountIds.set(piProviderId, storedAccountId);
    if (piResolution.status === "available") {
      piCandidates.push({
        source,
        localState: "valid",
        credential: {
          source,
          credentials: piResolution.credentials,
        },
      });
    } else if (
      piResolution.status === "expired" &&
      piResolution.credentials !== undefined
    ) {
      piCandidates.push({
        source,
        localState: "expired",
        refreshable: piResolution.refreshable,
        credential: {
          source,
          credentials: piResolution.credentials,
        },
      });
    } else {
      attempts.push(piSourceAttempt(piResolution, source));
    }
  }

  const piSelection = await selectCredential(piCandidates, (candidate) =>
    attemptCodexCandidate(candidate.credential),
  );
  appendSelectionAttempts(attempts, piSelection);
  const answeringProviderId =
    providerIds.find(
      (id) => piCodexSource(id) === piSelection.winner?.source,
    ) ?? account.piProviderId;
  const source = piCodexSource(answeringProviderId);
  if (piSelection.outcome === "quota") {
    return codexSuccessReport(
      piSelection.result!,
      source,
      attempts,
      storedAccountIds.get(answeringProviderId),
    );
  }
  const piResolution = lastResolution;
  const finalError =
    piSelection.outcome === "transient"
      ? (piSelection.transientError ?? "Codex quota unavailable")
      : piSelection.outcome === "all_rejected"
        ? "Codex sign-in required"
        : piResolution?.status === "error"
          ? "Codex Pi credential resolution failed"
          : piResolution?.status === "expired"
            ? "Pi Codex access token expired"
            : piResolution?.status === "missing"
              ? "Codex quota unavailable"
              : "Codex sign-in required";
  return codexFailureReport(
    finalError,
    piSelection.outcome === "transient" ? piSelection.retryAfter : undefined,
    attempts,
    source,
    account.cacheKey,
    [...storedAccountIds.values()],
  );
}

async function fetchQuotaWithDependencies(
  dependencies: CodexDependencies,
  options: ProviderOptions,
  account?: CodexAccountContext,
): Promise<ProviderQuota> {
  if (isProfileOnly(options)) return fetchProfileOnlyQuota();
  if (account?.kind === "pi") return fetchPiAccountQuota(dependencies, account);

  const attempts: SourceAttempt[] = [];
  let finalError = "Codex quota unavailable";
  // False once a source has recorded a real failure. Sources are consulted in
  // priority order, so a lower-priority one may only name the failure while
  // this still holds: a native probe that timed out has already explained the
  // run, and letting an expired Pi entry restate it as an auth problem would
  // make statusFromError advise a sign-in for what is a network outage.
  let errorIsDefault = true;

  const credentialState = readCredentialState();
  // The accounts whose credentials this reading has tried. A failure may only
  // serve a cached snapshot stamped with one of them: a credential never tried
  // cannot vouch for windows filed under the slot this reading shares.
  const accountIds: string[] = [];
  // The native store answers both the `oauth` probe and the CLI fallback.
  let nativeAccountId: string | undefined;
  const oauthCandidates: CredentialCandidate<CodexAttemptCredential>[] = [];
  if (
    credentialState.status === "available" ||
    credentialState.status === "expired"
  ) {
    if (credentialState.credentials.accountId) {
      nativeAccountId = credentialState.credentials.accountId;
      accountIds.push(nativeAccountId);
    }
    oauthCandidates.push({
      source: "oauth",
      localState: credentialState.status === "available" ? "valid" : "expired",
      credential: { source: "oauth", credentials: credentialState.credentials },
    });
  } else {
    attempts.push({
      source: "oauth",
      status: "skipped",
      error: `credentials_${credentialState.status}`,
      // A malformed store still holds a credential, so a sibling source that
      // answers supersedes it rather than replacing it silently.
      ...(credentialState.status === "missing"
        ? {}
        : { credentialPresent: true }),
    });
    finalError = "Codex sign-in required";
    errorIsDefault = false;
  }

  const oauthSelection = await selectCredential(oauthCandidates, (candidate) =>
    attemptCodexCandidate(candidate.credential),
  );
  appendSelectionAttempts(attempts, oauthSelection);
  if (oauthSelection.outcome === "quota") {
    return codexSuccessReport(
      oauthSelection.result!,
      "oauth",
      attempts,
      nativeAccountId,
    );
  }
  if (oauthSelection.outcome === "transient") {
    // The request failed, not the credential, so a sibling credential is not
    // consulted: it would answer a question this run never got to ask.
    return codexFailureReport(
      oauthSelection.transientError ?? finalError,
      oauthSelection.retryAfter,
      attempts,
      "oauth",
      account?.cacheKey,
      accountIds,
    );
  }
  if (oauthSelection.outcome === "all_rejected") {
    finalError = "Codex sign-in required";
    errorIsDefault = false;
  }

  if (!account || account.includesBuiltinPi) {
    let piResolution: PiCodexCredentialResolution;
    try {
      piResolution = await dependencies.piCodexBroker.resolve();
    } catch {
      piResolution = { status: "error" };
    }
    // Only a resolution holding credentials names an account, and those
    // credentials are always tried below.
    const piAccountId = resolvedAccountId(piResolution);
    if (piAccountId) accountIds.push(piAccountId);
    const piCandidates: CredentialCandidate<CodexAttemptCredential>[] = [];
    if (piResolution.status === "available") {
      piCandidates.push({
        source: PI_CODEX_CREDENTIAL_SOURCE,
        localState: "valid",
        credential: {
          source: PI_CODEX_CREDENTIAL_SOURCE,
          credentials: piResolution.credentials,
        },
      });
    } else if (
      piResolution.status === "expired" &&
      piResolution.credentials !== undefined
    ) {
      piCandidates.push({
        source: PI_CODEX_CREDENTIAL_SOURCE,
        localState: "expired",
        refreshable: piResolution.refreshable,
        credential: {
          source: PI_CODEX_CREDENTIAL_SOURCE,
          credentials: piResolution.credentials,
        },
      });
    } else {
      attempts.push(piSourceAttempt(piResolution));
      if (
        piResolution.status === "error" &&
        (errorIsDefault || statusFromError(finalError) === "auth_required")
      ) {
        finalError = "Codex Pi credential resolution failed";
        errorIsDefault = false;
      } else if (errorIsDefault) {
        if (piResolution.status === "expired") {
          // Expired and unprobeable: the store held no token to test.
          finalError = "Pi Codex access token expired";
          errorIsDefault = false;
        } else if (piResolution.status !== "missing") {
          finalError = "Codex sign-in required";
          errorIsDefault = false;
        }
      }
    }

    const piSelection = await selectCredential(piCandidates, (candidate) =>
      attemptCodexCandidate(candidate.credential),
    );
    appendSelectionAttempts(attempts, piSelection);
    if (piSelection.outcome === "quota") {
      return codexSuccessReport(
        piSelection.result!,
        PI_CODEX_CREDENTIAL_SOURCE,
        attempts,
        piAccountId,
      );
    }
    if (piSelection.outcome === "transient") {
      // The Pi entry is this reading's source; a rejected native login is not.
      return codexFailureReport(
        piSelection.transientError ?? finalError,
        piSelection.retryAfter,
        attempts,
        PI_CODEX_CREDENTIAL_SOURCE,
        account?.cacheKey,
        piAccountId ? [piAccountId] : [],
      );
    }
    if (piSelection.outcome === "all_rejected") {
      if (errorIsDefault || statusFromError(finalError) === "auth_required") {
        finalError = "Codex sign-in required";
        errorIsDefault = false;
      }
    }
  }

  attempts.push({ source: "cli-rpc", status: "failed" });
  try {
    const quota = await probeCodexCli();
    attempts[attempts.length - 1] = { source: "cli-rpc", status: "success" };
    return codexSuccessReport(quota, "cli-rpc", attempts, nativeAccountId);
  } catch (error) {
    const message = errorMessage(error);
    attempts[attempts.length - 1] = {
      source: "cli-rpc",
      status: "failed",
      error: message,
    };
    if (errorIsDefault || !(error instanceof CodexCliUnavailableError)) {
      finalError = message;
    }
  }

  return codexFailureReport(
    finalError,
    undefined,
    attempts,
    undefined,
    account?.cacheKey,
    accountIds,
  );
}

/**
 * One bounded read-only probe of a single credential. The endpoint, not the
 * store's expiry field, decides: only a definitive rejection is an auth
 * verdict, and everything else is transport-class trouble that must not
 * trigger credential switching.
 */
async function attemptCodexCandidate(
  candidate: CodexAttemptCredential,
): Promise<AttemptOutcome<NormalizedCodexQuota>> {
  try {
    return {
      kind: "quota",
      result: await fetchOauthUsage(candidate.credentials),
    };
  } catch (error) {
    const message = credentialSafeErrorMessage(
      error,
      candidate.credentials.accessToken,
    );
    if (error instanceof RateLimitError) {
      return {
        kind: "transient",
        error: message,
        retryAfter: error.retryAfter,
      };
    }
    return error instanceof CodexAuthRejectedError
      ? { kind: "rejected", error: message }
      : { kind: "transient", error: message };
  }
}

/**
 * Record what each consulted credential did. A candidate the loop never
 * reached is deliberately left out: an unconsulted source is not a broken
 * one, and naming it would raise a `degraded_source` row for a store that
 * was simply not needed.
 */
function appendSelectionAttempts(
  attempts: SourceAttempt[],
  selection: CredentialSelection<NormalizedCodexQuota>,
): void {
  for (const result of selection.results) {
    if (result.outcome === "not_tried") continue;
    attempts.push(
      result.outcome === "quota"
        ? { source: result.source, status: "success" }
        : {
            source: result.source,
            status: "failed",
            ...(result.error ? { error: result.error } : {}),
          },
    );
  }
}

/**
 * `storedAccountId` is what the one credential that answered still stores, so a
 * later failed probe of that same store can recognize its own snapshot.
 */
function codexSuccessReport(
  quota: NormalizedCodexQuota,
  source: ProviderQuota["source"],
  attempts: SourceAttempt[],
  storedAccountId?: string,
): ProviderQuota {
  const report = successProvider({
    provider: "codex",
    label: "Codex",
    source,
    plan: quota.plan,
    account: quota.account,
    windows: quota.windows,
    credits: quota.credits,
    refreshedAt: quota.refreshedAt,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  stampCodexStoredAccountId(report, storedAccountId);
  return report;
}

/**
 * `accountIds` names the ChatGPT accounts the credentials this reading tried
 * still store, so a snapshot stamped for another stored identity is not served
 * back as this account's stale windows.
 */
function codexFailureReport(
  error: string,
  retryAfter: string | undefined,
  attempts: SourceAttempt[],
  source?: ProviderQuota["source"],
  accountKey?: string,
  accountIds: readonly string[] = [],
): ProviderQuota {
  const cached = readCachedCodexProvider(accountKey, accountIds);
  if (cached) {
    return staleFromCache(cached, error, sourceNames(attempts), attempts);
  }
  return failedProvider({
    provider: "codex",
    label: "Codex",
    ...(source ? { source } : {}),
    status: retryAfter ? "rate_limited" : statusFromError(error),
    error,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return inspectAuthWithDependencies(defaultCodexDependencies);
}

async function inspectAuthWithDependencies(
  dependencies: CodexDependencies,
  account?: CodexAccountContext,
): Promise<AuthProviderReport> {
  if (account?.kind === "pi") {
    let piSource: AuthSourceReport;
    try {
      piSource = piInspectionSource(
        await inspectPiEntry(dependencies, account.piProviderId),
        piCodexSource(account.piProviderId),
      );
    } catch {
      piSource = {
        source: piCodexSource(account.piProviderId),
        status: "error",
        error: "credential_resolution_failed",
      };
    }
    const sources = [piSource];
    for (const extraId of account.extraPiProviderIds ?? []) {
      try {
        sources.push(
          piInspectionSource(
            await inspectPiEntry(dependencies, extraId),
            piCodexSource(extraId),
          ),
        );
      } catch {
        sources.push({
          source: piCodexSource(extraId),
          status: "error",
          error: "credential_resolution_failed",
        });
      }
    }
    return {
      provider: "codex",
      sources,
    };
  }
  const authFile = codexAuthFile();
  const credentialState = readCredentialState(authFile);
  const sources: AuthSourceReport[] = [credentialState.source];
  if (!account || account.includesBuiltinPi) {
    try {
      sources.push(
        piInspectionSource(await dependencies.piCodexBroker.inspect()),
      );
    } catch {
      sources.push({
        source: PI_CODEX_CREDENTIAL_SOURCE,
        status: "error",
        error: "credential_resolution_failed",
      });
    }
  }
  const binary = await resolveCodexBinary();
  return {
    provider: "codex",
    sources: [
      ...sources,
      {
        source: "cli-rpc",
        path: binary.path,
        status: binary.status,
        error: binary.status === "missing" ? binary.error : undefined,
      },
    ],
  };
}

function piSourceAttempt(
  resolution: Exclude<PiCodexCredentialResolution, { status: "available" }>,
  source: ProviderQuota["source"] = PI_CODEX_CREDENTIAL_SOURCE,
): SourceAttempt {
  if (resolution.status === "error") {
    return {
      source,
      status: "failed",
      error: "credential_resolution_failed",
      credentialPresent: true,
    };
  }
  if (resolution.status === "expired") {
    return {
      source,
      status: "skipped",
      error: resolution.refreshable
        ? "credentials_expired_refreshable"
        : "credentials_expired",
      credentialPresent: true,
    };
  }
  const error =
    resolution.status === "missing"
      ? "credentials_missing"
      : resolution.status === "unsupported"
        ? "unsupported_credential_type"
        : "credentials_invalid";
  return {
    source,
    status: "skipped",
    error,
    ...(resolution.status === "missing" ? {} : { credentialPresent: true }),
  };
}

function piInspectionSource(
  inspection: PiCodexCredentialInspection,
  source: string = PI_CODEX_CREDENTIAL_SOURCE,
): AuthSourceReport {
  const status: AuthSourceReport["status"] =
    inspection.status === "available" ||
    inspection.status === "missing" ||
    inspection.status === "expired" ||
    inspection.status === "error"
      ? inspection.status
      : "invalid";
  return {
    source,
    path: inspection.path,
    status,
    ...(inspection.error ? { error: inspection.error } : {}),
  };
}

export function normalizeCodexUsage(raw: unknown):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  // Both the direct ChatGPT backend calls and the codex app-server RPC
  // describe the same rate-limit concepts, but the RPC surface uses
  // camelCase field names while the HTTP backend uses snake_case; both
  // forms are tolerated wherever they appear below.
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const rateLimit = resolveRateLimitContainer(data);

  const windows = deduplicateWindowIds([
    ...windowPairFromContainer(
      rateLimit,
      "five_hour",
      "session",
      "session",
      "weekly",
      "week",
      "weekly",
    ),
    ...windowPairFromContainer(
      objectValue(data.code_review_rate_limit),
      "code_review_five_hour",
      "code review session",
      "session",
      "code_review_weekly",
      "code review week",
      "weekly",
    ),
    ...collectNamedRateLimitWindows(data),
  ]);

  if (windows.length === 0) return undefined;

  return {
    plan: stringValue(data.plan_type) ?? stringValue(data.planType),
    account: {
      email: stringValue(data.email),
      accountId: stringValue(data.account_id) ?? stringValue(data.accountId),
    },
    windows,
    credits: normalizeCredits(data.credits ?? rateLimit?.credits),
    refreshedAt: nowIso(),
  };
}

function resolveRateLimitContainer(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    objectValue(data.rate_limit) ??
    objectValue(data.rateLimits) ??
    objectValue(data.rate_limits) ??
    data
  );
}

type WindowIdentity = Pick<QuotaWindow, "id" | "label" | "kind">;

type WindowIdentitySet = {
  session: WindowIdentity;
  weekly: WindowIdentity;
  unfamiliar(windowSeconds: number): WindowIdentity;
};

function windowPairFromContainer(
  container: Record<string, unknown> | undefined,
  primaryId: string,
  primaryLabel: string,
  primaryKind: QuotaWindow["kind"],
  secondaryId: string,
  secondaryLabel: string,
  secondaryKind: QuotaWindow["kind"],
): QuotaWindow[] {
  if (!container) return [];
  const identities: WindowIdentitySet = {
    session: { id: primaryId, label: primaryLabel, kind: primaryKind },
    weekly: { id: secondaryId, label: secondaryLabel, kind: secondaryKind },
    unfamiliar(windowSeconds) {
      const duration = readableWindowDuration(windowSeconds);
      const prefix =
        primaryId === "five_hour" ? "window" : "code_review_window";
      return {
        id: `${prefix}:${duration}`,
        label: `${duration} window`,
        kind: "unknown",
      };
    },
  };
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      identities.session,
      identities,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      identities.weekly,
      identities,
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

// Beyond the base rate limit, both API shapes can carry extra limits scoped
// to a specific model or feature (e.g. a preview model with its own budget):
// the HTTP backend lists them under `additional_rate_limits`, keyed by
// `metered_feature`/`limit_name`; the app-server RPC exposes an equivalent
// `rateLimitsByLimitId` map keyed by limit id, where only the named entries
// are extras (the unnamed one duplicates the base limit already parsed above).
function collectNamedRateLimitWindows(
  data: Record<string, unknown>,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  const additional = Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits
    : [];
  for (const entry of additional) {
    const item = objectValue(entry);
    if (!item) continue;
    const id =
      stringValue(item.metered_feature) ?? stringValue(item.limit_name);
    const label = stringValue(item.limit_name) ?? id;
    const container = objectValue(item.rate_limit);
    if (!id || !label || !container) continue;
    windows.push(...namedLimitWindows(id, label, container));
  }

  const byLimitId = objectValue(data.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [limitId, value] of Object.entries(byLimitId)) {
      const item = objectValue(value);
      if (!item) continue;
      const label = stringValue(item.limitName) ?? stringValue(item.limit_name);
      if (!label) continue;
      windows.push(...namedLimitWindows(limitId, label, item));
    }
  }

  return windows;
}

function namedLimitWindows(
  id: string,
  label: string,
  container: Record<string, unknown>,
): QuotaWindow[] {
  const identities: WindowIdentitySet = {
    session: {
      id: `model:${id}:5h`,
      label: `${label} session`,
      kind: "model",
    },
    weekly: {
      id: `model:${id}:7d`,
      label: `${label} week`,
      kind: "model",
    },
    unfamiliar(windowSeconds) {
      const duration = readableWindowDuration(windowSeconds);
      return {
        id: `model:${id}:window:${duration}`,
        label: `${label} ${duration} window`,
        kind: "model",
      };
    },
  };
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      identities.session,
      identities,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      identities.weekly,
      identities,
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

function deduplicateWindowIds(windows: QuotaWindow[]): QuotaWindow[] {
  const counts = new Map<string, number>();
  return windows.map((window) => {
    const count = (counts.get(window.id) ?? 0) + 1;
    counts.set(window.id, count);
    return count === 1 ? window : { ...window, id: `${window.id}_${count}` };
  });
}

export function mergeAccountAndLimits(
  account: unknown,
  limits: unknown,
): Record<string, unknown> {
  const accountData = objectValue(account) ?? {};
  const accountRecord = objectValue(accountData.account) ?? accountData;
  const limitData = objectValue(limits) ?? {};
  return {
    ...limitData,
    email: accountRecord.email ?? limitData.email,
    account_id:
      accountRecord.account_id ??
      accountRecord.accountId ??
      limitData.account_id,
    plan_type:
      accountRecord.plan_type ?? accountRecord.planType ?? limitData.plan_type,
  };
}

function codexAuthFile(): string {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

function isProfileOnly(options: ProviderOptions): boolean {
  return options.credentialMode === "profile-only";
}

/**
 * Profile-only is deliberately stricter than normal Codex discovery: the
 * caller must select a home explicitly, and only that home's auth file is
 * eligible to answer.
 */
function selectedProfileAuthFile(): string | undefined {
  const selector = process.env.CODEX_HOME;
  return selector?.trim() ? join(selector, "auth.json") : undefined;
}

async function fetchProfileOnlyQuota(): Promise<ProviderQuota> {
  const selected = selectedProfileAuthFile();
  if (!selected) {
    return profileOnlyFailure("Codex profile selector missing", "unavailable", [
      {
        source: "oauth",
        status: "skipped",
        error: "profile_selector_missing",
      },
    ]);
  }

  const credentialState = readCredentialState(selected);
  if (
    credentialState.status !== "available" &&
    credentialState.status !== "expired"
  ) {
    const reason =
      credentialState.status === "missing"
        ? "credentials_missing"
        : (credentialState.source.error ?? "credentials_invalid");
    return profileOnlyFailure(
      profileOnlyCredentialError(reason),
      credentialState.status === "missing" ? "unavailable" : "error",
      [
        {
          source: "oauth",
          status: "skipped",
          error: reason,
          ...(credentialState.status === "invalid"
            ? { credentialPresent: true }
            : {}),
        },
      ],
    );
  }

  const attempt = await attemptCodexCandidate({
    source: "oauth",
    credentials: credentialState.credentials,
  });
  if (attempt.kind === "quota") {
    return codexSuccessReport(
      attempt.result,
      "oauth",
      [{ source: "oauth", status: "success" }],
      credentialState.credentials.accountId,
    );
  }

  const error =
    attempt.kind === "live_no_quota"
      ? "Codex quota unavailable"
      : attempt.error;
  return profileOnlyFailure(
    error,
    attempt.kind === "rejected"
      ? "auth_required"
      : attempt.kind === "transient" && attempt.retryAfter
        ? "rate_limited"
        : "error",
    [{ source: "oauth", status: "failed", error }],
    attempt.kind === "transient" ? attempt.retryAfter : undefined,
  );
}

/**
 * Keep `state.error` a sentence like every other Codex failure, and leave the
 * stable reason code on the attempt.
 */
function profileOnlyCredentialError(reason: string): string {
  if (reason === "credentials_missing")
    return "Codex profile credentials missing";
  if (reason === "file_read_error") return "Codex credential file unreadable";
  if (reason === "json_parse_error") return "Codex credential file malformed";
  return "Codex credential invalid";
}

function profileOnlyFailure(
  error: string,
  status: ProviderQuota["state"]["status"],
  attempts: SourceAttempt[],
  retryAfter?: string,
): ProviderQuota {
  return failedProvider({
    provider: "codex",
    label: "Codex",
    status,
    error,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

function readCredentialState(authFile = codexAuthFile()): CredentialState {
  return extractCredentialState(readJsonFileResult(authFile), authFile);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: { source: "auth-json", path, status: "missing" },
    };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: {
        source: "auth-json",
        path,
        status: "invalid",
        error: raw.error,
      },
    };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };
  const tokens = objectValue(data.tokens);
  if (!tokens)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };
  const accessToken =
    stringValue(tokens.access_token) ?? stringValue(tokens.accessToken);
  if (!accessToken)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };

  // Access-token usability is authoritative for bearer API access. Identity
  // token expiry alone is diagnostic metadata and must not skip OAuth.
  const idToken = stringValue(tokens.id_token) ?? stringValue(tokens.idToken);
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = decodeJwtPayload(accessToken);
  const decoded = idPayload ?? accessPayload;
  const accountId =
    stringValue(tokens.account_id) ??
    stringValue(tokens.accountId) ??
    stringValue(decoded?.["https://api.openai.com/auth/account_id"]) ??
    stringValue(decoded?.account_id);
  const credentials: CodexCredentials = { accessToken, accountId };
  // Stored expiry is liveness metadata only. The credential is still probed
  // in its source's declared position, and only the endpoint decides.
  if (isExpiredJwtPayload(accessPayload)) {
    return {
      status: "expired",
      credentials,
      source: { source: "auth-json", path, status: "expired" },
    };
  }
  return {
    status: "available",
    credentials,
    source: { source: "auth-json", path, status: "available" },
  };
}

async function fetchOauthUsage(credentials: CodexCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  let rejected = false;
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${credentials.accessToken}`,
        accept: "application/json",
      };
      if (credentials.accountId)
        headers["ChatGPT-Account-Id"] = credentials.accountId;
      const response = await providerFetch(endpoint, {
        headers,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        rejected = true;
        continue;
      }
      if (response.status === 429)
        throw new RateLimitError(
          retryAfterToIso(response.headers.get("retry-after")),
        );
      if (!response.ok) {
        lastError = new Error("Codex quota unavailable");
        continue;
      }
      const quota = normalizeCodexUsage(await response.json());
      if (quota) return quota;
      lastError = new Error("Codex quota unavailable");
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError) throw lastError;
  if (rejected) throw new CodexAuthRejectedError("Codex sign-in required");
  throw new Error("Codex quota unavailable");
}

async function probeCodexCli(): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  const binary = await resolveCodexBinary();
  if (binary.status === "missing") {
    throw new CodexCliUnavailableError(codexBinaryErrorMessage(binary));
  }
  const child = spawn(
    binary.path,
    ["-s", "read-only", "-a", "never", "app-server"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    },
  );

  let nextId = 1;
  let buffer = "";
  let fatalError: Error | undefined;
  const responses = new Map<number, unknown>();
  const waiters = new Map<
    number,
    {
      timer: NodeJS.Timeout;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  const failAll = (error: Error) => {
    if (fatalError) return;
    fatalError = error;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };

  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.on("error", () => failAll(new Error("Codex quota unavailable")));
  child.on("close", () => failAll(new Error("Codex quota unavailable")));

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as {
          id?: unknown;
          result?: unknown;
          params?: unknown;
          error?: unknown;
        };
        if (typeof message.id !== "number") continue;
        const value = message.error ?? message.result ?? message.params;
        const waiter = waiters.get(message.id);
        if (waiter) {
          waiters.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        } else {
          responses.set(message.id, value);
        }
      } catch {
        // Ignore non-JSON startup output.
      }
    }
  });

  const waitFor = (id: number, timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      if (responses.has(id)) {
        resolve(responses.get(id));
        return;
      }
      if (fatalError) {
        reject(fatalError);
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error("Codex quota unavailable"));
      }, timeoutMs);
      waiters.set(id, { timer, resolve, reject });
    });

  try {
    const initId = nextId++;
    sendRpc(child, initId, "initialize", {
      clientInfo: { name: "quota-axi", version: "1" },
    });
    await waitFor(initId, CLI_TIMEOUT_MS);

    const accountId = nextId++;
    sendRpc(child, accountId, "account/read");
    const account = await waitFor(accountId, RPC_TIMEOUT_MS).catch(
      () => undefined,
    );
    if (isSignedOutAccountRead(account)) {
      throw new CodexCliSignedOutError("Codex quota unavailable");
    }

    const limitsId = nextId++;
    sendRpc(child, limitsId, "account/rateLimits/read");
    const limits = await waitFor(limitsId, RPC_TIMEOUT_MS).catch((error) => {
      throw isChatgptAccountRead(account)
        ? new CodexCliAccountReadingError(errorMessage(error))
        : error;
    });
    const quota = normalizeCodexUsage(mergeAccountAndLimits(account, limits));
    if (!quota) {
      throw isChatgptAccountRead(account)
        ? new CodexCliAccountReadingError("Codex quota unavailable")
        : new Error("Codex quota unavailable");
    }
    return quota;
  } finally {
    terminateChild(child);
  }
}

async function resolveCodexBinary(): Promise<CodexBinaryState> {
  const configured = process.env[CODEX_BINARY_ENV];
  if (configured !== undefined) {
    const path = configured.trim();
    if (!path || !isAbsolute(path)) {
      return {
        status: "missing",
        error: "codex_binary_override_not_absolute",
      };
    }
    const executable = await findCommandPath(path);
    if (!executable) {
      return {
        status: "missing",
        path,
        error: "codex_binary_override_not_executable",
      };
    }
    return { status: "available", path: executable };
  }

  const executable = await findCommandPath("codex");
  return executable
    ? { status: "available", path: executable }
    : { status: "missing" };
}

function codexBinaryErrorMessage(
  binary: Extract<CodexBinaryState, { status: "missing" }>,
): string {
  if (binary.error === "codex_binary_override_not_absolute") {
    return "Configured Codex binary must be an absolute executable path";
  }
  if (binary.error === "codex_binary_override_not_executable") {
    return "Configured Codex binary is not executable";
  }
  return "Codex quota unavailable";
}

function sendRpc(
  child: { stdin: { writable: boolean; write: (chunk: string) => unknown } },
  id: number,
  method: string,
  params: unknown = {},
) {
  if (!child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
}

function normalizeWindow(
  raw: unknown,
  fallbackIdentity: WindowIdentity,
  identities: WindowIdentitySet,
): QuotaWindow | undefined {
  const data = objectValue(raw) as RawWindow | undefined;
  if (!data) return undefined;
  const used = numberValue(data.used_percent) ?? numberValue(data.usedPercent);
  if (used === undefined) return undefined;
  const windowSeconds =
    numberValue(data.limit_window_seconds) ??
    (numberValue(data.windowDurationMins) === undefined
      ? undefined
      : numberValue(data.windowDurationMins)! * 60);
  const resetFromSeconds =
    numberValue(data.reset_after_seconds) === undefined
      ? undefined
      : new Date(
          Date.now() + numberValue(data.reset_after_seconds)! * 1000,
        ).toISOString();
  const identity = windowIdentity(windowSeconds, fallbackIdentity, identities);
  return withRemaining({
    ...identity,
    percentUsed: clampPercent(used),
    resetsAt:
      parseEpochOrIso(data.reset_at) ??
      parseEpochOrIso(data.resetsAt) ??
      resetFromSeconds,
    windowSeconds,
  });
}

function windowIdentity(
  windowSeconds: number | undefined,
  fallbackIdentity: WindowIdentity,
  identities: WindowIdentitySet,
): WindowIdentity {
  if (windowSeconds === undefined) return fallbackIdentity;
  if (windowSeconds === 18_000) return identities.session;
  if (windowSeconds === 604_800) return identities.weekly;
  return identities.unfamiliar(windowSeconds);
}

function readableWindowDuration(windowSeconds: number): string {
  const hours = windowSeconds / 3600;
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`;
}

function normalizeCredits(raw: unknown): ProviderQuota["credits"] | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const balance = numberValue(data.balance);
  const unlimited =
    typeof data.unlimited === "boolean" ? data.unlimited : undefined;
  if (balance === undefined && unlimited === undefined) return undefined;
  return {
    remaining: balance,
    unlimited,
    unit: "credits",
  };
}

function decodeJwtPayload(
  token: string | undefined,
): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function isExpiredJwtPayload(
  payload: Record<string, unknown> | undefined,
): boolean {
  const exp = numberValue(payload?.exp);
  return exp !== undefined && exp <= Math.floor(Date.now() / 1000);
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

function credentialSafeErrorMessage(
  error: unknown,
  credential: string,
): string {
  return redactSecret(errorMessage(error), credential);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Codex quota request timed out";
  return error instanceof Error ? error.message : "Codex quota unavailable";
}

/** Definitive 401/403 from the quota endpoint: an auth verdict, not transport. */
class CodexAuthRejectedError extends Error {}

class CodexCliUnavailableError extends Error {}

class CodexCliSignedOutError extends Error {}

class CodexCliAccountReadingError extends Error {}

function isChatgptAccountRead(value: unknown): boolean {
  return objectValue(objectValue(value)?.account)?.type === "chatgpt";
}

function isSignedOutAccountRead(value: unknown): boolean {
  const data = objectValue(value);
  if (!data || !Object.hasOwn(data, "account")) return false;
  if (data.account === null) return true;
  const type = objectValue(data.account)?.type;
  return type !== undefined && type !== "chatgpt";
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Codex quota endpoint rate limited");
  }
}
