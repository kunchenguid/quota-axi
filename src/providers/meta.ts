import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  successProvider,
} from "./common.js";

export const META_MUSE_MINT_URL = "https://api.meta.ai/muse-code/key";
export const META_PI_SOURCE = "pi:meta";

const LABEL = "Meta Muse";
const PI_PROVIDER_ID = "meta";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 256 * 1024;
const BODY_CLEANUP_TIMEOUT_MS = 100;
const DEADLINE_MS = 15_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export type MetaCredentialResolution =
  | {
      status: "available";
      identityBearer: string;
      path: string;
      storedExpired: boolean;
      credentialPresent: true;
    }
  | {
      status: "missing" | "invalid" | "unsupported" | "error";
      path: string;
      credentialPresent?: true;
    };

type Dependencies = {
  credential: () => Promise<MetaCredentialResolution>;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedMetaMusePayload = {
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

export function createMetaAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: resolveMetaCredential,
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "meta",
    label: LABEL,
    fetchQuota: () => fetchMetaQuota(dependencies),
    inspectAuth: () => inspectMetaAuth(dependencies),
  };
}

export const metaAdapter = createMetaAdapter();

export async function resolveMetaCredential(
  path = metaPiAuthFilePath(),
  now = Date.now(),
): Promise<MetaCredentialResolution> {
  let contents: Uint8Array;
  try {
    contents = await readBoundedFile(path, AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing", path }
      : { status: "error", path };
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) {
    return { status: "invalid", path, credentialPresent: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(contents)) as unknown;
  } catch {
    return { status: "invalid", path, credentialPresent: true };
  }
  const classified = classifyPiAuthEntry(parsed, PI_PROVIDER_ID);
  if (classified.status === "missing") return { status: "missing", path };
  if (classified.status === "invalid") {
    return { status: "invalid", path, credentialPresent: true };
  }
  const type = stringValue(classified.entry.type)?.toLowerCase();
  if (type !== "oauth") {
    return {
      status: type === undefined ? "invalid" : "unsupported",
      path,
      credentialPresent: true,
    };
  }
  const identityBearer = usableLiteralSecret(classified.entry.refresh);
  if (!identityBearer) {
    return { status: "invalid", path, credentialPresent: true };
  }
  const expiresAt = timestampMs(classified.entry.expires);
  return {
    status: "available",
    identityBearer,
    path,
    storedExpired: expiresAt !== undefined && expiresAt <= now,
    credentialPresent: true,
  };
}

export function metaPiAuthFilePath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const home = process.env.HOME?.trim() || homedir();
  if (!configured) return join(home, ".pi", "agent", "auth.json");
  if (configured === "~") return join(home, "auth.json");
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(home, configured.slice(2), "auth.json");
  }
  return join(configured, "auth.json");
}

