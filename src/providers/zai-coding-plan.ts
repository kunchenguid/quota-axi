import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { clampPercent, retryAfterToIso } from "../lib/time.js";
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
  servableStaleWindows,
  servableUntrustedWindowIds,
  withRemaining,
} from "./common.js";
import {
  createPiZaiCredentialBroker,
  type ZaiCredentialBroker,
  type ZaiCredentialResolution,
} from "./pi-zai-credential.js";
import {
  createZaiApiKeyCredentialSource,
  ZAI_API_KEY_CREDENTIAL_SOURCE,
  type ZaiApiKeyCredentialResolution,
  type ZaiApiKeyCredentialSource,
} from "./zai-api-key-credential.js";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const PI_ZAI_CREDENTIAL_SOURCE = "pi:zai";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const USER_AGENT = `quota-axi/${VERSION}`;

const zaiCodingPlanProviderFetch: typeof globalThis.fetch = (input, init) =>
  providerFetch(input, init, { retryOverIpv4: true });

/**
 * Window recognition mirrors upstream `zai`'s vocabulary: token and credit
 * limits are identified by the endpoint's own `(type, unit, number)` magic
 * values (`3`/`5` and `6`/`1`), while any `TIME_LIMIT` is the monthly
 * MCP/web-tool window regardless of its unit and number. Any other
 * combination degrades to `kind: "unknown"` with no invented
 * `windowSeconds`.
 */
type RecognizedWindow = {
  id: string;
  label: string;
  kind: QuotaWindow["kind"];
  windowSeconds?: number;
};

