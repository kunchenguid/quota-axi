// Endpoint behavior and auth discovery derived from opencode-glm-quota
// (c) guyinwonder168, MIT, https://github.com/guyinwonder168/opencode-glm-quota
// and the vendor plugin zai-org/zai-coding-plugins. No third-party code is
// vendored here; the HTTP layer and normalization are an original implementation.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { usableLiteralSecret } from "../lib/secret.js";
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
import {
  selectCredential,
  type AttemptOutcome,
  type CandidateResult,
  type CredentialCandidate as SelectionCandidate,
  type CredentialSelection,
} from "./credential-selection.js";
import {
  createPiApiKeyCredentialBroker,
  type PiApiKeyCredentialBroker,
  type PiApiKeyCredentialInspection,
  type PiApiKeyCredentialResolution,
} from "./pi-api-key-credential.js";

const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MONTH_SECONDS = 30 * 24 * 60 * 60;
const ZAI_HOST = "api.z.ai";
const ZHIPU_HOST = "open.bigmodel.cn";
const OPENCODE_AUTH_SOURCE = "opencode:auth.json";
const USER_AGENT = `quota-axi/${VERSION}`;

// Pi stores the Z.AI Coding Plan key under `zai` (global, api.z.ai) or
// `zai-coding-cn` (China, open.bigmodel.cn); the same hosts the opencode
// source's ids resolve to.
const PI_ZAI_PROVIDER_IDS = ["zai", "zai-coding-cn"] as const;
const PI_ZAI_CN_PROVIDER_ID = "zai-coding-cn";

const ZAI_PROVIDER_IDS = ["zai-coding-plan", "zai", "z-ai", "z.ai"];
const ZHIPU_PROVIDER_IDS = ["zhipu", "zhipuai"];
const CREDENTIAL_KEYS = [
  "key",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "auth_token",
];

export type ZaiDiagnostic =
  | { code: "entry_invalid"; index: number }
  | { code: "entry_unrecognized"; index: number };

export type NormalizedZaiPayload = {
  windows: QuotaWindow[];
  plan?: string;
  diagnostics: ZaiDiagnostic[];
};

