import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedElevenLabsProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { retryAfterToIso } from "../lib/time.js";
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
import { VERSION } from "../version.js";
import {
  clearElevenLabsReadingContextId,
  elevenLabsCacheContextId,
  publishElevenLabsReadingContextId,
} from "./elevenlabs-cache-context.js";

export const ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";
export const ELEVENLABS_SUBSCRIPTION_PATH = "/v1/user/subscription";

export const ELEVENLABS_API_KEY_SOURCE = "env:ELEVENLABS_API_KEY";

/**
 * Ownership-stability order. ElevenLabs publishes exactly one credential a
 * user can hand over deliberately: the key its own CLI documents
 * (`export ELEVENLABS_API_KEY=xi-...`, sent as the `xi-api-key` header).
 *
 * `elevenlabs auth login` puts an OAuth bundle in the OS keyring instead,
 * falling back to `<config dir>/elevenlabs/auth-keyring.json`. That store is
 * deliberately not read here: its entry is an opaque token bundle this tree has
 * no verified shape for, and guessing at one would risk sending the wrong
 * string as a credential.
 */
export const ELEVENLABS_SOURCE_ORDER = [ELEVENLABS_API_KEY_SOURCE] as const;

export type ElevenLabsSourceName = (typeof ELEVENLABS_SOURCE_ORDER)[number];

const LABEL = "ElevenLabs";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const USER_AGENT = `quota-axi/${VERSION}`;
const CHARACTERS_WINDOW_ID = "characters";

/**
 * The vendor's own declared character-refresh cadences. The reset instant comes
 * from `next_character_count_reset_unix`; this names how long the cycle that
 * ends there ran, so the cycle start is the reset stepped back by the vendor's
 * declared period rather than a fixed number of days. Mirrors the Cursor
 * monthly-renewal rule in `src/providers/cursor.ts`; an unrecognized value
 * leaves the cycle unresolved instead of assuming one.
 */
const REFRESH_PERIOD_MONTHS: Readonly<Record<string, number>> = {
  monthly_period: 1,
  "3_month_period": 3,
  "6_month_period": 6,
  annual_period: 12,
};

export type ElevenLabsLocalResolution =
  | { status: "resolved"; credential: string }
  | { status: "absent" }
  | { status: "structurally_invalid"; error: string };

export type ElevenLabsEnvSource = {
  name: ElevenLabsSourceName;
  resolve(): ElevenLabsLocalResolution;
  inspect(): { status: "available" | "missing" | "invalid"; error?: string };
};

export type NormalizedElevenLabsPayload = {
  plan?: string;
  windows: QuotaWindow[];
};

type ElevenLabsDependencies = {
  envSource: ElevenLabsEnvSource;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: (provider: "elevenlabs") => void;
  now: () => number;
  deadlineMs: number;
};

type ElevenLabsFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  authUsable?: boolean;
  retryAfter?: string;
};

type ResponseBodyLifetime = {
  markConsumed(): void;
  cancel(action?: () => Promise<unknown> | undefined): Promise<void>;
};

export function createElevenLabsEnvSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ElevenLabsEnvSource {
  const resolve = (): ElevenLabsLocalResolution => {
    const raw = environment.ELEVENLABS_API_KEY;
    if (raw === undefined) return { status: "absent" };
    // A blank variable selects nothing rather than reporting a broken key.
    if (raw.trim().length === 0) return { status: "absent" };
    const credential = usableLiteralSecret(raw);
    return credential !== undefined
      ? { status: "resolved", credential }
      : {
          status: "structurally_invalid",
          error: "elevenlabs_credential_invalid",
        };
  };
  return {
    name: ELEVENLABS_API_KEY_SOURCE,
    resolve,
    inspect() {
      const resolution = resolve();
      if (resolution.status === "resolved") return { status: "available" };
      if (resolution.status === "absent") return { status: "missing" };
      return { status: "invalid", error: resolution.error };
    },
  };
}

export function createElevenLabsAdapter(
  overrides: Partial<ElevenLabsDependencies> = {},
): ProviderAdapter {
  const dependencies: ElevenLabsDependencies = {
    envSource: createElevenLabsEnvSource(),
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: () => deleteCachedProviderFromDisk("elevenlabs"),
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "elevenlabs",
    label: LABEL,
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireElevenLabsQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
      return Promise.resolve(inspectAuth(dependencies));
    },
  };
}

export const elevenLabsAdapter = createElevenLabsAdapter();