async function fetchMetaQuota(
  dependencies: Dependencies,
): Promise<ProviderQuota> {
  const resolution = await dependencies.credential();
  const attempt: SourceAttempt = {
    source: META_PI_SOURCE,
    status:
      resolution.status === "available" || resolution.status === "error"
        ? "failed"
        : "skipped",
    ...(resolution.status !== "available"
      ? { error: credentialError(resolution) }
      : {}),
    ...(resolution.credentialPresent ? { credentialPresent: true } : {}),
  };
  const attempts = [attempt];
  if (resolution.status !== "available") {
    if (resolution.status === "error") {
      const cached = dependencies.readCachedProvider("meta");
      if (cached) {
        return staleFromCache(
          cached,
          credentialError(resolution),
          sourceNames(attempts),
          attempts,
        );
      }
    } else {
      clearCache(dependencies);
    }
    return unavailableReport(
      credentialError(resolution),
      resolution.status === "error" ? "error" : "auth_required",
      attempts,
    );
  }

  try {
    const payload = await requestMetaMuseSnapshot(
      resolution.identityBearer,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const normalized = normalizeMetaMusePayload(payload);
    attempts[0] = { source: META_PI_SOURCE, status: "success" };
    const result = successProvider({
      provider: "meta",
      label: LABEL,
      source: "pi:meta",
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    result.state.authStatus = "usable";
    if (normalized.untrustedWindowIds.length > 0) {
      result.state.untrustedWindowIds = normalized.untrustedWindowIds;
    }
    return result;
  } catch (error) {
    const code = errorCode(error) ?? "provider_request_failed";
    attempts[0] = {
      source: META_PI_SOURCE,
      status: "failed",
      error: code,
      credentialPresent: true,
    };
    if (code === "provider_auth_rejected") {
      clearCache(dependencies);
      return unavailableReport(code, "auth_required", attempts);
    }
    const cached = dependencies.readCachedProvider("meta");
    if (cached) {
      return staleFromCache(cached, code, sourceNames(attempts), attempts);
    }
    return unavailableReport(
      code,
      code === "provider_rate_limited" ? "rate_limited" : "error",
      attempts,
    );
  }
}

async function inspectMetaAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  const resolution = await dependencies.credential();
  const source: AuthSourceReport = {
    source: META_PI_SOURCE,
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
      : resolution.status === "unsupported"
        ? { error: "unsupported_credential_type" }
        : {}),
    ...(resolution.credentialPresent ? { credentialPresent: true } : {}),
  };
  return { provider: "meta", sources: [source] };
}

function unavailableReport(
  error: string,
  status: "auth_required" | "rate_limited" | "error",
  attempts: SourceAttempt[],
): ProviderQuota {
  const result = failedProvider({
    provider: "meta",
    label: LABEL,
    status,
    error,
    source: "pi:meta",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  if (status === "auth_required") result.state.authStatus = "unusable";
  return result;
}

function clearCache(dependencies: Dependencies): void {
  try {
    dependencies.deleteCachedProvider("meta");
  } catch {
    // A definitive current auth result remains valid if cache cleanup fails.
  }
}

async function requestMetaMuseSnapshot(
  identityBearer: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let fetchPromise: Promise<Response> | undefined;
  try {
    fetchPromise = fetchImplementation(META_MUSE_MINT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${identityBearer}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-version": "1.0.0",
      },
      body: "{}",
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
    if (response.status === 401 || response.status === 403) {
      await cancelResponseBody(response);
      throw new Error("provider_auth_rejected");
    }
    if (response.status === 429) {
      await cancelResponseBody(response);
      throw new Error("provider_rate_limited");
    }
    if (!response.ok || response.status !== 200) {
      await cancelResponseBody(response);
      throw new Error("provider_request_rejected");
    }
    const bytes = await readResponseBody(response, controller.signal);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("response_invalid_utf8");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("malformed_json");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("provider_timeout", { cause: error });
    }
    if (
      error instanceof Error &&
      (error.message.startsWith("provider_") ||
        error.message === "response_too_large" ||
        error.message === "response_size_unverifiable" ||
        error.message === "response_invalid_utf8" ||
        error.message === "malformed_json" ||
        error.message === "schema_invalid")
    ) {
      throw error;
    }
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
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      await cancelResponseBody(response);
      throw new Error("response_too_large");
    }
  }
  if (!response.body) throw new Error("response_size_unverifiable");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await raceWithAbort(reader.read(), signal);
      if (result.done) break;
      if (length + result.value.byteLength > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response_too_large");
      }
      chunks.push(result.value);
      length += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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

export function normalizeMetaMusePayload(
  payload: unknown,
): NormalizedMetaMusePayload {
  const root = objectValue(payload);
  if (!root) throw new Error("schema_invalid");
  if (root.subs_usage === undefined || root.subs_usage === null) {
    return { windows: [], untrustedWindowIds: [] };
  }
  const usage = objectValue(root.subs_usage);
  if (!usage) throw new Error("schema_invalid");

  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];
  const weekly = usage.weekly;
  if (weekly !== undefined) {
    const normalized = normalizeWeekly(weekly);
    if (normalized) windows.push(normalized);
    else untrustedWindowIds.push("weekly");
  }
  const rolling = usage.window;
  if (rolling !== undefined) {
    const normalized = normalizeRolling(rolling);
    if (normalized) windows.push(normalized);
    else untrustedWindowIds.push("window");
  }

  let unknownIndex = 0;
  for (const [key, raw] of Object.entries(usage)) {
    if (key === "weekly" || key === "window" || key === "tier") continue;
    unknownIndex += 1;
    const id = `limit:${unknownIndex}`;
    untrustedWindowIds.push(id);
    const entry = objectValue(raw);
    const used = validPercent(entry?.used_percent);
    if (used === undefined) continue;
    const resetsAt = parseVendorTimestamp(entry?.resets_at);
    windows.push({
      id,
      label: `limit ${unknownIndex}`,
      kind: "unknown",
      percentUsed: used,
      percentRemaining: 100 - used,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return { windows, untrustedWindowIds };
}

function normalizeWeekly(value: unknown): QuotaWindow | undefined {
  const entry = objectValue(value);
  const used = validPercent(entry?.used_percent);
  if (used === undefined) return undefined;
  const resetsAt = parseVendorTimestamp(entry?.resets_at);
  return {
    id: "weekly",
    label: "week",
    kind: "weekly",
    percentUsed: used,
    percentRemaining: 100 - used,
    windowSeconds: WEEK_SECONDS,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function normalizeRolling(value: unknown): QuotaWindow | undefined {
  const entry = objectValue(value);
  const used = validPercent(entry?.used_percent);
  const minutes = positiveInteger(entry?.window_duration_mins);
  if (used === undefined || minutes === undefined) return undefined;
  const resetsAt = parseVendorTimestamp(entry?.resets_at);
  return {
    id: `window:${minutes}m`,
    label: minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`,
    kind: "session",
    percentUsed: used,
    percentRemaining: 100 - used,
    windowSeconds: minutes * 60,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function validPercent(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function parseVendorTimestamp(value: unknown): string | undefined {
  let milliseconds: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric)
      ? numeric < 1_000_000_000_000
        ? numeric * 1000
        : numeric
      : Date.parse(value);
  }
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return undefined;
  }
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

function credentialError(
  resolution: Exclude<MetaCredentialResolution, { status: "available" }>,
): string {
  switch (resolution.status) {
    case "missing":
      return "meta_identity_unavailable";
    case "invalid":
      return "meta_identity_invalid";
    case "unsupported":
      return "unsupported_credential_type";
    case "error":
      return "credential_resolution_failed";
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number < 1_000_000_000_000 ? number * 1000 : number;
    }
  }
  return undefined;
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : undefined;
}
