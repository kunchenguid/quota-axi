import { readCachedProvider, deleteCachedProvider } from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { usableLiteralSecret } from "../lib/secret.js";
import {
  clampPercent,
  percentRemaining,
  retryAfterToIso,
} from "../lib/time.js";
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
  createPiOllamaCredentialBroker,
  type PiOllamaCredentialBroker,
  type PiOllamaCredentialInspection,
  type PiOllamaCredentialResolution,
} from "./pi-ollama-credential.js";
import { selectCredential } from "./credential-selection.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  successProvider,
} from "./common.js";

export const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";
export const OLLAMA_PI_CREDENTIAL_SOURCE = "pi:ollama-cloud";
export const OLLAMA_ENV_CREDENTIAL_SOURCE = "auth-env";

const OLLAMA_SOURCE_ORDER = [
  OLLAMA_PI_CREDENTIAL_SOURCE,
  OLLAMA_ENV_CREDENTIAL_SOURCE,
] as const;
const LABEL = "Ollama Cloud";
const API_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const BODY_CLEANUP_TIMEOUT_MS = 100;
const USER_AGENT = `quota-axi/${VERSION}`;

type FetchImplementation = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type EnvCredentialResolution =
  | { status: "available"; credential: string }
  | { status: "missing" }
  | { status: "invalid" };

type OllamaResolution = PiOllamaCredentialResolution | EnvCredentialResolution;

type OllamaDependencies = {
  piBroker: PiOllamaCredentialBroker;
  environment: Readonly<Record<string, string | undefined>>;
  fetch: FetchImplementation;
  readCachedProvider: typeof readCachedProvider;
  deleteCachedProvider: typeof deleteCachedProvider;
  now: () => number;
  deadlineMs: number;
};

type OllamaFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  retryAfter?: string;
};

export type NormalizedOllamaUsage = {
  windows: QuotaWindow[];
};

export function createOllamaAdapter(
  overrides: Partial<OllamaDependencies> = {},
): ProviderAdapter {
  const dependencies: OllamaDependencies = {
    piBroker: createPiOllamaCredentialBroker(),
    environment: process.env,
    fetch: providerFetch,
    readCachedProvider,
    deleteCachedProvider,
    now: Date.now,
    deadlineMs: API_TIMEOUT_MS,
    ...overrides,
  };

  return {
    id: "ollama",
    label: LABEL,
    fetchQuota: () => acquireOllamaQuota(dependencies),
    inspectAuth: () => inspectOllamaAuth(dependencies),
  };
}

export const ollamaAdapter = createOllamaAdapter();

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return ollamaAdapter.fetchQuota(_options);
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return ollamaAdapter.inspectAuth(_options);
}

async function acquireOllamaQuota(
  dependencies: OllamaDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let authFailure: OllamaFailure | undefined;
  let transientFailure: OllamaFailure | undefined;
  const resolveSources: Array<() => Promise<OllamaResolution>> = [
    () => dependencies.piBroker.resolve(),
    async () => resolveEnvCredential(dependencies.environment),
  ];

  for (const [index, resolveSource] of resolveSources.entries()) {
    const source = OLLAMA_SOURCE_ORDER[index];
    const resolution = await resolveSource();
    if (resolution.status !== "available") {
      const failure = credentialFailureFor(source, resolution);
      const present = resolution.status !== "missing";
      attempts.push({
        source,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.code,
        ...(present ? { credentialPresent: true } : {}),
      });
      if (resolution.status === "error") {
        return failureReport(failure, attempts, dependencies);
      }
      if (failure.definitiveAuth) {
        if (present || authFailure === undefined) authFailure = failure;
      } else if (transientFailure === undefined) {
        transientFailure = failure;
      }
      continue;
    }

    let attemptFailure: OllamaFailure | undefined;
    const selection = await selectCredential(
      [
        {
          source,
          localState: "valid",
          credential: resolution.credential,
        },
      ],
      async (candidate) => {
        attempts.push({ source: candidate.source, status: "failed" });
        try {
          const payload = await requestOllamaUsage(
            candidate.credential,
            dependencies.fetch,
            dependencies.now,
            dependencies.deadlineMs,
          );
          const normalized = normalizeOllamaUsage(payload);
          const refreshedAt = new Date(dependencies.now()).toISOString();
          attempts[attempts.length - 1] = {
            source: candidate.source,
            status: "success",
          };
          return {
            kind: "quota" as const,
            result: successProvider({
              provider: "ollama",
              label: LABEL,
              source: "api",
              windows: normalized.windows,
              refreshedAt,
              sourcesTried: sourceNames(attempts),
              attempts,
            }),
          };
        } catch (error) {
          const failure = asOllamaFailure(error);
          attemptFailure = failure;
          attempts[attempts.length - 1] = {
            source: candidate.source,
            status: "failed",
            error: failure.code,
          };
          return failure.definitiveAuth
            ? { kind: "rejected" as const, error: failure.code }
            : {
                kind: "transient" as const,
                error: failure.code,
                retryAfter: failure.retryAfter,
              };
        }
      },
    );

    if (selection.outcome === "quota" && selection.result)
      return selection.result;
    if (selection.outcome === "transient") {
      return failureReport(
        attemptFailure ??
          new OllamaFailure(
            selection.transientError ?? "ollama_request_failed",
            {
              status: "error",
              staleEligible: true,
              retryAfter: selection.retryAfter,
            },
          ),
        attempts,
        dependencies,
      );
    }
    if (selection.outcome === "all_rejected") authFailure = attemptFailure;
  }

  return failureReport(
    transientFailure ??
      authFailure ??
      new OllamaFailure("ollama_credential_unavailable", {
        status: "auth_required",
        definitiveAuth: true,
      }),
    attempts,
    dependencies,
  );
}