export type ZaiCredentialResolution =
  | { status: "available"; apiKey: string; host: string; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export type ZaiCredentialInspection =
  | { status: "available"; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export type ZaiCredentialSource = {
  resolve(): ZaiCredentialResolution;
  inspect(): ZaiCredentialInspection;
};

type ZaiAttemptCredential = { apiKey: string; host: string };

type ZaiDependencies = {
  credentialSource: ZaiCredentialSource;
  piCredentialBroker: PiApiKeyCredentialBroker;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

type ZaiFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  retryAfter?: string;
};

type ResponseBodyLifetime = {
  markConsumed(): void;
  cancel(action?: () => Promise<unknown> | undefined): Promise<void>;
};

export function opencodeAuthFilePath(): string {
  const xdg = stringValue(process.env.XDG_DATA_HOME);
  if (xdg) return join(xdg, "opencode", "auth.json");
  if (process.platform === "win32") {
    const localAppData = stringValue(process.env.LOCALAPPDATA);
    if (localAppData) return join(localAppData, "opencode", "auth.json");
  }
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

export function extractZaiCredential(
  value: unknown,
  path: string,
): ZaiCredentialResolution {
  const data = objectValue(value);
  if (!data) return { status: "invalid", path, error: "json_parse_error" };
  for (const providerId of [...ZAI_PROVIDER_IDS, ...ZHIPU_PROVIDER_IDS]) {
    const entry = data[providerId];
    if (entry === undefined || entry === null) continue;
    const host = ZAI_PROVIDER_IDS.includes(providerId) ? ZAI_HOST : ZHIPU_HOST;
    const key = extractKey(entry);
    if (key) return { status: "available", apiKey: key, host, path };
  }
  return { status: "missing", path };
}

export function createOpencodeAuthCredentialSource(
  filePath: () => string = opencodeAuthFilePath,
): ZaiCredentialSource {
  function resolve(): ZaiCredentialResolution {
    const path = filePath();
    const result: JsonFileReadResult = readJsonFileResult(path);
    if (result.status === "missing") return { status: "missing", path };
    if (result.status === "invalid")
      return result.error === "file_read_error"
        ? { status: "error", path, error: result.error }
        : { status: "invalid", path, error: result.error };
    return extractZaiCredential(result.value, path);
  }
  return {
    resolve,
    inspect(): ZaiCredentialInspection {
      const resolution = resolve();
      if (resolution.status === "available")
        return { status: "available", path: resolution.path };
      return resolution;
    },
  };
}

export function createZaiAdapter(
  overrides: Partial<ZaiDependencies> = {},
): ProviderAdapter {
  const dependencies: ZaiDependencies = {
    credentialSource: createOpencodeAuthCredentialSource(),
    piCredentialBroker: createPiApiKeyCredentialBroker(PI_ZAI_PROVIDER_IDS),
    fetch: globalThis.fetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "zai",
    label: "Z.AI",
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireZaiQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    async inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
      const piInspection = await inspectPiCredential(dependencies);
      const piStatus =
        piInspection.status === "unsupported" ? "invalid" : piInspection.status;
      const piError =
        piInspection.status === "unsupported"
          ? "unsupported_credential_type"
          : piInspection.status === "invalid"
            ? "invalid_credential"
            : piInspection.status === "error"
              ? "credential_resolution_failed"
              : undefined;
      const inspection = dependencies.credentialSource.inspect();
      return {
        provider: "zai",
        sources: [
          {
            source: `pi:${piInspection.providerId}`,
            status: piStatus,
            ...(piError ? { error: piError } : {}),
          },
          {
            source: OPENCODE_AUTH_SOURCE,
            path: inspection.path,
            status: inspection.status,
            ...(inspection.status === "invalid" || inspection.status === "error"
              ? { error: inspection.error }
              : {}),
          },
        ],
      };
    },
  };
}

export const zaiAdapter = createZaiAdapter();

async function acquireZaiQuota(
  dependencies: ZaiDependencies,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  let attempts: SourceAttempt[] = [];

  try {
    const piResolution = await resolvePiCredential(dependencies);
    const opencodeResolution = resolveOpencodeCredential(
      dependencies.credentialSource,
    );
    const selection = await selectCredential(
      zaiCredentialCandidates(piResolution, opencodeResolution),
      (candidate) =>
        attemptZaiCandidate(candidate, controller.signal, dependencies),
    );
    attempts = zaiAttempts(
      dependencies.piCredentialBroker.providerIds[0],
      piResolution,
      opencodeResolution,
      selection,
    );
    return zaiReportFromSelection(
      selection,
      attempts,
      piResolution,
      opencodeResolution,
      dependencies,
    );
  } catch (error) {
    const failure =
      error instanceof ZaiFailure
        ? error
        : new ZaiFailure("credential_resolution_failed", {
            staleEligible: true,
          });
    if (attempts.length === 0) {
      attempts = [
        {
          source: OPENCODE_AUTH_SOURCE,
          status: "failed",
          error: failure.code,
        },
      ];
    } else {
      attempts[attempts.length - 1] = {
        source: attempts[attempts.length - 1].source,
        status: "failed",
        error: failure.code,
      };
    }
    return failureReport(failure, attempts, dependencies);
  } finally {
    clearTimeout(deadline);
  }
}

async function resolvePiCredential(
  dependencies: ZaiDependencies,
): Promise<PiApiKeyCredentialResolution> {
  try {
    return await dependencies.piCredentialBroker.resolve();
  } catch {
    return { status: "error" };
  }
}

function resolveOpencodeCredential(
  source: ZaiCredentialSource,
): ZaiCredentialResolution {
  try {
    return source.resolve();
  } catch {
    return { status: "error", path: "", error: "file_read_error" };
  }
}

/** Pi's entry is tried first; the opencode store stays the fallback. */
function zaiCredentialCandidates(
  piResolution: PiApiKeyCredentialResolution,
  opencodeResolution: ZaiCredentialResolution,
): readonly SelectionCandidate<ZaiAttemptCredential>[] {
  const candidates: SelectionCandidate<ZaiAttemptCredential>[] = [];
  if (piResolution.status === "available") {
    candidates.push({
      source: `pi:${piResolution.providerId}`,
      localState: "valid",
      credential: {
        apiKey: piResolution.credential,
        host:
          piResolution.providerId === PI_ZAI_CN_PROVIDER_ID
            ? ZHIPU_HOST
            : ZAI_HOST,
      },
    });
  }
  if (opencodeResolution.status === "available") {
    candidates.push({
      source: OPENCODE_AUTH_SOURCE,
      localState: "valid",
      credential: {
        apiKey: opencodeResolution.apiKey,
        host: opencodeResolution.host,
      },
    });
  }
  return candidates;
}

async function attemptZaiCandidate(
  candidate: SelectionCandidate<ZaiAttemptCredential>,
  signal: AbortSignal,
  dependencies: ZaiDependencies,
): Promise<AttemptOutcome<NormalizedZaiPayload>> {
  try {
    const payload = await requestZaiQuota(
      candidate.credential.apiKey,
      candidate.credential.host,
      signal,
      dependencies.fetch,
      dependencies.now,
    );
    return { kind: "quota", result: normalizeZaiPayload(payload) };
  } catch (error) {
    const failure =
      error instanceof ZaiFailure
        ? error
        : new ZaiFailure("credential_resolution_failed", {
            staleEligible: true,
          });
    if (failure.definitiveAuth) {
      return { kind: "rejected", error: failure.code };
    }
    return {
      kind: "transient",
      error: failure.code,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
    };
  }
}

function zaiAttempts(
  piPrimaryProviderId: string | undefined,
  piResolution: PiApiKeyCredentialResolution,
  opencodeResolution: ZaiCredentialResolution,
  selection: CredentialSelection<NormalizedZaiPayload>,
): SourceAttempt[] {
  const piSourceName = piEntrySourceName(piResolution, piPrimaryProviderId);
  return [
    piAttemptRecord(piResolution, piSourceName, selection),
    opencodeAttemptRecord(opencodeResolution, selection),
  ];
}

/** Names the source after the entry actually responsible for the state. */
function piEntrySourceName(
  resolution: PiApiKeyCredentialResolution,
  primary: string | undefined,
): string {
  const providerId =
    resolution.status === "available" ||
    resolution.status === "invalid" ||
    resolution.status === "unsupported"
      ? resolution.providerId
      : undefined;
  return `pi:${providerId ?? primary ?? "zai"}`;
}

function piAttemptRecord(
  resolution: PiApiKeyCredentialResolution,
  sourceName: string,
  selection: CredentialSelection<NormalizedZaiPayload>,
): SourceAttempt {
  if (resolution.status === "available") {
    return selectionAttemptRecord(
      sourceName,
      selection.results.find((entry) => entry.source === sourceName),
      selection,
    );
  }
  switch (resolution.status) {
    case "missing":
      return {
        source: sourceName,
        status: "skipped",
        error: "zai_credential_unavailable",
      };
    case "invalid":
      return {
        source: sourceName,
        status: "skipped",
        error: "zai_credential_invalid",
      };
    case "unsupported":
      return {
        source: sourceName,
        status: "skipped",
        error: "unsupported_credential_type",
      };
    default:
      return {
        source: sourceName,
        status: "failed",
        error: "credential_resolution_failed",
      };
  }
}

function opencodeAttemptRecord(
  resolution: ZaiCredentialResolution,
  selection: CredentialSelection<NormalizedZaiPayload>,
): SourceAttempt {
  if (resolution.status === "available") {
    return selectionAttemptRecord(
      OPENCODE_AUTH_SOURCE,
      selection.results.find((entry) => entry.source === OPENCODE_AUTH_SOURCE),
      selection,
    );
  }
  switch (resolution.status) {
    case "missing":
      return {
        source: OPENCODE_AUTH_SOURCE,
        status: "skipped",
        error: "zai_credential_unavailable",
      };
    case "invalid":
      return {
        source: OPENCODE_AUTH_SOURCE,
        status: "skipped",
        error: "zai_credential_invalid",
      };
    default:
      return {
        source: OPENCODE_AUTH_SOURCE,
        status: "failed",
        error: "credential_resolution_failed",
      };
  }
}

function selectionAttemptRecord(
  sourceName: string,
  result: CandidateResult | undefined,
  selection: CredentialSelection<NormalizedZaiPayload>,
): SourceAttempt {
  if (
    result === undefined ||
    result.outcome === "not_tried" ||
    result.outcome === "live_no_quota"
  ) {
    return {
      source: sourceName,
      status: "skipped",
      ...(selection.transientError ? { error: selection.transientError } : {}),
    };
  }
  if (result.outcome === "quota") {
    return { source: sourceName, status: "success" };
  }
  return { source: sourceName, status: "failed", error: result.error };
}

function zaiReportFromSelection(
  selection: CredentialSelection<NormalizedZaiPayload>,
  attempts: SourceAttempt[],
  piResolution: PiApiKeyCredentialResolution,
  opencodeResolution: ZaiCredentialResolution,
  dependencies: ZaiDependencies,
): ProviderQuota {
  if (selection.outcome === "quota" && selection.result) {
    const normalized = selection.result;
    const untrustedWindowIds = normalized.diagnostics.map(
      (diagnostic) => `limit:${diagnostic.index}`,
    );
    return {
      provider: "zai",
      label: "Z.AI",
      source: "api",
      ...(normalized.plan ? { plan: normalized.plan } : {}),
      windows: normalized.windows,
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(dependencies.now()).toISOString(),
        ...(untrustedWindowIds.length > 0 ? { untrustedWindowIds } : {}),
        sourcesTried: attempts.map(({ source }) => source),
      },
      attempts,
    };
  }
  return failureReport(
    selectionFailureFor(selection, piResolution, opencodeResolution),
    attempts,
    dependencies,
  );
}

function selectionFailureFor(
  selection: CredentialSelection<NormalizedZaiPayload>,
  piResolution: PiApiKeyCredentialResolution,
  opencodeResolution: ZaiCredentialResolution,
): ZaiFailure {
  switch (selection.outcome) {
    case "transient":
      return failureForCode(
        selection.transientError ?? "credential_resolution_failed",
        selection.retryAfter,
      );
    case "all_rejected":
      // A source that could not be read leaves the credential set
      // indeterminate: never a definitive sign-out (or cache retirement)
      // while a usable credential may sit behind an unreadable store.
      if (
        piResolution.status === "error" ||
        opencodeResolution.status === "error"
      ) {
        return new ZaiFailure("credential_resolution_failed", {
          staleEligible: true,
        });
      }
      return new ZaiFailure("provider_auth_rejected", {
        status: "auth_required",
        definitiveAuth: true,
      });
    case "live_no_quota":
      // Unreachable for Z.AI: every attempt yields windows or throws.
      return new ZaiFailure("schema_invalid");
    default: {
      if (
        piResolution.status === "error" ||
        opencodeResolution.status === "error"
      ) {
        return new ZaiFailure("credential_resolution_failed", {
          staleEligible: true,
        });
      }
      // The opencode store's own state wins unless it is plain missing; a
      // missing fallback defers to the Pi source's distinct state.
      return opencodeResolution.status === "missing"
        ? piLocalFailureFor(piResolution)
        : opencodeLocalFailureFor(opencodeResolution);
    }
  }
}

function piLocalFailureFor(
  resolution: PiApiKeyCredentialResolution,
): ZaiFailure {
  switch (resolution.status) {
    case "missing":
      return new ZaiFailure("zai_credential_unavailable", {
        status: "auth_required",
        definitiveAuth: true,
      });
    case "unsupported":
      return new ZaiFailure("unsupported_credential_type", {
        status: "auth_required",
        definitiveAuth: true,
      });
    case "error":
      return new ZaiFailure("credential_resolution_failed", {
        staleEligible: true,
      });
    default:
      // Unreachable in the no-candidates branch (an available Pi credential
      // would have been a candidate): classify as an invalid credential.
      return new ZaiFailure("zai_credential_invalid", {
        status: "auth_required",
        definitiveAuth: true,
      });
  }
}

function opencodeLocalFailureFor(
  resolution: ZaiCredentialResolution,
): ZaiFailure {
  if (resolution.status === "missing") {
    return new ZaiFailure("zai_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "error") {
    return new ZaiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
  return new ZaiFailure("zai_credential_invalid", {
    status: "auth_required",
    definitiveAuth: true,
  });
}

async function inspectPiCredential(
  dependencies: ZaiDependencies,
): Promise<PiApiKeyCredentialInspection> {
  try {
    return await dependencies.piCredentialBroker.inspect();
  } catch {
    return {
      status: "error",
      providerId: dependencies.piCredentialBroker.providerIds[0] ?? "zai",
      error: "credential_resolution_failed",
    };
  }
}

/** Rebuilds a non-auth failure with its original transport classification. */
function failureForCode(code: string, retryAfter?: string): ZaiFailure {
  switch (code) {
    case "provider_rate_limited":
      return new ZaiFailure(code, {
        status: "rate_limited",
        staleEligible: true,
        retryAfter,
      });
    case "redirect_rejected":
    case "provider_request_rejected":
    case "response_invalid_utf8":
    case "malformed_json":
    case "schema_invalid":
      return new ZaiFailure(code, { retryAfter });
    default:
      return new ZaiFailure(code, { staleEligible: true, retryAfter });
  }
}

function failureReport(
  failure: ZaiFailure,
  attempts: SourceAttempt[],
  dependencies: ZaiDependencies,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("zai");
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = dependencies.readCachedProvider("zai");
      const stale = cached
        ? staleZaiReport(
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
    provider: "zai",
    label: "Z.AI",
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

function staleZaiReport(
  cached: ProviderQuota,
  error: string,
  retryAfter: string | undefined,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "zai" ||
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
    const maxAgeSeconds = maxStaleAgeSeconds(window);
    return maxAgeSeconds > 0 && ageMilliseconds < maxAgeSeconds * 1_000;
  });
  if (windows.length === 0) return undefined;

  return {
    provider: "zai",
    label: "Z.AI",
    source: "cache",
    ...(cached.plan ? { plan: cached.plan } : {}),
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

function maxStaleAgeSeconds(window: QuotaWindow): number {
  if (window.windowSeconds !== undefined && window.windowSeconds > 0)
    return window.windowSeconds;
  switch (window.kind) {
    case "session":
      return FIVE_HOURS_SECONDS;
    case "weekly":
      return WEEK_SECONDS;
    case "monthly":
      return MONTH_SECONDS;
    default:
      return 0;
  }
}

async function requestZaiQuota(
  apiKey: string,
  host: string,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await waitForDeadline(
      fetchImplementation(`https://${host}${ZAI_QUOTA_PATH}`, {
        method: "GET",
        headers: {
          Authorization: apiKey,
          Accept: "application/json",
          "Accept-Language": "en-US,en",
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
      throw new ZaiFailure("request_timeout", { staleEligible: true });
    }
    throw new ZaiFailure(localTransportCode(error), { staleEligible: true });
  }

  const lifetime = createResponseBodyLifetime(response);
  try {
    const receivedAt = now();
    rejectHttpFailure(response, receivedAt);

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, signal, lifetime);
      lifetime.markConsumed();
    } catch (error) {
      if (error instanceof ZaiFailure) throw error;
      if (signal.aborted || isAbortError(error)) {
        throw new ZaiFailure("request_timeout", { staleEligible: true });
      }
      throw new ZaiFailure("network_unavailable", { staleEligible: true });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ZaiFailure("response_invalid_utf8");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ZaiFailure("malformed_json");
    }
  } finally {
    await lifetime.cancel();
  }
}

function rejectHttpFailure(response: Response, receivedAt: number): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new ZaiFailure("redirect_rejected");
  }
  if (status === 401 || status === 403) {
    throw new ZaiFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (status === 408) {
    throw new ZaiFailure("provider_timeout", { staleEligible: true });
  }
  if (status === 429) {
    throw new ZaiFailure("provider_rate_limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: normalizeRetryAfter(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new ZaiFailure("provider_unavailable", { staleEligible: true });
  }
  throw new ZaiFailure("provider_request_rejected");
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      throw new ZaiFailure("response_too_large", { staleEligible: true });
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
        throw new ZaiFailure("response_too_large", { staleEligible: true });
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
    throw new ZaiFailure("request_timeout", { staleEligible: true });
  }
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      cancelReader().then(() => {
        reject(new ZaiFailure("request_timeout", { staleEligible: true }));
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

export function normalizeZaiPayload(payload: unknown): NormalizedZaiPayload {
  const root = objectValue(payload);
  const data = objectValue(root?.data) ?? root;
  const limitsValue = data?.limits;
  if (!Array.isArray(limitsValue)) {
    throw new ZaiFailure("schema_invalid");
  }

  const windows: QuotaWindow[] = [];
  const diagnostics: ZaiDiagnostic[] = [];
  const seenIds = new Set<string>();
  for (const [offset, rawEntry] of limitsValue.entries()) {
    const index = offset + 1;
    const entry = objectValue(rawEntry);
    if (!entry) {
      diagnostics.push({ code: "entry_invalid", index });
      continue;
    }
    const mapped = mapLimitEntry(entry, index);
    const duplicate = seenIds.has(mapped.window.id);
    if (!mapped.recognized || duplicate) {
      diagnostics.push({ code: "entry_unrecognized", index });
    }
    const window = duplicate
      ? unknownWindow(mapped.measurements, index)
      : mapped.window;
    seenIds.add(window.id);
    windows.push(window);
  }

  if (windows.length === 0) {
    throw new ZaiFailure("schema_invalid");
  }
  const plan = stringValue(data?.level);
  return {
    windows,
    ...(plan ? { plan } : {}),
    diagnostics,
  };
}

type WindowMeasurements = {
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: string;
};

type MappedEntry = {
  window: QuotaWindow;
  measurements: WindowMeasurements;
  recognized: boolean;
};

function unknownWindow(
  measurements: WindowMeasurements,
  index: number,
): QuotaWindow {
  return {
    id: `limit:${index}`,
    label: `limit ${index}`,
    kind: "unknown",
    ...measurements,
  };
}

function mapLimitEntry(
  entry: Record<string, unknown>,
  index: number,
): MappedEntry {
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const unit = numericScalar(entry.unit);
  const number = numericScalar(entry.number);
  const percentUsed = resolvePercentUsed(entry);
  const percentRemaining =
    percentUsed !== undefined ? clampPercent(100 - percentUsed) : undefined;
  const resetsAt = resolveResetsAt(entry.nextResetTime);

  const identity = identifyWindow(type, unit, number);
  const measurements: WindowMeasurements = {
    ...(percentUsed !== undefined ? { percentUsed } : {}),
    ...(percentRemaining !== undefined ? { percentRemaining } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };

  if (identity) {
    return {
      recognized: true,
      measurements,
      window: {
        id: identity.id,
        label: identity.label,
        kind: identity.kind,
        ...measurements,
        ...(identity.windowSeconds !== undefined
          ? { windowSeconds: identity.windowSeconds }
          : {}),
      },
    };
  }

  return {
    recognized: false,
    measurements,
    window: unknownWindow(measurements, index),
  };
}

function identifyWindow(
  type: string | undefined,
  unit: number | undefined,
  number: number | undefined,
):
  | {
      id: string;
      label: string;
      kind: QuotaWindow["kind"];
      windowSeconds?: number;
    }
  | undefined {
  if (type === "TOKENS_LIMIT" && unit === 3 && number === 5) {
    return {
      id: "five_hour",
      label: "session",
      kind: "session",
      windowSeconds: FIVE_HOURS_SECONDS,
    };
  }
  if (type === "TOKENS_LIMIT" && unit === 6 && number === 1) {
    return {
      id: "weekly",
      label: "week",
      kind: "weekly",
      windowSeconds: WEEK_SECONDS,
    };
  }
  if (type === "TIME_LIMIT") {
    return { id: "mcp_month", label: "MCP month", kind: "monthly" };
  }
  return undefined;
}

function resolvePercentUsed(
  entry: Record<string, unknown>,
): number | undefined {
  const percentage = numericScalar(entry.percentage);
  if (percentage !== undefined) return clampPercent(percentage);
  const currentValue = numericScalar(entry.currentValue);
  const usage = numericScalar(entry.usage);
  if (usage !== undefined && usage > 0 && currentValue !== undefined) {
    return clampPercent((currentValue / usage) * 100);
  }
  return undefined;
}

function resolveResetsAt(value: unknown): string | undefined {
  const epochMs = numericScalar(value);
  if (epochMs === undefined || !Number.isFinite(epochMs)) return undefined;
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return undefined;
  }
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
  if (!/^[A-Za-z]/.test(raw)) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  try {
    return new Date(parsed).toISOString();
  } catch {
    return undefined;
  }
}

function extractKey(entry: unknown): string | undefined {
  if (typeof entry === "string") return usableLiteralSecret(entry);
  const obj = objectValue(entry);
  if (!obj) return undefined;
  for (const key of CREDENTIAL_KEYS) {
    const value = usableLiteralSecret(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
      new ZaiFailure("request_timeout", { staleEligible: true }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new ZaiFailure("request_timeout", { staleEligible: true }));
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

class ZaiFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: ZaiFailureOptions = {}) {
    super(code);
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible ?? false;
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.retryAfter = options.retryAfter;
  }
}
