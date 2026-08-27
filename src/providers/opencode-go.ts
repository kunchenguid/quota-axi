import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { parseEpochOrIso } from "../lib/time.js";
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
  OPENCODE_AUTH_SOURCE,
  opencodeAuthFilePath,
  readOpencodeAuthFile,
} from "./opencode-auth.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const USER_AGENT = `quota-axi/${VERSION}`;
export type OpencodeGoDiagnostic = {
  windowId: string;
  code: "usage_missing" | "usage_invalid" | "usage_not_ok";
};

export type NormalizedOpencodeGoPayload = {
  windows: QuotaWindow[];
  diagnostics: OpencodeGoDiagnostic[];
  useBalance?: boolean;
};

export type OpencodeGoCredentialResolution =
  | { status: "available"; apiKey: string; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export type OpencodeGoCredentialInspection =
  | { status: "available"; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export type OpencodeGoCredentialSource = {
  resolve(): OpencodeGoCredentialResolution;
  inspect(): OpencodeGoCredentialInspection;
};

export type OpencodeGoDependencies = {
  credentialSource: OpencodeGoCredentialSource;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

type OpencodeGoFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  retryAfter?: string;
};

type ResponseBodyLifetime = {
  markConsumed(): void;
  cancel(action?: () => Promise<unknown> | undefined): Promise<void>;
};

type OpencodeGoUsageWindowResponse = {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
};

type OpencodeGoUsageResponse = {
  usage?: {
    rolling?: OpencodeGoUsageWindowResponse;
    weekly?: OpencodeGoUsageWindowResponse;
    monthly?: OpencodeGoUsageWindowResponse;
    [windowId: string]: unknown;
  };
  useBalance?: unknown;
};

type OpencodeGoUsageAcquisition = {
  payload: OpencodeGoUsageResponse;
  completedAt: number;
};

export function extractOpencodeGoCredential(
  value: unknown,
  path: string,
): OpencodeGoCredentialResolution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid", path, error: "json_parse_error" };
  }
  const entry = (value as Record<string, unknown>)["opencode-go"];
  if (entry === undefined || entry === null) return { status: "missing", path };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { status: "invalid", path, error: "opencode_go_credential_invalid" };
  }
  const record = entry as Record<string, unknown>;
  const apiKey = usableLiteralSecret(record.key);
  if (record.type !== "api" || apiKey === undefined) {
    return { status: "invalid", path, error: "opencode_go_credential_invalid" };
  }
  return { status: "available", apiKey, path };
}

export function createOpencodeGoCredentialSource(
  filePath: () => string = opencodeAuthFilePath,
): OpencodeGoCredentialSource {
  function resolve(): OpencodeGoCredentialResolution {
    const path = filePath();
    const result = readOpencodeAuthFile(path);
    if (result.status === "missing") return { status: "missing", path };
    if (result.status === "invalid") {
      return result.error === "file_read_error"
        ? { status: "error", path, error: result.error }
        : { status: "invalid", path, error: result.error };
    }
    return extractOpencodeGoCredential(result.value, path);
  }
  return {
    resolve,
    inspect(): OpencodeGoCredentialInspection {
      const resolution = resolve();
      if (resolution.status === "available")
        return { status: "available", path: resolution.path };
      return resolution;
    },
  };
}

export function createOpencodeGoAdapter(
  overrides: Partial<OpencodeGoDependencies> = {},
): ProviderAdapter {
  const dependencies: OpencodeGoDependencies = {
    credentialSource: createOpencodeGoCredentialSource(),
    fetch: globalThis.fetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "opencode-go",
    label: "OpenCode Go",
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireOpencodeGoQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    async inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
      const inspection = dependencies.credentialSource.inspect();
      const source: AuthSourceReport = {
        source: OPENCODE_AUTH_SOURCE,
        path: inspection.path,
        status: inspection.status,
        ...(inspection.status === "invalid" || inspection.status === "error"
          ? { error: inspection.error }
          : {}),
      };
      return { provider: "opencode-go", sources: [source] };
    },
  };
}