function recognizeWindow(
  type: string,
  unit: number,
  count: number,
): RecognizedWindow | undefined {
  if (
    (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") &&
    unit === 3 &&
    count === 5
  ) {
    return {
      id: "five_hour",
      label: "session",
      kind: "session",
      windowSeconds: FIVE_HOUR_SECONDS,
    };
  }
  if (
    (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") &&
    unit === 6 &&
    count === 1
  ) {
    return {
      id: "weekly",
      label: "week",
      kind: "weekly",
      windowSeconds: WEEK_SECONDS,
    };
  }
  if (type === "TIME_LIMIT") {
    // A calendar month has no fixed duration, so windowSeconds is
    // deliberately omitted rather than approximated.
    return { id: "mcp_month", label: "mcp", kind: "monthly" };
  }
  return undefined;
}

export type ZaiDiagnostic = { code: "limit_invalid"; index: number };

export type NormalizedZaiQuota = {
  windows: QuotaWindow[];
  diagnostics: ZaiDiagnostic[];
  plan?: string;
};

type ZaiDependencies = {
  broker: ZaiCredentialBroker;
  apiKeySource: ZaiApiKeyCredentialSource;
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

export function createZaiCodingPlanAdapter(
  overrides: Partial<ZaiDependencies> = {},
): ProviderAdapter {
  const dependencies: ZaiDependencies = {
    broker: createPiZaiCredentialBroker(),
    apiKeySource: createZaiApiKeyCredentialSource(),
    fetch: zaiCodingPlanProviderFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "zai-coding-plan",
    label: "Z.ai Coding Plan",
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireZaiQuota(dependencies).finally(() => {
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
            ? "pi_zai_credential_expired"
            : piInspection === "error"
              ? "credential_resolution_failed"
              : undefined;

      let envInspection;
      try {
        envInspection = await dependencies.apiKeySource.inspect();
      } catch {
        envInspection = "missing" as const;
      }

      return {
        provider: "zai-coding-plan",
        sources: [
          {
            source: PI_ZAI_CREDENTIAL_SOURCE,
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
            source: ZAI_API_KEY_CREDENTIAL_SOURCE,
            status: envInspection,
          },
        ],
      };
    },
  };
}

export const zaiCodingPlanAdapter = createZaiCodingPlanAdapter();

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
    const piResolution = await resolveCredential(
      dependencies.broker,
      controller.signal,
    );
    let credential: string;
    let credentialSource: string;

    if (piResolution.status === "available") {
      credential = piResolution.credential;
      credentialSource = PI_ZAI_CREDENTIAL_SOURCE;
      attempts = [{ source: credentialSource, status: "failed" }];
    } else {
      const piFailure = credentialFailureFor(piResolution);
      attempts = [
        {
          source: PI_ZAI_CREDENTIAL_SOURCE,
          status: piResolution.status === "error" ? "failed" : "skipped",
          error: piFailure.code,
        },
      ];
      if (piResolution.status === "error") {
        return failureReport(piFailure, attempts, dependencies);
      }

      attempts.push({
        source: ZAI_API_KEY_CREDENTIAL_SOURCE,
        status: "failed",
      });
      const envResolution = await resolveApiKeyCredential(
        dependencies.apiKeySource,
        controller.signal,
      );
      if (envResolution.status !== "available") {
        attempts[attempts.length - 1] = {
          source: ZAI_API_KEY_CREDENTIAL_SOURCE,
          status: "skipped",
          error: "zai_api_key_unavailable",
        };
        return failureReport(piFailure, attempts, dependencies);
      }
      credential = envResolution.apiKey;
      credentialSource = ZAI_API_KEY_CREDENTIAL_SOURCE;
    }

    const outcome = await requestZaiQuota(
      credential,
      controller.signal,
      dependencies.fetch,
      dependencies.now,
    );
    const untrustedWindowIds = outcome.diagnostics.map(
      (diagnostic) => `limit:${diagnostic.index}`,
    );
    const refreshedAt = new Date(dependencies.now()).toISOString();
    attempts[attempts.length - 1] = {
      source: credentialSource,
      status: "success",
    };
    return {
      provider: "zai-coding-plan",
      label: "Z.ai Coding Plan",
      source: "api",
      ...(outcome.plan ? { plan: outcome.plan } : {}),
      windows: outcome.windows,
      state: {
        status: "fresh",
        stale: false,
        refreshedAt,
        ...(untrustedWindowIds.length > 0 ? { untrustedWindowIds } : {}),
        sourcesTried: attempts.map(({ source }) => source),
      },
      attempts,
    };
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
          source: PI_ZAI_CREDENTIAL_SOURCE,
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

async function resolveCredential(
  broker: ZaiCredentialBroker,
  signal: AbortSignal,
): Promise<ZaiCredentialResolution> {
  try {
    return await waitForDeadline(broker.resolve(), signal);
  } catch (error) {
    if (error instanceof ZaiFailure) throw error;
    throw new ZaiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
}

async function resolveApiKeyCredential(
  source: ZaiApiKeyCredentialSource,
  signal: AbortSignal,
): Promise<ZaiApiKeyCredentialResolution> {
  try {
    return await waitForDeadline(source.resolve(), signal);
  } catch (error) {
    if (error instanceof ZaiFailure) throw error;
    throw new ZaiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
}

function credentialFailureFor(
  resolution: Exclude<ZaiCredentialResolution, { status: "available" }>,
): ZaiFailure {
  if (resolution.status === "missing") {
    return new ZaiFailure("zai_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "unsupported") {
    return new ZaiFailure("unsupported_credential_type", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "expired") {
    return new ZaiFailure("pi_zai_credential_expired", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "error") {
    return new ZaiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
  return new ZaiFailure("credential_resolution_failed", {
    staleEligible: true,
  });
}

function failureReport(
  failure: ZaiFailure,
  attempts: SourceAttempt[],
  dependencies: ZaiDependencies,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("zai-coding-plan");
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = dependencies.readCachedProvider("zai-coding-plan");
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
    provider: "zai-coding-plan",
    label: "Z.ai Coding Plan",
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
    cached.provider !== "zai-coding-plan" ||
    cached.source !== "api" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  ) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(cached.state.refreshedAt))) return undefined;
  const windows = servableStaleWindows(cached, now);
  if (windows.length === 0) return undefined;
  const untrustedWindowIds = servableUntrustedWindowIds(cached, windows);

  return {
    provider: "zai-coding-plan",
    label: "Z.ai Coding Plan",
    source: "cache",
    ...(cached.plan ? { plan: cached.plan } : {}),
    windows,
    state: {
      status: "stale",
      stale: true,
      refreshedAt: cached.state.refreshedAt,
      error,
      ...(retryAfter ? { retryAfter } : {}),
      ...(untrustedWindowIds ? { untrustedWindowIds } : {}),
      sourcesTried: [...attempts.map(({ source }) => source), "cache"],
    },
    attempts,
  };
}

type ZaiEnvelope = {
  code: number;
  success: boolean;
  data?: Record<string, unknown>;
};

async function requestZaiQuota(
  apiKey: string,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
): Promise<NormalizedZaiQuota> {
  let response: Response;
  try {
    response = await waitForDeadline(
      fetchImplementation(ZAI_QUOTA_URL, {
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
      throw new ZaiFailure("request_timeout", { staleEligible: true });
    }
    throw new ZaiFailure(localTransportCode(error), {
      staleEligible: true,
    });
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

    // Every documented outcome (success or auth failure) is HTTP 200 with a
    // {code, msg, success} envelope. An empty body, an undecodable body, an
    // unparseable body, or a body with no recognizable envelope fields is
    // not a provider answer at all -- parseZaiEnvelope throws a
    // stale-eligible failure for those so a captive portal or a broken
    // transport can't retire a good cached snapshot. Only a parsed envelope
    // that legitimately carries no limits (see normalizeZaiLimits) is a
    // fresh report with windows: [], per the "never invent" contract.
    const envelope = parseZaiEnvelope(bytes);

    if (envelope.code === 401) {
      throw new ZaiFailure("zai_token_expired", {
        status: "auth_required",
        definitiveAuth: true,
      });
    }
    if (envelope.code === 1000) {
      throw new ZaiFailure("zai_authentication_failed", {
        status: "auth_required",
        definitiveAuth: true,
      });
    }
    if (envelope.code === 1001) {
      throw new ZaiFailure("zai_authentication_header_missing", {
        status: "auth_required",
        definitiveAuth: true,
      });
    }
    if (envelope.code === 200 && envelope.success) {
      return normalizeZaiLimits(envelope.data);
    }
    // An unexpected (code, success) combination is a genuinely surprising
    // response shape, not "nothing useful in the body" -- degrade to a
    // clear error rather than guessing at a new envelope variant.
    throw new ZaiFailure("unexpected_response_shape", {
      staleEligible: true,
    });
  } finally {
    await lifetime.cancel();
  }
}

function parseZaiEnvelope(bytes: Uint8Array): ZaiEnvelope {
  if (bytes.length === 0) {
    throw new ZaiFailure("zai_empty_response", { staleEligible: true });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ZaiFailure("zai_response_invalid_utf8", { staleEligible: true });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ZaiFailure("zai_malformed_json", { staleEligible: true });
  }
  const root = objectValue(parsed);
  const code = root ? numericScalar(root.code) : undefined;
  if (!root || code === undefined) {
    throw new ZaiFailure("zai_unrecognized_envelope", { staleEligible: true });
  }
  return {
    code,
    success: root.success === true,
    data: objectValue(root.data),
  };
}

export function normalizeZaiLimits(
  data: Record<string, unknown> | undefined,
): NormalizedZaiQuota {
  const plan = stringValue(data?.level);
  const limitsValue = data?.limits;
  if (!Array.isArray(limitsValue)) {
    return { windows: [], diagnostics: [], ...(plan ? { plan } : {}) };
  }

  const windows: QuotaWindow[] = [];
  const diagnostics: ZaiDiagnostic[] = [];
  limitsValue.forEach((rawEntry, offset) => {
    const index = offset + 1;
    const entry = objectValue(rawEntry);
    const type = entry ? stringValue(entry.type) : undefined;
    const unit = entry ? numericScalar(entry.unit) : undefined;
    const count = entry ? numericScalar(entry.number) : undefined;
    const percentage = entry ? numericScalar(entry.percentage) : undefined;
    if (
      type === undefined ||
      unit === undefined ||
      count === undefined ||
      percentage === undefined
    ) {
      diagnostics.push({ code: "limit_invalid", index });
      return;
    }
    const recognized = recognizeWindow(type, unit, count);
    const resetsAt = msEpochToIso(entry?.nextResetTime);
    windows.push(
      withRemaining({
        id: recognized?.id ?? `limit:${index}`,
        label: recognized?.label ?? `limit ${index}`,
        kind: recognized?.kind ?? "unknown",
        percentUsed: clampPercent(percentage),
        ...(resetsAt ? { resetsAt } : {}),
        ...(recognized?.windowSeconds !== undefined
          ? { windowSeconds: recognized.windowSeconds }
          : {}),
      }),
    );
  });

  return { windows, diagnostics, ...(plan ? { plan } : {}) };
}

function msEpochToIso(value: unknown): string | undefined {
  const ms = numericScalar(value);
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function numericScalar(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
      retryAfter: retryAfterToIso(
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
