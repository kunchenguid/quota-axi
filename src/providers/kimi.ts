import { createHash } from "node:crypto";
import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedKimiProvider as readCachedProviderFromDisk,
} from "../cache.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { VERSION } from "../version.js";
import { publishKimiReadingContextId } from "./kimi-cache-context.js";
import {
  selectCredential,
  type CandidateLocalState,
} from "./credential-selection.js";
import {
  createKimiCodeCliCredentialSource,
  KIMI_CODE_CLI_CREDENTIAL_SOURCE,
  type KimiCodeCliCredentialInspection,
  type KimiCodeCliCredentialResolution,
  type KimiCodeCliCredentialSource,
  type KimiCodeSelection,
} from "./kimi-code-cli-credential.js";
import {
  DEFAULT_KIMI_CODE_BASE_URL,
  kimiUsageUrl,
} from "./kimi-code-config.js";
import {
  createPiKimiCredentialBroker,
  type KimiCredentialBroker,
  type KimiCredentialResolution,
} from "./pi-kimi-credential.js";

/**
 * Pi brokers a Kimi credential without recording which Kimi deployment issued
 * it, so its reading keeps the default endpoint. The Kimi Code CLI source knows
 * its own environment and carries the matching URL with the token.
 */
const KIMI_QUOTA_URL = kimiUsageUrl(DEFAULT_KIMI_CODE_BASE_URL);
const PI_KIMI_CREDENTIAL_SOURCE = "pi:kimi-coding";
/**
 * The cache identity a Pi-brokered reading belongs to. Pi names no Kimi Code
 * deployment and always asks the default endpoint, so its numbers are that
 * endpoint's and not the environment `config.toml` happens to select. Stamping
 * them with a Kimi Code environment would let a mainland reading be served back
 * as a global login's stale quota - the exact substitution the environment
 * scoping exists to prevent - so a Pi reading carries its own source and
 * endpoint instead, and is reused only when the Pi source is what failed.
 *
 * Like the environment identifier, it discriminates source and endpoint rather
 * than accounts, so it does not distinguish two Pi credentials.
 */
const PI_KIMI_CACHE_CONTEXT_ID = createHash("sha256")
  .update(
    `kimi-source:${PI_KIMI_CREDENTIAL_SOURCE}\nbase:${DEFAULT_KIMI_CODE_BASE_URL}`,
  )
  .digest("hex");
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const USER_AGENT = `quota-axi/${VERSION}`;

const DURATION_MULTIPLIERS: Record<string, number> = {
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3_600,
  TIME_UNIT_DAY: 86_400,
};

export type KimiDiagnostic =
  | { code: "limits_missing" }
  | { code: "limits_invalid" }
  | { code: "detail_invalid"; index: number };

export type NormalizedKimiPayload = {
  windows: QuotaWindow[];
  diagnostics: KimiDiagnostic[];
};

type KimiDependencies = {
  broker: KimiCredentialBroker;
  cliCredentialSource: KimiCodeCliCredentialSource;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

type KimiFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  retryAfter?: string;
};

type NormalizedDetail = {
  percentUsed: number;
  percentRemaining: number;
  resetsAt?: string;
};

type ResponseBodyLifetime = {
  markConsumed(): void;
  cancel(action?: () => Promise<unknown> | undefined): Promise<void>;
};

