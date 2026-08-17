import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { retryAfterToIso } from "../lib/time.js";
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
import { sourceNames, staleFromCache } from "./common.js";
import {
  createPiZaiCredentialBroker,
  type ZaiCredentialBroker,
  type ZaiCredentialResolution,
} from "./pi-zai-credential.js";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const PI_ZAI_CREDENTIAL_SOURCE = "pi:zai";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const FIVE_HOURS_SECONDS = 5 * HOUR_SECONDS;
const USER_AGENT = `quota-axi/${VERSION}`;

/**
 * z.ai identifies a limit by `(unit, number)`, not by name. Only hour, day and
 * week units have a fixed duration; the month unit deliberately has none,
 * because calendar months are not a trusted 30-day cycle.
 */
const UNIT_SECONDS: Record<number, number> = {
  3: HOUR_SECONDS,
  4: DAY_SECONDS,
  6: WEEK_SECONDS,
};

const UNIT_SUFFIX: Record<number, string> = {
  3: "h",
  4: "d",
  5: "mo",
  6: "w",
};

const KNOWN_LIMIT_TYPES = ["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"];

export type ZaiDiagnostic =
  | { code: "limit_unrecognized"; index: number }
  | { code: "limit_invalid"; index: number };

export type NormalizedZaiPayload = {
  plan?: string;
  windows: QuotaWindow[];
  diagnostics: ZaiDiagnostic[];
};

