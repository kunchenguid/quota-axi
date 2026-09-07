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
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const OPENCODE_GO_CREDENTIAL_SOURCE = "opencode:auth.json";

const LABEL = "OpenCode Go";
const RESPONSE_LIMIT_BYTES = 262_144;
const BODY_CLEANUP_TIMEOUT_MS = 100;
const DEADLINE_MS = 15_000;

type CredentialResolution =
  | { status: "available"; key: string; path: string }
  | { status: "missing" | "invalid" | "error"; path: string };

type Dependencies = {
  credential: () => CredentialResolution;
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
  const resolution = dependencies.credential();
  const attempts: SourceAttempt[] = [
    {
      source: OPENCODE_GO_CREDENTIAL_SOURCE,
      status: resolution.status === "available" ? "failed" : "skipped",
      ...(resolution.status !== "available"
        ? { error: credentialError(resolution) }
        : {}),
    },
  ];
  if (resolution.status !== "available") {
    return failedProvider({
      provider: "opencode-go",
      label: LABEL,
      status: resolution.status === "missing" ? "auth_required" : "error",
      error: credentialError(resolution),
      source: "api",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  try {
    const payload = await requestUsage(
      resolution.key,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const normalized = normalizeOpenCodeGoPayload(payload, dependencies.now());
    if (normalized.windows.length === 0) throw new Error("quota_missing");
    attempts[0] = { source: OPENCODE_GO_CREDENTIAL_SOURCE, status: "success" };
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
  } catch (error) {
    const code = errorCode(error);
    attempts[0] = {
      source: OPENCODE_GO_CREDENTIAL_SOURCE,
      status: "failed",
      error: code,
    };
    return failedProvider({
      provider: "opencode-go",
      label: LABEL,
      status:
        code === "provider_auth_rejected"
          ? "auth_required"
          : code === "provider_rate_limited"
            ? "rate_limited"
            : "error",
      error: code,
      source: "api",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  const resolution = dependencies.credential();
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
  return { provider: "opencode-go", sources: [source] };
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
  now = Date.now(),
): NormalizedOpenCodeGoPayload {
  const root = objectValue(raw);
  const nestedUsage = objectValue(root?.usage);
  const definitions = [
    [["rollingUsage", "rolling"], "five_hour", "session"],
    [["weeklyUsage", "weekly"], "weekly", "weekly"],
    [["monthlyUsage", "monthly"], "monthly", "monthly"],
  ] as const;
  const windows = definitions
    .map(([names, id, kind]) => {
      const record = names
        .map(
          (name) =>
            objectValue(nestedUsage?.[name]) ?? objectValue(root?.[name]),
        )
        .find(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== undefined,
        );
      return record ? normalizeWindow(record, id, kind, now) : undefined;
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
  now: number,
): QuotaWindow | undefined {
  const used = firstNumber(record, [
    "percent",
    "percentUsed",
    "usedPercent",
    "usagePercent",
  ]);
  const remaining = firstNumber(record, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const status = stringValue(record.status)?.toLowerCase();
  const percentRemaining =
    remaining !== undefined
      ? clampPercent(remaining)
      : used !== undefined
        ? clampPercent(100 - used)
        : status === "rate-limited"
          ? 0
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
  const resetInSec = firstNumber(record, ["resetInSec", "reset_in_sec"]);
  const parsedReset =
    safeParseReset(reset) ??
    (resetInSec !== undefined && resetInSec >= 0
      ? new Date(now + resetInSec * 1_000).toISOString()
      : undefined);
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
