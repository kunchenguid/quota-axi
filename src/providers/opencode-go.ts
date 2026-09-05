import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { parseEpochOrIso, clampPercent } from "../lib/time.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
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

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const OPENCODE_GO_CREDENTIAL_SOURCE = "opencode:auth.json";

// Pi stores the OpenCode Go key under its own `opencode-go` entry; the
// separate `opencode` (Zen) entry is a different product and is not read here.
const PI_OPENCODE_GO_PROVIDER_IDS = ["opencode-go"] as const;

const LABEL = "OpenCode Go";
const RESPONSE_LIMIT_BYTES = 262_144;
const BODY_CLEANUP_TIMEOUT_MS = 100;
const DEADLINE_MS = 15_000;

type CredentialResolution =
  | { status: "available"; key: string; path: string }
  | { status: "missing" | "invalid" | "error"; path: string };

type Dependencies = {
  credential: () => CredentialResolution;
  piCredentialBroker: PiApiKeyCredentialBroker;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedOpenCodeGoPayload = {
  plan?: string;
  windows: QuotaWindow[];
};

export function opencodeGoAuthFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "opencode", "auth.json");
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return join(localAppData, "opencode", "auth.json");
  }
  return join(join(homedir(), ".local", "share"), "opencode", "auth.json");
}

export function extractOpenCodeGoCredential(
  value: unknown,
  path: string,
): CredentialResolution {
  const root = objectValue(value);
  if (!root) return { status: "missing", path };
  let hasEntry = false;
  for (const name of ["opencode-go", "opencode"]) {
    const entry = objectValue(root[name]);
    if (!entry) continue;
    hasEntry = true;
    const key = [
      entry.key,
      entry.apiKey,
      entry.api_key,
      entry.access,
      entry.token,
    ]
      .map(usableLiteralSecret)
      .find((candidate): candidate is string => candidate !== undefined);
    if (key) return { status: "available", key, path };
  }
  return { status: hasEntry ? "invalid" : "missing", path };
}

export function resolveOpenCodeGoCredential(
  path = opencodeGoAuthFilePath(),
): CredentialResolution {
  const result: JsonFileReadResult = readJsonFileResult(path);
  if (result.status === "missing") return { status: "missing", path };
  if (result.status === "invalid") {
    return {
      status: result.error === "file_read_error" ? "error" : "invalid",
      path,
    };
  }
  return extractOpenCodeGoCredential(result.value, path);
}