export function createKimiAdapter(
  overrides: Partial<KimiDependencies> = {},
): ProviderAdapter {
  const dependencies: KimiDependencies = {
    broker: createPiKimiCredentialBroker(),
    cliCredentialSource: createKimiCodeCliCredentialSource(),
    fetch: globalThis.fetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "kimi",
    label: "Kimi",
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireKimiQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    async inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
      let piInspection;
      try {
        piInspection = await dependencies.broker.inspect();
      } catch {
        piInspection = "error" as const;
      }
      const piError =
        piInspection === "unsupported"
          ? "unsupported_credential_type"
          : piInspection === "expired"
            ? "pi_kimi_credential_expired"
            : piInspection === "invalid"
              ? "pi_kimi_credential_invalid"
              : piInspection === "error"
                ? "credential_resolution_failed"
                : undefined;

      let cliInspection;
      try {
        cliInspection = await dependencies.cliCredentialSource.inspect();
      } catch {
        cliInspection = "error" as const;
      }
      const cliError =
        cliInspection === "error"
          ? "credential_resolution_failed"
          : cliInspection === "invalid"
            ? "kimi_code_cli_credential_invalid"
            : cliInspection === "expired"
              ? "kimi_code_cli_credential_expired"
              : cliInspection === "unsupported_storage"
                ? "kimi_code_cli_credential_storage_unsupported"
                : cliInspection === "unrecognized_region"
                  ? "kimi_code_cli_region_unrecognized"
                  : cliInspection === "invalid_config"
                    ? "kimi_code_cli_config_invalid"
                    : cliInspection === "environment_unconfirmed"
                      ? "kimi_code_cli_credential_unconfirmed"
                      : undefined;

      return {
        provider: "kimi",
        sources: [
          {
            source: PI_KIMI_CREDENTIAL_SOURCE,
            status:
              piInspection === "available"
                ? "available"
                : piInspection === "expired"
                  ? "expired"
                  : piError
                    ? "invalid"
                    : "missing",
            ...(piError ? { error: piError } : {}),
          },
          {
            source: KIMI_CODE_CLI_CREDENTIAL_SOURCE,
            status: cliSourceStatus(cliInspection),
            ...(cliError ? { error: cliError } : {}),
          },
        ],
      };
    },
  };
}

/**
 * An environment quota-axi could not read is reported as a skipped source, not
 * as a broken credential: the store may hold a perfectly good token this reader
 * simply does not reach.
 */
function cliSourceStatus(
  inspection: KimiCodeCliCredentialInspection,
): "available" | "missing" | "invalid" | "expired" | "skipped" {
  if (inspection === "error") return "invalid";
  if (
    inspection === "unsupported_storage" ||
    inspection === "unrecognized_region" ||
    inspection === "invalid_config" ||
    inspection === "environment_unconfirmed"
  ) {
    return "skipped";
  }
  return inspection;
}

export const kimiAdapter = createKimiAdapter();

/**
 * Kimi's two credential stores are independent: either can answer alone. They
 * are consulted in priority order and a source that cannot answer hands over
 * to the next, so a broken store never speaks for a provider whose sibling
 * store still works. Handover is deliberately limited to credential problems -
 * a transport, decoding, or server failure is about the request rather than
 * the credential, and retrying it on a second credential would hide it.
 */
const KIMI_SOURCE_ORDER = [
  PI_KIMI_CREDENTIAL_SOURCE,
  KIMI_CODE_CLI_CREDENTIAL_SOURCE,
] as const;

type KimiFailureRecord = {
  failure: KimiFailure;
  /** Whether the store held a credential, so a bare gap cannot speak for one that did. */
  credentialPresent: boolean;
  /**
   * The cache identity a reading from this source would have belonged to, so
   * the stale fallback for a failure asks for the numbers that source produced
   * rather than for whatever the single Kimi cache slot happens to hold.
   */
  cacheContextId?: string;
};

type KimiCandidate =
  | {
      status: "available";
      credential: string;
      /** The endpoint this credential was issued for; it travels with it. */
      quotaUrl: string;
      /**
       * Stored-metadata classification only. A stored-expired credential is
       * still attempted in its source's declared position, and the request
       * doubles as the liveness probe that decides the verdict.
       */
      localState: CandidateLocalState;
    }
  | {
      status: "unavailable";
      failure: KimiFailure;
      attemptStatus: "skipped" | "failed";
      credentialPresent: boolean;
    };