type ZaiDependencies = {
  broker: ZaiCredentialBroker;
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

type WindowIdentity = {
  id: string;
  label: string;
  kind: QuotaWindow["kind"];
  windowSeconds?: number;
  trusted: boolean;
};

export function createZaiAdapter(
  overrides: Partial<ZaiDependencies> = {},
): ProviderAdapter {
  const dependencies: ZaiDependencies = {
    broker: createPiZaiCredentialBroker(),
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
      let inspection: ZaiCredentialResolution["status"];
      try {
        inspection = await dependencies.broker.inspect();
      } catch {
        inspection = "error";
      }
      const error =
        inspection === "unsupported"
          ? "unsupported_credential_type"
          : inspection === "expired"
            ? "pi_zai_credential_expired"
            : inspection === "error"
              ? "credential_resolution_failed"
              : undefined;
      return {
        provider: "zai",
        sources: [
          {
            source: PI_ZAI_CREDENTIAL_SOURCE,
            status:
              inspection === "available"
                ? "available"
                : inspection === "expired"
                  ? "expired"
                  : error
                    ? "invalid"
                    : "missing",
            ...(error ? { error } : {}),
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
  const attempts: SourceAttempt[] = [
    { source: PI_ZAI_CREDENTIAL_SOURCE, status: "failed" },
  ];

  try {
    const resolution = await resolveCredential(
      dependencies.broker,
      controller.signal,
    );
    if (resolution.status !== "available") {
      const failure = credentialFailureFor(resolution);
      attempts[0] = {
        source: PI_ZAI_CREDENTIAL_SOURCE,
        status: resolution.status === "error" ? "failed" : "skipped",
        error: failure.code,
      };
      return failureReport(failure, attempts, dependencies);
    }

    const payload = await requestZaiQuota(
      resolution.credential,
      controller.signal,
      dependencies.fetch,
      dependencies.now,
    );
    const normalized = normalizeZaiPayload(payload);
    const untrustedWindowIds = normalized.diagnostics.map(
      ({ code, index }) =>
        `${code === "limit_invalid" ? "invalid" : "limit"}:${index}`,
    );
    attempts[0] = { source: PI_ZAI_CREDENTIAL_SOURCE, status: "success" };
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
        sourcesTried: sourceNames(attempts),
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
    attempts[0] = {
      source: PI_ZAI_CREDENTIAL_SOURCE,
      status: "failed",
      error: failure.code,
    };
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
      dependencies.deleteCachedProvider("zai");
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = dependencies.readCachedProvider("zai");
      if (
        cached &&
        cached.provider === "zai" &&
        cached.source === "api" &&
        cached.windows.length > 0
      ) {
        return staleFromCache(
          cached,
          failure.code,
          sourceNames(attempts),
          attempts,
        );
      }
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
      sourcesTried: sourceNames(attempts),
    },
    attempts,
  };
}

async function requestZaiQuota(
  apiKey: string,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
): Promise<unknown> {
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
    throw new ZaiFailure(localTransportCode(error), { staleEligible: true });
  }

  rejectHttpFailure(response, now());
  const declaredLength = response.headers.get("content-length")?.trim();
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)
  ) {
    throw new ZaiFailure("response_too_large", { staleEligible: true });
  }

  let text: string;
  try {
    text = await waitForDeadline(response.text(), signal);
  } catch (error) {
    if (error instanceof ZaiFailure) throw error;
    if (signal.aborted || isAbortError(error)) {
      throw new ZaiFailure("request_timeout", { staleEligible: true });
    }
    throw new ZaiFailure("network_unavailable", { staleEligible: true });
  }
  if (Buffer.byteLength(text, "utf8") > RESPONSE_LIMIT_BYTES) {
    throw new ZaiFailure("response_too_large", { staleEligible: true });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ZaiFailure("malformed_json", { staleEligible: true });
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

/**
 * Normalize z.ai's `quota/limit` envelope.
 *
 * Windows are identified by their self-described `(type, unit, number)` triple,
 * never by array position. A limit quota-axi does not recognize keeps its
 * percentage but stays an `unknown` window and is reported as untrusted, so
 * schema drift degrades the interpretation instead of inventing a relationship.
 */
export function normalizeZaiPayload(payload: unknown): NormalizedZaiPayload {
  const root = objectValue(payload);
  if (!root) {
    throw new ZaiFailure("schema_invalid", { staleEligible: true });
  }
  const code = numericScalar(root.code);
  const success = root.success;
  if (success === false || (code !== undefined && code !== 200)) {
    throw new ZaiFailure("provider_response_rejected");
  }
  if (success !== true && code === undefined) {
    throw new ZaiFailure("schema_invalid", { staleEligible: true });
  }
  const data = objectValue(root.data);
  if (!data || !Array.isArray(data.limits)) {
    throw new ZaiFailure("schema_invalid", { staleEligible: true });
  }

  const windows: QuotaWindow[] = [];
  const diagnostics: ZaiDiagnostic[] = [];
  const taken = new Set<string>();
  for (const [offset, rawEntry] of data.limits.entries()) {
    const index = offset + 1;
    const entry = objectValue(rawEntry);
    const percentUsed = entry ? normalizePercentUsed(entry) : undefined;
    if (!entry || percentUsed === undefined) {
      diagnostics.push({ code: "limit_invalid", index });
      continue;
    }
    const identity = windowIdentity(entry, index, taken);
    if (!identity.trusted)
      diagnostics.push({ code: "limit_unrecognized", index });
    taken.add(identity.id);
    windows.push({
      id: identity.id,
      label: identity.label,
      kind: identity.kind,
      percentUsed,
      percentRemaining: clampPercent(100 - percentUsed),
      ...(identity.windowSeconds !== undefined
        ? { windowSeconds: identity.windowSeconds }
        : {}),
      ...(epochMillisToIso(entry.nextResetTime)
        ? { resetsAt: epochMillisToIso(entry.nextResetTime) }
        : {}),
    });
  }

  return {
    ...(stringValue(data.level) ? { plan: stringValue(data.level) } : {}),
    windows,
    diagnostics,
  };
}

function windowIdentity(
  entry: Record<string, unknown>,
  index: number,
  taken: Set<string>,
): WindowIdentity {
  const type = stringValue(entry.type);
  const unit = numericScalar(entry.unit);
  const number = numericScalar(entry.number);
  const unrecognized: WindowIdentity = {
    id: `limit:${index}`,
    label: `limit ${index}`,
    kind: "unknown",
    trusted: false,
  };
  if (
    type === undefined ||
    !KNOWN_LIMIT_TYPES.includes(type) ||
    unit === undefined ||
    number === undefined ||
    !Number.isInteger(number) ||
    number <= 0 ||
    UNIT_SUFFIX[unit] === undefined
  ) {
    return unrecognized;
  }

  // The MCP tool-call cap is a separate workload from token spend, so it never
  // shares an identity with the model windows.
  if (type === "TIME_LIMIT") {
    return unit === 5 && number === 1
      ? {
          id: "mcp_monthly",
          label: "mcp tools",
          kind: "monthly",
          trusted: true,
        }
      : unrecognized;
  }
  if (unit === 3 && number === 5) {
    return {
      id: "five_hour",
      label: "session",
      kind: "session",
      windowSeconds: FIVE_HOURS_SECONDS,
      trusted: true,
    };
  }
  if (unit === 6 && number === 1) {
    return {
      id: "weekly",
      label: "week",
      kind: "weekly",
      windowSeconds: WEEK_SECONDS,
      trusted: true,
    };
  }

  // A recognized unit still yields an honest duration, but quota-axi does not
  // know how an unfamiliar period relates to the named ones.
  const unitSeconds = UNIT_SECONDS[unit];
  const id = `${number}${UNIT_SUFFIX[unit]}`;
  if (taken.has(id)) return unrecognized;
  return {
    id,
    label: id,
    kind: "unknown",
    ...(unitSeconds !== undefined
      ? { windowSeconds: unitSeconds * number }
      : {}),
    trusted: false,
  };
}

/**
 * `CREDIT_LIMIT` and `TIME_LIMIT` report `usage` as the allowance and
 * `currentValue` as the consumed amount; `TOKENS_LIMIT` carries only an
 * already-computed `percentage`.
 */
function normalizePercentUsed(
  entry: Record<string, unknown>,
): number | undefined {
  const limit = numericScalar(entry.usage);
  const used = numericScalar(entry.currentValue);
  if (limit !== undefined && limit > 0 && used !== undefined && used >= 0) {
    return clampPercent((used / limit) * 100);
  }
  const percentage = numericScalar(entry.percentage);
  return percentage !== undefined && percentage >= 0
    ? clampPercent(percentage)
    : undefined;
}

function epochMillisToIso(value: unknown): string | undefined {
  const millis = numericScalar(value);
  if (millis === undefined || millis <= 0) return undefined;
  try {
    return new Date(millis).toISOString();
  } catch {
    return undefined;
  }
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

/** Two decimal places keep ratio precision without float noise in the output. */
function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