function inspectAuth(dependencies: ElevenLabsDependencies): AuthProviderReport {
  let source: AuthSourceReport;
  try {
    const inspection = dependencies.envSource.inspect();
    source = {
      source: ELEVENLABS_API_KEY_SOURCE,
      path: "ELEVENLABS_API_KEY",
      status: inspection.status,
      ...(inspection.error ? { error: inspection.error } : {}),
    };
  } catch {
    source = {
      source: ELEVENLABS_API_KEY_SOURCE,
      path: "ELEVENLABS_API_KEY",
      status: "error",
      error: "credential_resolution_failed",
    };
  }
  return { provider: "elevenlabs", sources: [source] };
}

async function acquireElevenLabsQuota(
  dependencies: ElevenLabsDependencies,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  const attempts: SourceAttempt[] = [];
  let cacheContextId: string | undefined;
  clearElevenLabsReadingContextId();

  try {
    const resolution = resolveCredential(dependencies);
    if (resolution.status !== "resolved") {
      const failure = credentialFailureFor(resolution);
      attempts.push({
        source: ELEVENLABS_API_KEY_SOURCE,
        status: resolution.status === "absent" ? "skipped" : "failed",
        error: failure.code,
        ...(resolution.status === "absent" ? {} : { credentialPresent: true }),
      });
      return failureReport(failure, undefined, attempts, dependencies);
    }

    // The key is the account here, so its identity is known before the request
    // and a failed read can still serve exactly its own cached snapshot.
    cacheContextId = elevenLabsCacheContextId(
      ELEVENLABS_API_KEY_SOURCE,
      resolution.credential,
    );
    publishElevenLabsReadingContextId(cacheContextId);
    attempts.push({ source: ELEVENLABS_API_KEY_SOURCE, status: "failed" });

    try {
      const payload = await requestSubscription(
        resolution.credential,
        controller.signal,
        dependencies,
      );
      const normalized = normalizeElevenLabsPayload(
        payload,
        dependencies.now(),
      );
      attempts[attempts.length - 1] = {
        source: ELEVENLABS_API_KEY_SOURCE,
        status: "success",
      };
      return {
        provider: "elevenlabs",
        label: LABEL,
        source: "api",
        ...(normalized.plan ? { plan: normalized.plan } : {}),
        windows: normalized.windows,
        state: {
          status: "fresh",
          stale: false,
          authStatus: "usable",
          refreshedAt: new Date(dependencies.now()).toISOString(),
          sourcesTried: attempts.map(({ source }) => source),
        },
        attempts,
      };
    } catch (error) {
      const failure = asElevenLabsFailure(error);
      attempts[attempts.length - 1] = {
        source: ELEVENLABS_API_KEY_SOURCE,
        status: "failed",
        error: failure.code,
      };
      return failureReport(failure, cacheContextId, attempts, dependencies);
    }
  } catch (error) {
    const failure = asElevenLabsFailure(error);
    if (attempts.length === 0) {
      attempts.push({
        source: ELEVENLABS_API_KEY_SOURCE,
        status: "failed",
        error: failure.code,
      });
    }
    return failureReport(failure, cacheContextId, attempts, dependencies);
  } finally {
    clearTimeout(deadline);
  }
}

function resolveCredential(
  dependencies: ElevenLabsDependencies,
): ElevenLabsLocalResolution {
  try {
    return dependencies.envSource.resolve();
  } catch {
    return {
      status: "structurally_invalid",
      error: "credential_resolution_failed",
    };
  }
}

function credentialFailureFor(
  resolution: Exclude<ElevenLabsLocalResolution, { status: "resolved" }>,
): ElevenLabsFailure {
  if (resolution.status === "absent") {
    return new ElevenLabsFailure("elevenlabs_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  return new ElevenLabsFailure(resolution.error, {
    status: "auth_required",
    definitiveAuth: true,
  });
}