async function acquireKimiQuota(
  dependencies: KimiDependencies,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  const attempts: SourceAttempt[] = [];
  const failures: KimiFailureRecord[] = [];
  /** The cache identity of the source being consulted, for the failure paths. */
  let cacheContextId: string | undefined;

  try {
    /**
     * One reading of the Kimi Code environment for the whole run, taken before
     * any request and inside the run's deadline, because a configuration file
     * that never answers - a FIFO, or a stalled network mount - would otherwise
     * outlive the operation quota-axi promises to bound. Everything this run
     * derives from that file - the slot, its host, and the cache identity of the
     * numbers that come back - has to come from the same reading, because the
     * file can be rewritten by a login at any point and a later reading would
     * describe an environment these numbers never came from.
     */
    const selection = await selectKimiEnvironment(
      dependencies,
      controller.signal,
    );

    for (const source of KIMI_SOURCE_ORDER) {
      cacheContextId =
        source === PI_KIMI_CREDENTIAL_SOURCE
          ? PI_KIMI_CACHE_CONTEXT_ID
          : selection?.contextId;
      const candidate = await resolveKimiCandidate(
        source,
        selection,
        dependencies,
        controller.signal,
      );
      if (candidate.status === "unavailable") {
        attempts.push({
          source,
          status: candidate.attemptStatus,
          error: candidate.failure.code,
          ...(candidate.credentialPresent ? { credentialPresent: true } : {}),
        });
        failures.push({
          failure: candidate.failure,
          credentialPresent: candidate.credentialPresent,
          cacheContextId,
        });
        if (controller.signal.aborted) break;
        continue;
      }

      // One candidate per call keeps the declared source order authoritative.
      // Stored-expired credentials remain in their source's fixed position.
      let report: ProviderQuota | undefined;
      const credentialSelection = await selectCredential(
        [
          {
            source,
            localState: candidate.localState,
            credential: candidate.credential,
          },
        ],
        async (selected) => {
          attempts.push({ source, status: "failed" });
          try {
            report = await readKimiQuota(
              selected.credential,
              candidate.quotaUrl,
              source,
              attempts,
              controller.signal,
              dependencies,
            );
            /**
             * These numbers belong to the source that produced them, so that is
             * the identity they are cached under - not the Kimi Code
             * environment, which a Pi reading never contacted.
             */
            if (cacheContextId) publishKimiReadingContextId(cacheContextId);
            return { kind: "quota", result: report };
          } catch (error) {
            const failure = asKimiFailure(error);
            attempts[attempts.length - 1] = {
              source,
              status: "failed",
              error: failure.code,
            };
            failures.push({
              failure,
              credentialPresent: true,
              cacheContextId,
            });
            return failure.definitiveAuth
              ? { kind: "rejected", error: failure.code }
              : { kind: "transient", error: failure.code };
          }
        },
      );
      if (credentialSelection.outcome === "quota" && report) return report;
      // Handover on credential problems only: a transport, decoding, or
      // server failure is about the request, so it is reported as-is.
      if (
        credentialSelection.outcome !== "all_rejected" ||
        controller.signal.aborted
      ) {
        break;
      }
    }

    const defining = definingFailure(failures);
    return failureReport(
      defining.failure,
      defining.cacheContextId,
      attempts,
      dependencies,
    );
  } catch (error) {
    const failure = asKimiFailure(error);
    if (attempts.length === 0) {
      attempts.push({
        source: PI_KIMI_CREDENTIAL_SOURCE,
        status: "failed",
        error: failure.code,
      });
    } else {
      attempts[attempts.length - 1] = {
        source: attempts[attempts.length - 1].source,
        status: "failed",
        error: failure.code,
      };
    }
    return failureReport(failure, cacheContextId, attempts, dependencies);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * A run that cannot read the environment at all - including one whose deadline
 * expires while trying - still reports through the Pi source; it simply has no
 * Kimi Code cache identity to reuse or to stamp, which is the only answer that
 * cannot attribute one deployment's numbers to another.
 */
async function selectKimiEnvironment(
  dependencies: KimiDependencies,
  signal: AbortSignal,
): Promise<KimiCodeSelection | undefined> {
  try {
    return await waitForDeadline(
      dependencies.cliCredentialSource.select(),
      signal,
    );
  } catch {
    return undefined;
  }
}

async function resolveKimiCandidate(
  source: (typeof KIMI_SOURCE_ORDER)[number],
  selection: KimiCodeSelection | undefined,
  dependencies: KimiDependencies,
  signal: AbortSignal,
): Promise<KimiCandidate> {
  if (source === PI_KIMI_CREDENTIAL_SOURCE) {
    let resolution: KimiCredentialResolution;
    try {
      resolution = await resolveCredential(dependencies.broker, signal);
    } catch (error) {
      return unavailableCandidate(asKimiFailure(error), "failed", true);
    }
    if (resolution.status === "available") {
      return {
        status: "available",
        credential: resolution.credential,
        quotaUrl: KIMI_QUOTA_URL,
        localState: "valid",
      };
    }
    if (
      resolution.status === "expired" &&
      resolution.credential !== undefined
    ) {
      return {
        status: "available",
        credential: resolution.credential,
        quotaUrl: KIMI_QUOTA_URL,
        localState: "expired",
      };
    }
    return unavailableCandidate(
      credentialFailureFor(resolution),
      resolution.status === "error" ? "failed" : "skipped",
      resolution.status !== "missing",
    );
  }

  if (!selection) {
    return unavailableCandidate(
      new KimiFailure("credential_resolution_failed", { staleEligible: true }),
      "failed",
      false,
    );
  }
  let resolution: KimiCodeCliCredentialResolution;
  try {
    resolution = await resolveCliCredential(
      dependencies.cliCredentialSource,
      selection,
      signal,
    );
  } catch (error) {
    return unavailableCandidate(asKimiFailure(error), "failed", true);
  }
  if (resolution.status === "available") {
    return {
      status: "available",
      credential: resolution.accessToken,
      quotaUrl: kimiUsageUrl(resolution.baseUrl),
      localState: "valid",
    };
  }
  if (
    resolution.status === "expired" &&
    resolution.accessToken !== undefined &&
    resolution.baseUrl !== undefined
  ) {
    return {
      status: "available",
      credential: resolution.accessToken,
      quotaUrl: kimiUsageUrl(resolution.baseUrl),
      localState: "expired",
    };
  }
  return unavailableCandidate(
    cliCredentialFailureFor(resolution),
    resolution.status === "error" ? "failed" : "skipped",
    resolution.status !== "missing" &&
      resolution.status !== "environment_unconfirmed",
  );
}

function unavailableCandidate(
  failure: KimiFailure,
  attemptStatus: "skipped" | "failed",
  credentialPresent: boolean,
): KimiCandidate {
  return { status: "unavailable", failure, attemptStatus, credentialPresent };
}

async function readKimiQuota(
  credential: string,
  quotaUrl: string,
  source: string,
  attempts: SourceAttempt[],
  signal: AbortSignal,
  dependencies: KimiDependencies,
): Promise<ProviderQuota> {
  const payload = await requestKimiQuota(
    credential,
    quotaUrl,
    signal,
    dependencies.fetch,
    dependencies.now,
  );
  const normalized = normalizeKimiPayload(payload);
  const untrustedWindowIds = normalized.diagnostics.map((diagnostic) =>
    diagnostic.code === "detail_invalid"
      ? `limit:${diagnostic.index}`
      : "limits",
  );
  const refreshedAt = new Date(dependencies.now()).toISOString();
  attempts[attempts.length - 1] = { source, status: "success" };
  return {
    provider: "kimi",
    label: "Kimi",
    source: "api",
    windows: normalized.windows,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt,
      ...(untrustedWindowIds.length > 0 ? { untrustedWindowIds } : {}),
      sourcesTried: attempts.map(({ source: name }) => name),
    },
    attempts,
  };
}

/**
 * Which recorded failure speaks for the provider. A sibling that only failed
 * transiently outranks a definitive rejection, so a rejected credential can
 * never be reported as a sign-out while another source's outage is unresolved;
 * among definitive verdicts a store that actually held a credential outranks
 * one that was simply absent.
 */
function definingFailure(failures: KimiFailureRecord[]): KimiFailureRecord {
  return (
    failures.find((record) => !record.failure.definitiveAuth) ??
    failures.find((record) => record.credentialPresent) ??
    failures[0] ?? {
      failure: new KimiFailure("credential_resolution_failed", {
        staleEligible: true,
      }),
      credentialPresent: false,
    }
  );
}

function asKimiFailure(error: unknown): KimiFailure {
  return error instanceof KimiFailure
    ? error
    : new KimiFailure("credential_resolution_failed", { staleEligible: true });
}

async function resolveCredential(
  broker: KimiCredentialBroker,
  signal: AbortSignal,
): Promise<KimiCredentialResolution> {
  try {
    return await waitForDeadline(broker.resolve(), signal);
  } catch (error) {
    if (error instanceof KimiFailure) throw error;
    throw new KimiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
}

async function resolveCliCredential(
  source: KimiCodeCliCredentialSource,
  selection: KimiCodeSelection,
  signal: AbortSignal,
): Promise<KimiCodeCliCredentialResolution> {
  try {
    return await waitForDeadline(source.resolve(selection), signal);
  } catch (error) {
    if (error instanceof KimiFailure) throw error;
    throw new KimiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
}

function credentialFailureFor(
  resolution: Exclude<KimiCredentialResolution, { status: "available" }>,
): KimiFailure {
  if (resolution.status === "missing") {
    return new KimiFailure("kimi_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "unsupported") {
    return new KimiFailure("unsupported_credential_type", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "invalid") {
    return new KimiFailure("pi_kimi_credential_invalid", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "expired") {
    return new KimiFailure("pi_kimi_credential_expired", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "error") {
    return new KimiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
  return new KimiFailure("credential_resolution_failed", {
    staleEligible: true,
  });
}

function cliCredentialFailureFor(
  resolution: Exclude<KimiCodeCliCredentialResolution, { status: "available" }>,
): KimiFailure {
  if (resolution.status === "missing") {
    return new KimiFailure("kimi_code_cli_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "expired") {
    return new KimiFailure("kimi_code_cli_credential_expired", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "error") {
    return new KimiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
  /**
   * A credential quota-axi cannot read is not a credential the user does not
   * have. These three say the store was described in a way this reader does not
   * cover, so they stay non-definitive: they never assert a sign-out and never
   * retire the cache.
   */
  if (resolution.status === "unsupported_storage") {
    return new KimiFailure("kimi_code_cli_credential_storage_unsupported", {
      staleEligible: true,
    });
  }
  if (resolution.status === "unrecognized_region") {
    return new KimiFailure("kimi_code_cli_region_unrecognized", {
      staleEligible: true,
    });
  }
  if (resolution.status === "invalid_config") {
    return new KimiFailure("kimi_code_cli_config_invalid", {
      staleEligible: true,
    });
  }
  /**
   * An environment quota-axi never established is not an account the user does
   * not have: the guess, not the account, is what failed to name a slot.
   * Asserting a sign-out here would claim knowledge quota-axi does not have and
   * would retire cached numbers that are still the best it can say.
   */
  if (resolution.status === "environment_unconfirmed") {
    return new KimiFailure("kimi_code_cli_credential_unconfirmed", {
      staleEligible: true,
    });
  }
  return new KimiFailure("kimi_code_cli_credential_invalid", {
    status: "auth_required",
    definitiveAuth: true,
  });
}

function failureReport(
  failure: KimiFailure,
  cacheContextId: string | undefined,
  attempts: SourceAttempt[],
  dependencies: KimiDependencies,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("kimi");
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible && cacheContextId) {
    try {
      const cached = dependencies.readCachedProvider(cacheContextId);
      const stale = cached
        ? staleKimiReport(
            cached,
            failure.code,
            failure.retryAfter,
            attempts,
            dependencies.now(),
          )
        : undefined;
      if (stale) return stale;
    } catch {
      // Cache I/O cannot replace the bounded current provider failure.
    }
  }

  return {
    provider: "kimi",
    label: "Kimi",
    source: "unavailable",
    windows: [],
    state: {
      status: failure.status,
      stale: false,
      error: failure.code,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: attempts.map(({ source }) => source),
    },
    attempts,
  };
}

function staleKimiReport(
  cached: ProviderQuota,
  error: string,
  retryAfter: string | undefined,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "kimi" ||
    cached.source !== "api" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  ) {
    return undefined;
  }
  const refreshedAt = Date.parse(cached.state.refreshedAt);
  if (!Number.isFinite(refreshedAt)) return undefined;
  const ageMilliseconds = Math.max(0, now - refreshedAt);
  const windows = cached.windows.filter((window) => {
    if (window.resetsAt) {
      const resetsAt = Date.parse(window.resetsAt);
      if (Number.isFinite(resetsAt)) return resetsAt > now;
    }
    const maxAgeSeconds =
      window.kind === "weekly" ? WEEK_SECONDS : FIVE_HOURS_SECONDS;
    return ageMilliseconds < maxAgeSeconds * 1_000;
  });
  if (windows.length === 0) return undefined;

  return {
    provider: "kimi",
    label: "Kimi",
    source: "cache",
    windows,
    state: {
      status: "stale",
      stale: true,
      refreshedAt: cached.state.refreshedAt,
      error,
      ...(retryAfter ? { retryAfter } : {}),
      ...(cached.state.untrustedWindowIds
        ? { untrustedWindowIds: cached.state.untrustedWindowIds }
        : {}),
      sourcesTried: [...attempts.map(({ source }) => source), "cache"],
    },
    attempts,
  };
}

async function requestKimiQuota(
  apiKey: string,
  quotaUrl: string,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await waitForDeadline(
      fetchImplementation(quotaUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        credentials: "omit",
        redirect: "manual",
        signal,
      }),
      signal,
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new KimiFailure("request_timeout", { staleEligible: true });
    }
    throw new KimiFailure(localTransportCode(error), {
      staleEligible: true,
    });
  }

  const lifetime = createResponseBodyLifetime(response);
  try {
    const receivedAt = now();
    rejectHttpFailure(response, receivedAt);
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      throw new KimiFailure("unexpected_content_type", {
        staleEligible: true,
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, signal, lifetime);
      lifetime.markConsumed();
    } catch (error) {
      if (error instanceof KimiFailure) throw error;
      if (signal.aborted || isAbortError(error)) {
        throw new KimiFailure("request_timeout", { staleEligible: true });
      }
      throw new KimiFailure("network_unavailable", { staleEligible: true });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new KimiFailure("response_invalid_utf8", { staleEligible: true });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new KimiFailure("malformed_json", { staleEligible: true });
    }
  } finally {
    await lifetime.cancel();
  }
}

function rejectHttpFailure(response: Response, receivedAt: number): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new KimiFailure("redirect_rejected");
  }
  if (status === 401 || status === 403) {
    throw new KimiFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (status === 408) {
    throw new KimiFailure("provider_timeout", { staleEligible: true });
  }
  if (status === 429) {
    throw new KimiFailure("provider_rate_limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: normalizeRetryAfter(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new KimiFailure("provider_unavailable", { staleEligible: true });
  }
  throw new KimiFailure("provider_request_rejected");
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      throw new KimiFailure("response_too_large", { staleEligible: true });
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readBodyChunk(reader, signal, lifetime);
      if (done) break;
      length += value.length;
      if (length > RESPONSE_LIMIT_BYTES) {
        throw new KimiFailure("response_too_large", { staleEligible: true });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const cancelReader = () => lifetime.cancel(() => reader.cancel());
  if (signal.aborted) {
    await cancelReader();
    throw new KimiFailure("request_timeout", { staleEligible: true });
  }
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      cancelReader().then(() => {
        reject(new KimiFailure("request_timeout", { staleEligible: true }));
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => {
        if (aborted) return;
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        if (aborted) return;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function createResponseBodyLifetime(response: Response): ResponseBodyLifetime {
  let consumed = false;
  let cancellation: Promise<void> | undefined;

  return {
    markConsumed() {
      if (!cancellation) consumed = true;
    },
    async cancel(action = () => response.body?.cancel()) {
      if (consumed) return;
      cancellation ??= Promise.resolve()
        .then(action)
        .then(() => undefined)
        .catch(() => undefined);
      await cancellation;
    },
  };
}

export function normalizeKimiPayload(payload: unknown): NormalizedKimiPayload {
  const root = objectValue(payload);
  const principal = normalizeDetail(root?.usage);
  if (!root || !principal) {
    throw new KimiFailure("schema_invalid", { staleEligible: true });
  }

  const windows: QuotaWindow[] = [
    {
      id: "weekly",
      label: "week",
      kind: "weekly",
      percentUsed: principal.percentUsed,
      percentRemaining: principal.percentRemaining,
      windowSeconds: WEEK_SECONDS,
      ...(principal.resetsAt ? { resetsAt: principal.resetsAt } : {}),
    },
  ];
  const diagnostics: KimiDiagnostic[] = [];
  const limitsValue = root.limits;
  if (limitsValue === undefined || limitsValue === null) {
    diagnostics.push({ code: "limits_missing" });
    return { windows, diagnostics };
  }
  if (!Array.isArray(limitsValue)) {
    diagnostics.push({ code: "limits_invalid" });
    return { windows, diagnostics };
  }

  let fiveHourSeen = false;
  for (const [offset, rawEntry] of (Array.isArray(limitsValue)
    ? limitsValue
    : []
  ).entries()) {
    const index = offset + 1;
    const entry = objectValue(rawEntry);
    const detail = normalizeDetail(entry?.detail);
    if (!entry || !detail) {
      diagnostics.push({ code: "detail_invalid", index });
      continue;
    }
    const windowSeconds = normalizeWindowSeconds(entry.window);
    const isFiveHour = windowSeconds === FIVE_HOURS_SECONDS && !fiveHourSeen;
    if (isFiveHour) fiveHourSeen = true;
    windows.push({
      id: isFiveHour ? "five_hour" : `limit:${index}`,
      label: isFiveHour ? "session" : `limit ${index}`,
      kind: isFiveHour ? "session" : "unknown",
      percentUsed: detail.percentUsed,
      percentRemaining: detail.percentRemaining,
      ...(detail.resetsAt ? { resetsAt: detail.resetsAt } : {}),
      ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    });
  }

  return { windows, diagnostics };
}

function normalizeDetail(value: unknown): NormalizedDetail | undefined {
  const detail = objectValue(value);
  if (!detail) return undefined;
  const limit = numericScalar(detail.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const explicitUsed = nonnegativeScalar(detail.used);
  const remaining = nonnegativeScalar(detail.remaining);
  const used =
    explicitUsed !== undefined
      ? explicitUsed
      : remaining !== undefined
        ? Math.max(0, limit - remaining)
        : undefined;
  if (used === undefined) return undefined;

  const percentUsed = clampPercent((used / limit) * 100);
  const resetsAt = normalizedReset(detail);
  return {
    percentUsed,
    percentRemaining: clampPercent(100 - percentUsed),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function normalizeWindowSeconds(value: unknown): number | undefined {
  const window = objectValue(value);
  if (!window || typeof window.timeUnit !== "string") return undefined;
  const duration = numericScalar(window.duration);
  const multiplier = DURATION_MULTIPLIERS[window.timeUnit];
  if (duration === undefined || duration <= 0 || multiplier === undefined) {
    return undefined;
  }
  const seconds = duration * multiplier;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function numericScalar(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonnegativeScalar(value: unknown): number | undefined {
  const parsed = numericScalar(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function normalizedReset(detail: Record<string, unknown>): string | undefined {
  for (const key of ["resetTime", "resetAt", "reset_time", "reset_at"]) {
    const normalized = normalizeRfc3339(detail[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeRfc3339(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, Math.min(second, 59), millisecond);
  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMilliseconds =
    match[8] === "Z"
      ? 0
      : offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const instant =
    local.getTime() - offsetMilliseconds + (second === 60 ? 1_000 : 0);
  if (!Number.isFinite(instant)) return undefined;
  try {
    return new Date(instant).toISOString();
  } catch {
    return undefined;
  }
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function normalizeRetryAfter(
  value: string | null,
  receivedAt: number,
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    const instant = receivedAt + seconds * 1_000;
    if (!Number.isFinite(seconds) || !Number.isFinite(instant))
      return undefined;
    try {
      return new Date(instant).toISOString();
    } catch {
      return undefined;
    }
  }
  const instant = parseHttpDate(raw, receivedAt);
  return instant === undefined ? undefined : new Date(instant).toISOString();
}

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function parseHttpDate(value: string, receivedAt: number): number | undefined {
  const imf =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    );
  if (imf) {
    return validatedHttpInstant(
      SHORT_WEEKDAYS.indexOf(imf[1]),
      Number(imf[4]),
      MONTHS.indexOf(imf[3]) + 1,
      Number(imf[2]),
      Number(imf[5]),
      Number(imf[6]),
      Number(imf[7]),
    );
  }

  const rfc850 =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    );
  if (rfc850) {
    const currentYear = new Date(receivedAt).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[4]);
    if (year > currentYear + 50) year -= 100;
    return validatedHttpInstant(
      LONG_WEEKDAYS.indexOf(rfc850[1]),
      year,
      MONTHS.indexOf(rfc850[3]) + 1,
      Number(rfc850[2]),
      Number(rfc850[5]),
      Number(rfc850[6]),
      Number(rfc850[7]),
    );
  }

  const asctime =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: (\d)|(\d{2})) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      value,
    );
  if (!asctime) return undefined;
  return validatedHttpInstant(
    SHORT_WEEKDAYS.indexOf(asctime[1]),
    Number(asctime[8]),
    MONTHS.indexOf(asctime[2]) + 1,
    Number(asctime[3] ?? asctime[4]),
    Number(asctime[5]),
    Number(asctime[6]),
    Number(asctime[7]),
  );
}

function validatedHttpInstant(
  weekday: number,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  if (
    weekday < 0 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCDay() === weekday ? date.getTime() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function localTransportCode(
  error: unknown,
): "tls_failed" | "network_unavailable" {
  const cause = objectValue(objectValue(error)?.cause);
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  return code && /(?:TLS|SSL|CERT|UNABLE_TO_VERIFY)/i.test(code)
    ? "tls_failed"
    : "network_unavailable";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function waitForDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new KimiFailure("request_timeout", { staleEligible: true }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new KimiFailure("request_timeout", { staleEligible: true }));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

class KimiFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: KimiFailureOptions = {}) {
    super(code);
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible ?? false;
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.retryAfter = options.retryAfter;
  }
}