async function inspectOllamaAuth(
  dependencies: OllamaDependencies,
): Promise<AuthProviderReport> {
  const piInspection = await dependencies.piBroker.inspect();
  const envInspection = inspectEnvCredential(dependencies.environment);
  return {
    provider: "ollama",
    sources: [
      piAuthSource(piInspection),
      {
        source: OLLAMA_ENV_CREDENTIAL_SOURCE,
        status: envInspection,
      },
    ],
  };
}

function piAuthSource(
  inspection: PiOllamaCredentialInspection,
): AuthSourceReport {
  const status =
    inspection.status === "unsupported" ? "invalid" : inspection.status;
  return {
    source: OLLAMA_PI_CREDENTIAL_SOURCE,
    path: inspection.path,
    status,
    ...("error" in inspection && inspection.error
      ? { error: inspection.error }
      : {}),
  };
}

function resolveEnvCredential(
  environment: Readonly<Record<string, string | undefined>>,
): EnvCredentialResolution {
  const value = environment.OLLAMA_API_KEY;
  if (value === undefined || value.trim() === "") return { status: "missing" };
  const credential = usableLiteralSecret(value);
  return credential === undefined
    ? { status: "invalid" }
    : { status: "available", credential };
}

function inspectEnvCredential(
  environment: Readonly<Record<string, string | undefined>>,
): "available" | "missing" | "invalid" {
  return resolveEnvCredential(environment).status;
}