function failureReport(
  failure: ElevenLabsFailure,
  cacheContextId: string | undefined,
  attempts: SourceAttempt[],
  dependencies: ElevenLabsDependencies,
): ProviderQuota {
  if (failure.definitiveAuth && cacheContextId) {
    try {
      if (dependencies.readCachedProvider(cacheContextId)) {
        dependencies.deleteCachedProvider("elevenlabs");
      }
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible && cacheContextId) {
    try {
      const cached = dependencies.readCachedProvider(cacheContextId);
      const stale = cached
        ? staleElevenLabsReport(cached, failure, attempts, dependencies.now())
        : undefined;
      if (stale) return stale;
    } catch {
      // Cache I/O cannot replace the bounded current provider failure.
    }
  }

  return {
    provider: "elevenlabs",
    label: LABEL,
    source: "unavailable",
    windows: [],
    state: {
      status: failure.status,
      stale: false,
      error: failure.code,
      ...(failure.authUsable ? { authStatus: "usable" as const } : {}),
      ...(failure.definitiveAuth && !failure.authUsable
        ? { authStatus: "unusable" as const }
        : {}),
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: attempts.map(({ source }) => source),
    },
    attempts,
  };
}

function staleElevenLabsReport(
  cached: ProviderQuota,
  failure: ElevenLabsFailure,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "elevenlabs" ||
    cached.source !== "api" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  ) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(cached.state.refreshedAt))) return undefined;
  // The character allowance has no fixed duration to age against, so only a
  // window whose own reported reset is still ahead survives. A resetless
  // snapshot expires immediately rather than inventing a shelf life.
  const windows = cached.windows.filter((window) => {
    if (!window.resetsAt) return false;
    const resetsAt = Date.parse(window.resetsAt);
    return Number.isFinite(resetsAt) && resetsAt > now;
  });
  if (windows.length === 0) return undefined;

  return {
    provider: "elevenlabs",
    label: LABEL,
    source: "cache",
    ...(cached.plan ? { plan: cached.plan } : {}),
    windows,
    state: {
      status: "stale",
      stale: true,
      authStatus: failure.authUsable ? "usable" : cached.state.authStatus,
      refreshedAt: cached.state.refreshedAt,
      error: failure.code,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: [...attempts.map(({ source }) => source), "cache"],
    },
    attempts,
  };
}

