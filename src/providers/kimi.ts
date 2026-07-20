import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
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
import {
  createPiKimiCredentialBroker,
  type KimiCredentialBroker,
  type KimiCredentialResolution,
} from "./pi-kimi-credential.js";

const KIMI_QUOTA_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_CREDENTIAL_SOURCE = "pi:kimi-coding";
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
  | { code: "limits_invalid" }
  | { code: "detail_invalid"; index: number };

export type NormalizedKimiPayload = {
  windows: QuotaWindow[];
  diagnostics: KimiDiagnostic[];
};

type KimiDependencies = {
  broker: KimiCredentialBroker;
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

export function createKimiAdapter(
  overrides: Partial<KimiDependencies> = {},
): ProviderAdapter {
  const dependencies: KimiDependencies = {
    broker: createPiKimiCredentialBroker(),
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
      let inspection;
      try {
        inspection = await dependencies.broker.inspect();
      } catch {
        inspection = "error" as const;
      }
      if (inspection === "available") {
        return {
          provider: "kimi",
          sources: [{ source: KIMI_CREDENTIAL_SOURCE, status: "available" }],
        };
      }
      const error =
        inspection === "unsupported"
          ? "unsupported_credential_type"
          : inspection === "error"
            ? "credential_resolution_failed"
            : undefined;
      return {
        provider: "kimi",
        sources: [
          {
            source: KIMI_CREDENTIAL_SOURCE,
            status: error ? "invalid" : "missing",
            ...(error ? { error } : {}),
          },
        ],
      };
    },
  };
}

export const kimiAdapter = createKimiAdapter();

async function acquireKimiQuota(
  dependencies: KimiDependencies,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  let attempts: SourceAttempt[] = [];

  try {
    const resolution = await resolveCredential(
      dependencies.broker,
      controller.signal,
    );
    if (resolution.status !== "available") {
      const credentialFailure = credentialFailureFor(resolution);
      attempts = [
        {
          source: KIMI_CREDENTIAL_SOURCE,
          status: resolution.status === "error" ? "failed" : "skipped",
          error: credentialFailure.code,
        },
      ];
      return failureReport(credentialFailure, attempts, dependencies);
    }

    const apiKey = resolution.apiKey;
    attempts = [{ source: KIMI_CREDENTIAL_SOURCE, status: "failed" }];
    const payload = await requestKimiQuota(
      apiKey,
      controller.signal,
      dependencies.fetch,
      dependencies.now,
    );
    const normalized = normalizeKimiPayload(payload);
    const refreshedAt = new Date(dependencies.now()).toISOString();
    attempts[0] = { source: KIMI_CREDENTIAL_SOURCE, status: "success" };
    return {
      provider: "kimi",
      label: "Kimi",
      source: "api",
      windows: normalized.windows,
      state: {
        status: "fresh",
        stale: false,
        refreshedAt,
        sourcesTried: [KIMI_CREDENTIAL_SOURCE],
      },
      attempts,
    };
  } catch (error) {
    const failure =
      error instanceof KimiFailure
        ? error
        : new KimiFailure("credential_resolution_failed", {
            staleEligible: true,
          });
    if (attempts.length === 0) {
      attempts = [
        {
          source: KIMI_CREDENTIAL_SOURCE,
          status: "failed",
          error: failure.code,
        },
      ];
    } else {
      attempts[attempts.length - 1] = {
        source: KIMI_CREDENTIAL_SOURCE,
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
  if (resolution.status === "error") {
    return new KimiFailure("credential_resolution_failed", {
      staleEligible: true,
    });
  }
  return new KimiFailure("credential_resolution_failed", {
    staleEligible: true,
  });
}

function failureReport(
  failure: KimiFailure,
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

  if (failure.staleEligible) {
    try {
      const cached = dependencies.readCachedProvider("kimi");
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
      sourcesTried: [KIMI_CREDENTIAL_SOURCE],
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
      sourcesTried: [KIMI_CREDENTIAL_SOURCE, "cache"],
    },
    attempts,
  };
}

async function requestKimiQuota(
  apiKey: string,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await waitForDeadline(
      fetchImplementation(KIMI_QUOTA_URL, {
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
    bytes = await readBoundedBody(response, signal);
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
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      void response.body?.cancel().catch(() => undefined);
      throw new KimiFailure("response_too_large", { staleEligible: true });
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readBodyChunk(reader, signal);
      if (done) break;
      length += value.length;
      if (length > RESPONSE_LIMIT_BYTES) {
        void reader.cancel().catch(() => undefined);
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

function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    void reader.cancel().catch(() => undefined);
    return Promise.reject(
      new KimiFailure("request_timeout", { staleEligible: true }),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new KimiFailure("request_timeout", { staleEligible: true }));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
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
      ...(principal.resetsAt ? { resetsAt: principal.resetsAt } : {}),
    },
  ];
  const diagnostics: KimiDiagnostic[] = [];
  const limitsValue = root.limits;
  if (
    limitsValue !== undefined &&
    limitsValue !== null &&
    !Array.isArray(limitsValue)
  ) {
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