function credentialFailureFor(
  source: string,
  resolution: Exclude<OllamaResolution, { status: "available" }>,
): OllamaFailure {
  if (resolution.status === "missing") {
    return new OllamaFailure("ollama_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "error") {
    return new OllamaFailure("credential_resolution_failed", {
      status: "error",
      staleEligible: true,
    });
  }
  if (resolution.status === "unsupported") {
    return new OllamaFailure("ollama_pi_credential_unsupported", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (source === OLLAMA_ENV_CREDENTIAL_SOURCE) {
    return new OllamaFailure("ollama_env_key_invalid", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  return new OllamaFailure("ollama_pi_credential_invalid", {
    status: "auth_required",
    definitiveAuth: true,
  });
}

function failureReport(
  failure: OllamaFailure,
  attempts: SourceAttempt[],
  dependencies: OllamaDependencies,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("ollama");
    } catch {
      // A definitive current auth result remains valid if cache retirement fails.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = dependencies.readCachedProvider("ollama");
      if (cached) {
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

  return failedProvider({
    provider: "ollama",
    label: LABEL,
    source: "unavailable",
    status: failure.status,
    error: failure.code,
    retryAfter: failure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function requestOllamaUsage(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  now: () => number,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let timedOut = false;
  let fetchPromise: Promise<Response>;
  let response: Response;
  try {
    fetchPromise = Promise.resolve().then(() =>
      fetchImplementation(OLLAMA_USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      }),
    );
    void fetchPromise.then(
      (lateResponse) => {
        if (timedOut) void cancelResponseBody(lateResponse);
      },
      () => undefined,
    );
    response = await waitForDeadline(fetchPromise, controller.signal);
  } catch (error) {
    timedOut = true;
    clearTimeout(timer);
    if (controller.signal.aborted || isAbortError(error)) {
      throw new OllamaFailure("request_timeout", {
        status: "unavailable",
        staleEligible: true,
      });
    }
    throw new OllamaFailure(localTransportCode(error), {
      status: "unavailable",
      staleEligible: true,
    });
  }

  const lifetime = createResponseBodyLifetime(response);
  try {
    const receivedAt = now();
    rejectHttpFailure(response, receivedAt);

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, controller.signal, lifetime);
      lifetime.markConsumed();
    } catch (error) {
      if (error instanceof OllamaFailure) throw error;
      if (controller.signal.aborted || isAbortError(error)) {
        throw new OllamaFailure("request_timeout", {
          status: "unavailable",
          staleEligible: true,
        });
      }
      throw new OllamaFailure("network_unavailable", {
        status: "unavailable",
        staleEligible: true,
      });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new OllamaFailure("response_invalid_utf8", {
        status: "error",
        staleEligible: true,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OllamaFailure("malformed_json", {
        status: "error",
        staleEligible: true,
      });
    }
  } finally {
    clearTimeout(timer);
    await lifetime.cancel();
  }
}

function rejectHttpFailure(response: Response, receivedAt: number): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new OllamaFailure("redirect_rejected", {
      status: "error",
      staleEligible: true,
    });
  }
  if (status === 401 || status === 403) {
    throw new OllamaFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (status === 408) {
    throw new OllamaFailure("provider_timeout", {
      status: "unavailable",
      staleEligible: true,
    });
  }
  if (status === 429) {
    throw new OllamaFailure("provider_rate_limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: retryAfterToIso(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new OllamaFailure("provider_unavailable", {
      status: "unavailable",
      staleEligible: true,
    });
  }
  throw new OllamaFailure("provider_request_rejected", {
    status: "error",
    staleEligible: true,
  });
}

export function normalizeOllamaUsage(raw: unknown): NormalizedOllamaUsage {
  const limits = objectValue(objectValue(raw)?.limits);
  if (!limits) return { windows: [] };

  const windows: QuotaWindow[] = [];
  const definitions = [
    ["session", "five_hour", "session"],
    ["weekly", "weekly", "weekly"],
  ] as const;
  for (const [limitName, id, kind] of definitions) {
    const usage = fractionValue(objectValue(limits[limitName])?.usage);
    if (usage === undefined) continue;
    const percentUsed = clampPercent(usage * 100);
    windows.push({
      id,
      label: kind === "session" ? "session" : "week",
      kind,
      percentUsed,
      percentRemaining: percentRemaining(percentUsed),
    });
  }
  return { windows };
}

function fractionValue(value: unknown): number | undefined {
  let number: number | undefined;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) number = parsed;
  }
  if (number === undefined || !Number.isFinite(number)) return undefined;
  return number >= 0 && number <= 1 ? number : undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;
  const cancellation = Promise.resolve()
    .then(() => body.cancel())
    .catch(() => undefined);
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      throw new OllamaFailure("response_too_large", {
        status: "error",
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
        throw new OllamaFailure("response_too_large", {
          status: "error",
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

type ResponseBodyLifetime = {
  markConsumed(): void;
  cancel(action?: () => Promise<unknown> | undefined): Promise<void>;
};

async function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const cancelReader = () => lifetime.cancel(() => reader.cancel());
  if (signal.aborted) {
    await cancelReader();
    throw new OllamaFailure("request_timeout", {
      status: "unavailable",
      staleEligible: true,
    });
  }
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      cancelReader().then(() => {
        reject(
          new OllamaFailure("request_timeout", {
            status: "unavailable",
            staleEligible: true,
          }),
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

function asOllamaFailure(error: unknown): OllamaFailure {
  return error instanceof OllamaFailure
    ? error
    : new OllamaFailure("ollama_request_failed", {
        status: "error",
        staleEligible: true,
      });
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
      new OllamaFailure("request_timeout", {
        status: "unavailable",
        staleEligible: true,
      }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        new OllamaFailure("request_timeout", {
          status: "unavailable",
          staleEligible: true,
        }),
      );
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

class OllamaFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: OllamaFailureOptions = {}) {
    super(code);
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible ?? false;
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.retryAfter = options.retryAfter;
  }
}