export function createOpenCodeGoAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveOpenCodeGoCredential(),
    piCredentialBroker: createPiApiKeyCredentialBroker(
      PI_OPENCODE_GO_PROVIDER_IDS,
    ),
    fetch: globalThis.fetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "opencode-go",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const opencodeGoAdapter = createOpenCodeGoAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const piResolution = await resolvePiCredential(dependencies);
  const opencodeResolution = resolveCredentialSafely(dependencies);
  const selection = await selectCredential(
    credentialCandidates(piResolution, opencodeResolution),
    (candidate) => attemptCandidate(candidate, dependencies),
  );
  const attempts = sourceAttempts(
    piResolution,
    opencodeResolution,
    selection,
    dependencies,
  );

  if (selection.outcome === "quota" && selection.result) {
    const normalized = selection.result;
    return successProvider({
      provider: "opencode-go",
      label: LABEL,
      source: "api",
      ...(normalized.plan ? { plan: normalized.plan } : {}),
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  const failure = selectionFailureFor(
    selection,
    piResolution,
    opencodeResolution,
  );
  return failedProvider({
    provider: "opencode-go",
    label: LABEL,
    status: failure.status,
    error: failure.code,
    source: "api",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function resolvePiCredential(
  dependencies: Dependencies,
): Promise<PiApiKeyCredentialResolution> {
  try {
    return await dependencies.piCredentialBroker.resolve();
  } catch {
    return { status: "error" };
  }
}

function resolveCredentialSafely(
  dependencies: Dependencies,
): CredentialResolution {
  try {
    return dependencies.credential();
  } catch {
    return { status: "error", path: "" };
  }
}

/** Pi's entry is tried first; the opencode store stays the fallback. */
function credentialCandidates(
  piResolution: PiApiKeyCredentialResolution,
  opencodeResolution: CredentialResolution,
): readonly SelectionCandidate<string>[] {
  const candidates: SelectionCandidate<string>[] = [];
  if (piResolution.status === "available") {
    candidates.push({
      source: `pi:${piResolution.providerId}`,
      localState: "valid",
      credential: piResolution.credential,
    });
  }
  if (opencodeResolution.status === "available") {
    candidates.push({
      source: OPENCODE_GO_CREDENTIAL_SOURCE,
      localState: "valid",
      credential: opencodeResolution.key,
    });
  }
  return candidates;
}

async function attemptCandidate(
  candidate: SelectionCandidate<string>,
  dependencies: Dependencies,
): Promise<AttemptOutcome<NormalizedOpenCodeGoPayload>> {
  try {
    const payload = await requestUsage(
      candidate.credential,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const normalized = normalizeOpenCodeGoPayload(payload);
    if (normalized.windows.length === 0) {
      return { kind: "transient", error: "quota_missing" };
    }
    return { kind: "quota", result: normalized };
  } catch (error) {
    const code = errorCode(error);
    if (code === "provider_auth_rejected") {
      return { kind: "rejected", error: code };
    }
    return { kind: "transient", error: code };
  }
}

function sourceAttempts(
  piResolution: PiApiKeyCredentialResolution,
  opencodeResolution: CredentialResolution,
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
  dependencies: Dependencies,
): SourceAttempt[] {
  const primary =
    dependencies.piCredentialBroker.providerIds[0] ?? "opencode-go";
  const providerId = resolutionPiProviderId(piResolution) ?? primary;
  const piSourceName = `pi:${providerId}`;
  return [
    piAttemptRecord(piResolution, piSourceName, selection),
    opencodeAttemptRecord(opencodeResolution, selection),
  ];
}

/** Names the source after the entry actually responsible for the state. */
function resolutionPiProviderId(
  resolution: PiApiKeyCredentialResolution,
): string | undefined {
  return resolution.status === "available" ||
    resolution.status === "invalid" ||
    resolution.status === "unsupported"
    ? resolution.providerId
    : undefined;
}

function piAttemptRecord(
  resolution: PiApiKeyCredentialResolution,
  sourceName: string,
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
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
        error: "opencode_go_credential_unavailable",
      };
    case "invalid":
      return {
        source: sourceName,
        status: "skipped",
        error: "opencode_go_credential_invalid",
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
  resolution: CredentialResolution,
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
): SourceAttempt {
  if (resolution.status === "available") {
    return selectionAttemptRecord(
      OPENCODE_GO_CREDENTIAL_SOURCE,
      selection.results.find(
        (entry) => entry.source === OPENCODE_GO_CREDENTIAL_SOURCE,
      ),
      selection,
    );
  }
  return {
    source: OPENCODE_GO_CREDENTIAL_SOURCE,
    status: resolution.status === "error" ? "failed" : "skipped",
    error: credentialError(resolution),
  };
}

function selectionAttemptRecord(
  sourceName: string,
  result: CandidateResult | undefined,
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
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

type LocalFailure = { status: ProviderStatus; code: string };

function selectionFailureFor(
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
  piResolution: PiApiKeyCredentialResolution,
  opencodeResolution: CredentialResolution,
): LocalFailure {
  switch (selection.outcome) {
    case "transient":
      return transientFailure(
        selection.transientError ?? "quota_request_failed",
      );
    case "all_rejected":
      // A source that could not be read leaves the credential set
      // indeterminate: never a definitive sign-out while a usable
      // credential may sit behind an unreadable store.
      if (
        piResolution.status === "error" ||
        opencodeResolution.status === "error"
      ) {
        return { status: "error", code: "credential_resolution_failed" };
      }
      return { status: "auth_required", code: "provider_auth_rejected" };
    case "live_no_quota":
      // Unreachable: every attempt yields windows or throws.
      return { status: "error", code: "quota_missing" };
    default: {
      if (
        piResolution.status === "error" ||
        opencodeResolution.status === "error"
      ) {
        return { status: "error", code: "credential_resolution_failed" };
      }
      // The opencode store's own state wins unless it is plain missing; a
      // missing fallback defers to the Pi source's distinct state.
      return opencodeResolution.status === "missing"
        ? piLocalFailure(piResolution)
        : opencodeLocalFailure(opencodeResolution);
    }
  }
}

function transientFailure(code: string): LocalFailure {
  return {
    status: code === "provider_rate_limited" ? "rate_limited" : "error",
    code,
  };
}

function piLocalFailure(
  resolution: PiApiKeyCredentialResolution,
): LocalFailure {
  switch (resolution.status) {
    case "missing":
      return {
        status: "auth_required",
        code: "opencode_go_credential_unavailable",
      };
    case "unsupported":
      return { status: "auth_required", code: "unsupported_credential_type" };
    case "error":
      return { status: "error", code: "credential_resolution_failed" };
    default:
      return {
        status: "auth_required",
        code: "opencode_go_credential_invalid",
      };
  }
}

function opencodeLocalFailure(resolution: CredentialResolution): LocalFailure {
  if (resolution.status === "missing") {
    return {
      status: "auth_required",
      code: "opencode_go_credential_unavailable",
    };
  }
  if (resolution.status === "error") {
    return { status: "error", code: "credential_resolution_failed" };
  }
  return { status: "auth_required", code: "opencode_go_credential_invalid" };
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
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
  const resolution = resolveCredentialSafely(dependencies);
  const source: AuthSourceReport = {
    source: OPENCODE_GO_CREDENTIAL_SOURCE,
    path: resolution.path,
    status:
      resolution.status === "available"
        ? "available"
        : resolution.status === "missing"
          ? "missing"
          : resolution.status === "error"
            ? "error"
            : "invalid",
    ...(resolution.status === "error"
      ? { error: "credential_resolution_failed" }
      : {}),
  };
  return {
    provider: "opencode-go",
    sources: [
      {
        source: `pi:${piInspection.providerId}`,
        status: piStatus,
        ...(piError ? { error: piError } : {}),
      },
      source,
    ],
  };
}

async function inspectPiCredential(
  dependencies: Dependencies,
): Promise<PiApiKeyCredentialInspection> {
  try {
    return await dependencies.piCredentialBroker.inspect();
  } catch {
    return {
      status: "error",
      providerId:
        dependencies.piCredentialBroker.providerIds[0] ?? "opencode-go",
      error: "credential_resolution_failed",
    };
  }
}

async function requestUsage(
  key: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let fetchPromise: Promise<Response> | undefined;
  try {
    fetchPromise = fetchImplementation(OPENCODE_GO_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    void fetchPromise.then(
      (response) => {
        if (timedOut) void cancelResponseBody(response);
      },
      () => undefined,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("provider_timeout"));
      }, deadlineMs);
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response.ok) {
      await cancelResponseBody(response);
    }
    if (response.status === 401 || response.status === 403)
      throw new Error("provider_auth_rejected");
    if (response.status === 429) throw new Error("provider_rate_limited");
    if (!response.ok) throw new Error("provider_request_rejected");
    const body = await readResponseBody(response, controller.signal);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new Error("malformed_json");
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("provider_timeout", { cause: error });
    if (
      error instanceof Error &&
      (error.message.startsWith("provider_") ||
        error.message === "response_too_large" ||
        error.message === "response_size_unverifiable" ||
        error.message === "malformed_json")
    )
      throw error;
    throw new Error("network_unavailable", { cause: error });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = Promise.resolve()
    .then(() => body.cancel())
    .catch(() => undefined);
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

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = response.headers?.get("content-length")?.trim();
  const parsedLength = declaredLength ? Number(declaredLength) : undefined;
  const usableLength =
    parsedLength !== undefined &&
    Number.isInteger(parsedLength) &&
    parsedLength >= 0;
  if (
    usableLength &&
    parsedLength !== undefined &&
    parsedLength > RESPONSE_LIMIT_BYTES
  ) {
    await cancelResponseBody(response);
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("response_size_unverifiable");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    while (true) {
      pendingRead = reader.read();
      const result = await raceWithAbort(pendingRead, signal);
      pendingRead = undefined;
      if (result.done) break;
      const chunk = result.value;
      if (length + chunk.byteLength > RESPONSE_LIMIT_BYTES) {
        throw new Error("response_too_large");
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } finally {
    if (pendingRead) {
      if (typeof reader.cancel === "function")
        await settlePendingRead(reader, pendingRead);
      else pendingRead.catch(() => undefined);
    } else {
      if (typeof reader.cancel === "function")
        void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function settlePendingRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pendingRead: Promise<ReadableStreamReadResult<Uint8Array>>,
): Promise<void> {
  // A pending read owns the stream lock. Cancellation is best effort here:
  // releasing it while the read is still pending throws in native streams and
  // can leave the response body in an inconsistent state. The settlement
  // handler below performs the release whenever the vendor body eventually
  // responds, even if that happens after this bounded cleanup returns.
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => undefined);
  let released = false;
  const releaseAfterReadSettles = (): void => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      return;
    }
  };
  const readSettled = pendingRead.then(
    releaseAfterReadSettles,
    releaseAfterReadSettles,
  );
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      readSettled,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error("provider_timeout");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("provider_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function normalizeOpenCodeGoPayload(
  raw: unknown,
): NormalizedOpenCodeGoPayload {
  const root = objectValue(raw);
  const usage = objectValue(root?.usage);
  if (!usage) return { windows: [] };
  const definitions = [
    ["rolling", "five_hour", "session"],
    ["weekly", "weekly", "weekly"],
    ["monthly", "monthly", "monthly"],
  ] as const;
  const windows = definitions
    .map(([name, id, kind]) => {
      const record = objectValue(usage[name]);
      return record ? normalizeWindow(record, id, kind) : undefined;
    })
    .filter((window): window is QuotaWindow => window !== undefined);
  const plan =
    firstString(root, ["planName", "plan_name", "plan"]) ?? "OpenCode Go";
  return { plan, windows };
}

function normalizeWindow(
  record: Record<string, unknown>,
  id: string,
  kind: QuotaWindow["kind"],
): QuotaWindow | undefined {
  const used = firstNumber(record, ["percent", "percentUsed", "usedPercent"]);
  const remaining = firstNumber(record, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const percentRemaining =
    remaining !== undefined
      ? clampPercent(remaining)
      : used !== undefined
        ? clampPercent(100 - used)
        : undefined;
  if (percentRemaining === undefined) return undefined;
  const reset = firstValue(record, [
    "resetsAt",
    "resetAt",
    "reset_at",
    "nextResetTime",
  ]);
  const windowSeconds = firstNumber(record, [
    "windowSeconds",
    "window_seconds",
    "cycleSeconds",
    "cycle_seconds",
    "durationSeconds",
    "duration_seconds",
    "periodSeconds",
    "period_seconds",
  ]);
  const parsedReset = safeParseReset(reset);
  const hasAuthoritativeDuration = windowSeconds === 18_000;
  const normalizedIdentity =
    id === "five_hour" && !hasAuthoritativeDuration
      ? { id: "rolling", label: "rolling", kind: "unknown" as const }
      : { id, label: id === "five_hour" ? "session" : id, kind };
  return {
    ...normalizedIdentity,
    percentUsed: clampPercent(100 - percentRemaining),
    percentRemaining,
    ...(windowSeconds !== undefined && windowSeconds > 0
      ? { windowSeconds }
      : {}),
    ...(parsedReset ? { resetsAt: parsedReset } : {}),
  };
}

function safeParseReset(value: unknown): string | undefined {
  try {
    const parsed = parseEpochOrIso(value);
    return parsed && !Number.isNaN(Date.parse(parsed)) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function credentialError(
  resolution: Exclude<CredentialResolution, { status: "available" }>,
): string {
  return resolution.status === "missing"
    ? "opencode_go_credential_unavailable"
    : resolution.status === "invalid"
      ? "opencode_go_credential_invalid"
      : "credential_resolution_failed";
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "quota_request_failed";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  return value
    ? keys.map((key) => stringValue(value[key])).find(Boolean)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  return keys
    .map((key) => numberValue(value[key]))
    .find((item) => item !== undefined);
}

function firstValue(value: Record<string, unknown>, keys: string[]): unknown {
  return keys
    .map((key) => value[key])
    .find((item) => item !== undefined && item !== null);
}