export const opencodeGoAdapter = createOpencodeGoAdapter();

async function acquireOpencodeGoQuota(
  dependencies: OpencodeGoDependencies,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  let attempts: SourceAttempt[] = [];

  try {
    const resolution = dependencies.credentialSource.resolve();
    attempts = [{ source: OPENCODE_AUTH_SOURCE, status: "failed" }];
    if (resolution.status !== "available") {
      const failure = credentialFailureFor(resolution);
      attempts[0] = {
        source: OPENCODE_AUTH_SOURCE,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.code,
      };
      return failureReport(failure, attempts, dependencies);
    }

    const acquisition = await requestOpencodeGoUsage(
      resolution.apiKey,
      controller.signal,
      dependencies.fetch,
      dependencies.now,
    );
    const normalized = normalizeOpencodeGoPayload(
      acquisition.payload,
      acquisition.completedAt,
    );
    const untrustedWindowIds = normalized.diagnostics.map(
      ({ windowId }) => windowId,
    );
    const refreshedAt = new Date(acquisition.completedAt).toISOString();
    attempts[0] = { source: OPENCODE_AUTH_SOURCE, status: "success" };
    return {
      provider: "opencode-go",
      label: "OpenCode Go",
      source: "api",
      plan: "go",
      ...(normalized.useBalance === undefined
        ? {}
        : { useBalance: normalized.useBalance }),
      windows: normalized.windows,
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
      error instanceof OpencodeGoFailure
        ? error
        : new OpencodeGoFailure("credential_resolution_failed", {
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
      attempts[0] = {
        source: OPENCODE_AUTH_SOURCE,
        status: "failed",
        error: failure.code,
      };
    }
    return failureReport(failure, attempts, dependencies);
  } finally {
    clearTimeout(deadline);
  }
}

function credentialFailureFor(
  resolution: Exclude<OpencodeGoCredentialResolution, { status: "available" }>,
): OpencodeGoFailure {
  if (resolution.status === "missing") {
    return new OpencodeGoFailure("opencode_go_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "invalid") {
    return new OpencodeGoFailure(resolution.error, {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  return new OpencodeGoFailure("credential_resolution_failed", {
    staleEligible: true,
  });
}

function failureReport(
  failure: OpencodeGoFailure,
  attempts: SourceAttempt[],
  dependencies: OpencodeGoDependencies,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("opencode-go");
    } catch {
      // A definitive current auth result still stands if cache cleanup fails.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = dependencies.readCachedProvider("opencode-go");
      const stale = cached
        ? staleOpencodeGoReport(
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
    provider: "opencode-go",
    label: "OpenCode Go",
    source: "unavailable",
    plan: "go",
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

function staleOpencodeGoReport(
  cached: ProviderQuota,
  error: string,
  retryAfter: string | undefined,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "opencode-go" ||
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
      return false;
    }
    if (window.id === "five_hour")
      return ageMilliseconds < FIVE_HOURS_SECONDS * 1_000;
    if (window.id === "weekly") return ageMilliseconds < WEEK_SECONDS * 1_000;
    return false;
  });
  if (windows.length === 0) return undefined;

  return {
    provider: "opencode-go",
    label: "OpenCode Go",
    source: "cache",
    plan: "go",
    ...(cached.useBalance === undefined
      ? {}
      : { useBalance: cached.useBalance }),
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

async function requestOpencodeGoUsage(
  apiKey: string,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
): Promise<OpencodeGoUsageAcquisition> {
  let response: Response;
  try {
    response = await waitForDeadline(
      fetchImplementation(OPENCODE_GO_USAGE_URL, {
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
      throw new OpencodeGoFailure("request_timeout", { staleEligible: true });
    }
    throw new OpencodeGoFailure(localTransportCode(error), {
      staleEligible: true,
    });
  }

  const lifetime = createResponseBodyLifetime(response);
  try {
    const headerReceivedAt = now();
    rejectHttpFailure(response, headerReceivedAt);
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      throw new OpencodeGoFailure("unexpected_content_type", {
        staleEligible: true,
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, signal, lifetime);
      lifetime.markConsumed();
    } catch (error) {
      if (error instanceof OpencodeGoFailure) throw error;
      if (signal.aborted || isAbortError(error)) {
        throw new OpencodeGoFailure("request_timeout", {
          staleEligible: true,
        });
      }
      throw new OpencodeGoFailure("network_unavailable", {
        staleEligible: true,
      });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new OpencodeGoFailure("response_invalid_utf8", {
        staleEligible: true,
      });
    }
    if (duplicateJsonKeys(text).length > 0) {
      throw new OpencodeGoFailure("schema_invalid", {
        staleEligible: true,
      });
    }
    try {
      return {
        payload: JSON.parse(text) as OpencodeGoUsageResponse,
        completedAt: now(),
      };
    } catch {
      throw new OpencodeGoFailure("malformed_json", { staleEligible: true });
    }
  } finally {
    void lifetime.cancel();
  }
}

function rejectHttpFailure(response: Response, receivedAt: number): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new OpencodeGoFailure("redirect_rejected");
  }
  if (status === 401) {
    throw new OpencodeGoFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (status === 403) {
    throw new OpencodeGoFailure("provider_entitlement_required", {
      status: "auth_required",
    });
  }
  if (status === 408) {
    throw new OpencodeGoFailure("provider_timeout", { staleEligible: true });
  }
  if (status === 429) {
    throw new OpencodeGoFailure("provider_rate_limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: normalizeRetryAfter(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new OpencodeGoFailure("provider_unavailable", {
      staleEligible: true,
    });
  }
  throw new OpencodeGoFailure("provider_request_rejected");
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      throw new OpencodeGoFailure("response_too_large", {
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
        throw new OpencodeGoFailure("response_too_large", {
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
    void cancelReader();
    throw new OpencodeGoFailure("request_timeout", { staleEligible: true });
  }
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      void cancelReader();
      reject(new OpencodeGoFailure("request_timeout", { staleEligible: true }));
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

export function normalizeOpencodeGoPayload(
  payload: unknown,
  receivedAt: number,
): NormalizedOpencodeGoPayload {
  const root = objectValue(payload);
  const usage = objectValue(root?.usage);
  if (!root || !usage) {
    throw new OpencodeGoFailure("schema_invalid", { staleEligible: true });
  }
  if (
    Object.prototype.hasOwnProperty.call(root, "useBalance") &&
    typeof root.useBalance !== "boolean"
  ) {
    throw new OpencodeGoFailure("schema_invalid", { staleEligible: true });
  }
  const diagnostics: OpencodeGoDiagnostic[] = [];
  const windows: QuotaWindow[] = [];
  const definitions = [
    {
      id: "five_hour" as const,
      label: "session",
      kind: "session" as const,
      seconds: FIVE_HOURS_SECONDS,
      key: "rolling",
    },
    {
      id: "weekly" as const,
      label: "week",
      kind: "weekly" as const,
      seconds: WEEK_SECONDS,
      key: "weekly",
    },
    {
      id: "monthly" as const,
      label: "month",
      kind: "monthly" as const,
      seconds: undefined,
      key: "monthly",
    },
  ];

  for (const definition of definitions) {
    const raw = usage[definition.key];
    if (raw === undefined || raw === null) {
      diagnostics.push({ windowId: definition.id, code: "usage_missing" });
      continue;
    }
    const detail = objectValue(raw);
    if (!detail) {
      diagnostics.push({ windowId: definition.id, code: "usage_invalid" });
      continue;
    }
    if (detail.status !== "ok") {
      diagnostics.push({ windowId: definition.id, code: "usage_not_ok" });
      continue;
    }
    const percentUsed = numericScalar(detail.percent);
    const resetMilliseconds =
      typeof detail.resetsAt === "string"
        ? Date.parse(detail.resetsAt)
        : Number.NaN;
    const resetsAt =
      Number.isFinite(resetMilliseconds) && resetMilliseconds > receivedAt
        ? parseEpochOrIso(detail.resetsAt)
        : undefined;
    if (
      percentUsed === undefined ||
      percentUsed < 0 ||
      percentUsed > 100 ||
      resetsAt === undefined
    ) {
      diagnostics.push({ windowId: definition.id, code: "usage_invalid" });
      continue;
    }
    windows.push({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      percentUsed,
      percentRemaining: 100 - percentUsed,
      resetsAt,
      ...(definition.seconds !== undefined
        ? { windowSeconds: definition.seconds }
        : {}),
    });
  }
  for (const key of Object.keys(usage)) {
    if (!definitions.some(({ key: knownKey }) => knownKey === key)) {
      diagnostics.push({
        windowId: `unknown:${key}`,
        code: "usage_invalid",
      });
    }
  }

  if (windows.length === 0) {
    throw new OpencodeGoFailure("schema_invalid", { staleEligible: true });
  }
  const useBalance = root.useBalance as boolean | undefined;
  return {
    windows,
    diagnostics,
    ...(useBalance === undefined ? {} : { useBalance }),
  };
}

function duplicateJsonKeys(text: string): string[] {
  const duplicates = new Set<string>();
  skipJsonValue(text, 0, duplicates);
  return [...duplicates];
}

const JSON_SCALAR_PATTERN =
  /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

function skipJsonValue(
  text: string,
  start: number,
  duplicates?: Set<string>,
): number | undefined {
  let index = skipJsonWhitespace(text, start);
  if (text[index] === '"') return scanJsonString(text, index)?.next;
  if (text[index] === "{") {
    const seen = new Set<string>();
    index = skipJsonWhitespace(text, index + 1);
    if (text[index] === "}") return index + 1;
    while (index < text.length) {
      const key = scanJsonString(text, index);
      if (!key) return undefined;
      if (seen.has(key.value)) duplicates?.add(key.value);
      seen.add(key.value);
      index = skipJsonWhitespace(text, key.next);
      if (text[index] !== ":") return undefined;
      const valueEnd = skipJsonValue(text, index + 1, duplicates);
      if (valueEnd === undefined) return undefined;
      index = skipJsonWhitespace(text, valueEnd);
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",") return undefined;
      index = skipJsonWhitespace(text, index + 1);
    }
    return undefined;
  }
  if (text[index] === "[") {
    index = skipJsonWhitespace(text, index + 1);
    if (text[index] === "]") return index + 1;
    while (index < text.length) {
      const valueEnd = skipJsonValue(text, index, duplicates);
      if (valueEnd === undefined) return undefined;
      index = skipJsonWhitespace(text, valueEnd);
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",") return undefined;
      index = skipJsonWhitespace(text, index + 1);
    }
    return undefined;
  }
  JSON_SCALAR_PATTERN.lastIndex = index;
  const scalar = JSON_SCALAR_PATTERN.exec(text);
  return scalar ? index + scalar[0].length : undefined;
}

function scanJsonString(
  text: string,
  start: number,
): { value: string; next: number } | undefined {
  if (text[start] !== '"') return undefined;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') {
      try {
        return {
          value: JSON.parse(text.slice(start, index + 1)) as string,
          next: index + 1,
        };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (/\s/.test(text[index] ?? "")) index += 1;
  return index;
}

function numericScalar(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  const instant = Date.parse(raw);
  if (!Number.isFinite(instant)) return undefined;
  return new Date(instant).toISOString();
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
      new OpencodeGoFailure("request_timeout", { staleEligible: true }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new OpencodeGoFailure("request_timeout", { staleEligible: true }));
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class OpencodeGoFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: OpencodeGoFailureOptions = {}) {
    super(code);
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible ?? false;
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.retryAfter = options.retryAfter;
  }
}