async function requestSubscription(
  credential: string,
  signal: AbortSignal,
  dependencies: ElevenLabsDependencies,
): Promise<unknown> {
  const url = new URL(ELEVENLABS_SUBSCRIPTION_PATH, ELEVENLABS_API_ORIGIN).href;
  let response: Response;
  try {
    response = await waitForDeadline(
      dependencies.fetch(url, {
        method: "GET",
        headers: {
          // ElevenLabs authenticates with its own header, never `Authorization`.
          "xi-api-key": credential,
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
      throw new ElevenLabsFailure("request_timeout", { staleEligible: true });
    }
    throw new ElevenLabsFailure(localTransportCode(error), {
      staleEligible: true,
    });
  }

  const lifetime = createResponseBodyLifetime(response);
  try {
    if (response.status !== 401) {
      rejectHttpFailure(response, dependencies.now());
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, signal, lifetime);
      lifetime.markConsumed();
    } catch (error) {
      if (error instanceof ElevenLabsFailure) throw error;
      if (signal.aborted || isAbortError(error)) {
        throw new ElevenLabsFailure("request_timeout", { staleEligible: true });
      }
      throw new ElevenLabsFailure("network_unavailable", {
        staleEligible: true,
      });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      rejectHttpFailure(response, dependencies.now());
      throw new ElevenLabsFailure("response_invalid_utf8", {
        staleEligible: true,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      rejectHttpFailure(response, dependencies.now());
      throw new ElevenLabsFailure("malformed_json", { staleEligible: true });
    }
    rejectHttpFailure(response, dependencies.now(), payload);
    return payload;
  } finally {
    await lifetime.cancel();
  }
}

function rejectHttpFailure(
  response: Response,
  receivedAt: number,
  payload?: unknown,
): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new ElevenLabsFailure("redirect_rejected", { staleEligible: true });
  }
  const permissionDenied =
    status === 401 &&
    objectValue(objectValue(payload)?.detail)?.status === "missing_permissions";
  if (status === 401 && !permissionDenied) {
    throw new ElevenLabsFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (status === 403 || permissionDenied) {
    // A live key that this operation refuses: ElevenLabs keys carry scope
    // restrictions (the subscription read needs `user_read`) and an IP
    // allowlist, and either rejects the call without the key being signed out.
    // Reporting a sign-out here would be the wrong headline fact.
    throw new ElevenLabsFailure("elevenlabs_user_read_denied", {
      authUsable: true,
      staleEligible: true,
    });
  }
  if (status === 408) {
    throw new ElevenLabsFailure("provider_timeout", {
      authUsable: true,
      staleEligible: true,
    });
  }
  if (status === 429) {
    throw new ElevenLabsFailure("provider_rate_limited", {
      status: "rate_limited",
      authUsable: true,
      staleEligible: true,
      retryAfter: retryAfterToIso(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new ElevenLabsFailure("provider_unavailable", {
      authUsable: true,
      staleEligible: true,
    });
  }
  throw new ElevenLabsFailure("provider_request_rejected", {
    authUsable: true,
    staleEligible: true,
  });
}

/**
 * One `characters` window from the subscription's included allowance.
 *
 * The percentage is the only figure derived here, and only when both counters
 * are present and the limit is positive. An entitlement-only response (no
 * usable limit) returns no window rather than a fabricated percentage, matching
 * the Copilot rule. No cycle is assumed: `resetsAt` comes from the vendor's own
 * reset field and the cycle start only from the period the vendor declares.
 */
export function normalizeElevenLabsPayload(
  payload: unknown,
  now: number,
): NormalizedElevenLabsPayload {
  const root = objectValue(payload);
  if (!root) {
    throw new ElevenLabsFailure("schema_invalid", { staleEligible: true });
  }

  const plan = nonemptyString(root.tier);
  const used = nonnegativeFinite(root.character_count);
  const limit = nonnegativeFinite(root.character_limit);
  const knownShape =
    used !== undefined ||
    limit !== undefined ||
    plan !== undefined ||
    typeof root.status === "string";
  if (!knownShape) {
    throw new ElevenLabsFailure("schema_invalid", { staleEligible: true });
  }

  const windows: QuotaWindow[] = [];
  // A zero or absent limit measures nothing; `used / 0` is not 100% used.
  if (used !== undefined && limit !== undefined && limit > 0) {
    const percentUsed = Math.min(100, (used / limit) * 100);
    const resetsAt = parseResetUnix(root.next_character_count_reset_unix);
    // A reset the vendor says has already passed means these counters belong
    // to a finished cycle. The stale-cache path drops such a window; the live
    // path must too, or an expired percentage is served as current headroom.
    const expired = resetsAt !== undefined && Date.parse(resetsAt) <= now;
    const months = refreshPeriodMonths(root.character_refresh_period);
    const startsAt =
      resetsAt && months !== undefined
        ? stepBackMonths(resetsAt, months)
        : undefined;
    if (!expired)
      windows.push({
        id: CHARACTERS_WINDOW_ID,
        label: "characters",
        kind: months === 1 ? "monthly" : "unknown",
        percentUsed,
        percentRemaining: Math.max(0, ((limit - used) / limit) * 100),
        ...(startsAt ? { startsAt } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
  }

  return { ...(plan ? { plan } : {}), windows };
}

function refreshPeriodMonths(value: unknown): number | undefined {
  return typeof value === "string" ? REFRESH_PERIOD_MONTHS[value] : undefined;
}

function parseResetUnix(value: unknown): string | undefined {
  const minResetMs = 1_000_000_000_000;
  const seconds = nonnegativeFinite(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || ms < minResetMs) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Cycle start = the reported reset stepped back by the vendor's declared
 * refresh period, clamped into a shorter month so 31 March never becomes
 * 3 March. Same rule as Cursor's renewal-dated monthly pools; never a fixed
 * day count.
 */
function stepBackMonths(resetsAt: string, months: number): string | undefined {
  const reset = new Date(resetsAt);
  const time = reset.getTime();
  if (!Number.isFinite(time)) return undefined;
  const day = reset.getUTCDate();
  const start = new Date(time);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const daysInMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, daysInMonth));
  return start.getTime() < time ? start.toISOString() : undefined;
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      throw new ElevenLabsFailure("response_too_large", {
        staleEligible: true,
      });
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
        throw new ElevenLabsFailure("response_too_large", {
          staleEligible: true,
        });
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
    throw new ElevenLabsFailure("request_timeout", { staleEligible: true });
  }
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      cancelReader().then(() => {
        reject(
          new ElevenLabsFailure("request_timeout", { staleEligible: true }),
        );
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

function waitForDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new ElevenLabsFailure("request_timeout", { staleEligible: true }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new ElevenLabsFailure("request_timeout", { staleEligible: true }));
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

function asElevenLabsFailure(error: unknown): ElevenLabsFailure {
  return error instanceof ElevenLabsFailure
    ? error
    : new ElevenLabsFailure("credential_resolution_failed");
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

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class ElevenLabsFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly authUsable: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: ElevenLabsFailureOptions = {}) {
    super(code);
    this.name = "ElevenLabsFailure";
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible === true;
    this.definitiveAuth = options.definitiveAuth === true;
    this.authUsable = options.authUsable === true;
    this.retryAfter = options.retryAfter;
  }
}
