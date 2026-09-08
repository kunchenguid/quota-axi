import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedProvider as readCachedProviderFromDisk,
} from "../cache.js";
import type { JsonFileReadResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { clampPercent } from "../lib/time.js";
import { piAuthFilePath } from "./pi-auth.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  successProvider,
} from "./common.js";

export const MINIMAX_QUOTA_PATH = "/v1/token_plan/remains";
export const MINIMAX_BALANCE_PATH = "/account/query_balance";
export const MINIMAX_GLOBAL_BASE_URL = "https://api.minimax.io";
export const MINIMAX_CHINA_BASE_URL = "https://api.minimaxi.com";
export const MINIMAX_PI_SOURCE = "pi:minimax";
export const MINIMAX_CLI_SOURCE = "minimax:config.json";
export const MINIMAX_ENV_SOURCE = "env:MINIMAX_API_KEY";

const LABEL = "MiniMax";
const CONFIG_FILE_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 262_144;
const DEADLINE_MS = 15_000;

export type MiniMaxCredentialResolution =
  | {
      status: "available";
      key: string;
      source: string;
      path?: string;
      baseUrl: string;
      attempts?: SourceAttempt[];
    }
  | {
      status: "missing" | "invalid" | "error";
      source: string;
      path?: string;
      error?: string;
      attempts?: SourceAttempt[];
    };

type MiniMaxDependencies = {
  credential: () => MiniMaxCredentialResolution | MiniMaxCredentialResolution[];
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

type MiniMaxFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  retryAfter?: string;
};

export type NormalizedMiniMaxPayload = {
  plan?: string;
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
};

export function minimaxConfigPath(): string {
  const configured = process.env.MMX_CONFIG_DIR?.trim();
  return join(configured || join(homedir(), ".mmx"), "config.json");
}

export function extractMiniMaxCredential(
  value: unknown,
  path: string,
  source = MINIMAX_PI_SOURCE,
): MiniMaxCredentialResolution {
  const root = objectValue(value);
  if (!root)
    return { status: "invalid", source, path, error: "json_parse_error" };
  const classified = classifyPiAuthEntry(root, "minimax");
  if (classified.status === "missing")
    return { status: "missing", source, path };
  if (classified.status === "invalid")
    return { status: "invalid", source, path, error: "credential_missing" };
  const key = extractKey(classified.entry);
  if (!key)
    return { status: "invalid", source, path, error: "credential_missing" };
  return {
    status: "available",
    key,
    source,
    path,
    baseUrl: configuredBaseUrl(),
  };
}

export function extractMiniMaxCliCredential(
  value: unknown,
  path: string,
): MiniMaxCredentialResolution {
  return (
    extractMiniMaxCliCredentials(value, path)[0] ?? missingCliCredential(path)
  );
}

function extractMiniMaxCliCredentials(
  value: unknown,
  path: string,
): MiniMaxCredentialResolution[] {
  const root = objectValue(value);
  if (!root)
    return [
      {
        status: "invalid",
        source: MINIMAX_CLI_SOURCE,
        path,
        error: "json_parse_error",
      },
    ];
  const apiKey = usableLiteralSecret(root.api_key);
  const oauth = objectValue(root.oauth);
  const accessToken = usableLiteralSecret(oauth?.access_token);
  const baseUrl = configBaseUrl(root);
  const credentials: MiniMaxCredentialResolution[] = [];
  if (accessToken) {
    credentials.push({
      status: "available",
      key: accessToken,
      source: MINIMAX_CLI_SOURCE,
      path,
      baseUrl,
    });
  }
  if (apiKey) {
    credentials.push({
      status: "available",
      key: apiKey,
      source: MINIMAX_CLI_SOURCE,
      path,
      baseUrl,
    });
  }
  if (credentials.length > 0) return credentials;
  const hasCredential = Object.hasOwn(root, "api_key") || oauth !== undefined;
  return [
    hasCredential
      ? {
          status: "invalid",
          source: MINIMAX_CLI_SOURCE,
          path,
          error: "credential_missing",
        }
      : missingCliCredential(path),
  ];
}

function missingCliCredential(path: string): MiniMaxCredentialResolution {
  return { status: "missing", source: MINIMAX_CLI_SOURCE, path };
}

export function resolveMiniMaxCredential(): MiniMaxCredentialResolution {
  const credentials = resolveMiniMaxCredentials();
  return chooseMiniMaxCredential(credentials);
}

export function resolveMiniMaxCredentials(): MiniMaxCredentialResolution[] {
  const credentials: MiniMaxCredentialResolution[] = [];
  const envKey = usableLiteralSecret(process.env.MINIMAX_API_KEY);
  if (envKey) {
    credentials.push({
      status: "available",
      key: envKey,
      source: MINIMAX_ENV_SOURCE,
      baseUrl: configuredBaseUrl(),
    });
  }

  const piPath = piAuthFilePath();
  const piResult = readBoundedJsonFile(piPath);
  if (piResult.status === "success") {
    const resolution = extractMiniMaxCredential(piResult.value, piPath);
    if (resolution.status !== "missing") credentials.push(resolution);
  } else if (piResult.status === "invalid") {
    credentials.push({
      status: piResult.error === "file_read_error" ? "error" : "invalid",
      source: MINIMAX_PI_SOURCE,
      path: piPath,
      error: piResult.error,
    });
  }

  const cliPath = minimaxConfigPath();
  const cliResult = readBoundedJsonFile(cliPath);
  if (cliResult.status === "success") {
    const resolutions = extractMiniMaxCliCredentials(cliResult.value, cliPath);
    credentials.push(
      ...resolutions.filter((resolution) => resolution.status !== "missing"),
    );
  } else if (cliResult.status === "invalid") {
    credentials.push({
      status: cliResult.error === "file_read_error" ? "error" : "invalid",
      source: MINIMAX_CLI_SOURCE,
      path: cliPath,
      error: cliResult.error,
    });
  }

  return credentials.length > 0
    ? credentials
    : [{ status: "missing", source: MINIMAX_CLI_SOURCE, path: cliPath }];
}

export function createMiniMaxAdapter(
  overrides: Partial<MiniMaxDependencies> = {},
): ProviderAdapter {
  const dependencies: MiniMaxDependencies = {
    credential: resolveMiniMaxCredentials,
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "minimax",
    label: LABEL,
    fetchQuota: () => fetchQuotaWithDependencies(dependencies),
    inspectAuth: () => inspectAuthWithDependencies(dependencies),
  };
}

export const minimaxAdapter = createMiniMaxAdapter();

async function fetchQuotaWithDependencies(
  dependencies: MiniMaxDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalFailure: MiniMaxFailure | undefined;
  for (const resolution of credentialCandidates(dependencies)) {
    if (resolution.attempts) attempts.push(...resolution.attempts);
    if (resolution.status !== "available") {
      const failure = credentialFailure(resolution);
      replaceCredentialAttempt(attempts, resolution.source, {
        source: resolution.source,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.code,
      });
      finalFailure = preferMiniMaxFailure(finalFailure, failure);
      continue;
    }

    try {
      const payload = await requestMiniMax(
        resolution.key,
        resolution.baseUrl,
        dependencies.fetch,
        dependencies.deadlineMs,
      );
      const normalized = normalizeMiniMaxPayload(payload);
      if (
        normalized.windows.length === 0 &&
        normalized.credits === undefined &&
        !isAuthoritativeEmptyMiniMaxAllocation(payload)
      ) {
        throw new MiniMaxFailure("quota_missing", { staleEligible: true });
      }
      replaceCredentialAttempt(attempts, resolution.source, {
        source: resolution.source,
        status: "success",
      });
      return successProvider({
        provider: "minimax",
        label: LABEL,
        source: "api",
        ...(normalized.plan ? { plan: normalized.plan } : {}),
        windows: normalized.windows,
        ...(normalized.credits ? { credits: normalized.credits } : {}),
        refreshedAt: new Date(dependencies.now()).toISOString(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      const failure =
        error instanceof MiniMaxFailure
          ? error
          : new MiniMaxFailure(errorCode(error), { staleEligible: true });
      replaceCredentialAttempt(attempts, resolution.source, {
        source: resolution.source,
        status: "failed",
        error: failure.code,
      });
      if (failure.definitiveAuth) {
        finalFailure = preferMiniMaxFailure(finalFailure, failure);
        continue;
      }
      if (failure.staleEligible) {
        try {
          const cached = dependencies.readCachedProvider("minimax");
          if (cached) {
            return staleFromCache(
              cached,
              failure.code,
              sourceNames(attempts),
              attempts,
            );
          }
        } catch {
          // Cache I/O cannot replace the bounded provider failure.
        }
      }
      return failedProvider({
        provider: "minimax",
        label: LABEL,
        status: failure.status,
        error: failure.code,
        source: "unavailable",
        retryAfter: failure.retryAfter,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }
  }

  const failure =
    finalFailure ??
    new MiniMaxFailure("minimax_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("minimax");
    } catch {
      // Preserve the current definitive auth result.
    }
  }
  return failedProvider({
    provider: "minimax",
    label: LABEL,
    status: failure.status,
    error: failure.code,
    source: "unavailable",
    retryAfter: failure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuthWithDependencies(
  dependencies: MiniMaxDependencies,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = credentialCandidates(dependencies).map(
    (resolution) => ({
      source: resolution.source,
      ...(resolution.path ? { path: resolution.path } : {}),
      status:
        resolution.status === "available"
          ? "available"
          : resolution.status === "missing"
            ? "missing"
            : resolution.status === "error"
              ? "error"
              : "invalid",
      ...(resolution.status !== "available" && resolution.error
        ? { error: resolution.error }
        : {}),
      ...(resolution.status === "available" ? { credentialPresent: true } : {}),
    }),
  );
  return { provider: "minimax", sources };
}

export function normalizeMiniMaxPayload(
  raw: unknown,
): NormalizedMiniMaxPayload {
  const root = objectValue(raw);
  if (!root) return { windows: [] };
  const balanceRoot = objectValue(root.data) ?? root;
  const balance = numberValue(balanceRoot.available_amount);
  if (balance !== undefined) {
    return { windows: [], credits: { remaining: balance, unit: "usd" } };
  }

  const data = objectValue(root.data) ?? root;
  const rows =
    data && Array.isArray(data.model_remains) ? data.model_remains : [];
  const windows = rows.flatMap(normalizeModelRemain);
  const plan = firstString(data, ["plan", "plan_name", "planName"]);
  return { windows, ...(plan ? { plan } : {}) };
}

function normalizeModelRemain(raw: unknown): QuotaWindow[] {
  const row = objectValue(raw);
  const modelName = stringValue(row?.model_name);
  if (!row || !modelName) return [];
  const modelId = modelSlug(modelName);
  if (!modelId) return [];
  const interval = normalizeModelWindow(
    row,
    modelId,
    modelName,
    "current_interval",
  );
  const weekly = normalizeModelWindow(
    row,
    modelId,
    modelName,
    "current_weekly",
  );
  return [interval, weekly].filter(
    (window): window is QuotaWindow => window !== undefined,
  );
}

function normalizeModelWindow(
  row: Record<string, unknown>,
  modelId: string,
  modelName: string,
  prefix: "current_interval" | "current_weekly",
): QuotaWindow | undefined {
  const status = numberValue(row[`${prefix}_status`]);
  const total = numberValue(row[`${prefix}_total_count`]);
  const reported = numberValue(row[`${prefix}_usage_count`]);
  if (isNoAllocationModelWindow(row, prefix)) return undefined;

  const startKey =
    prefix === "current_interval" ? "start_time" : "weekly_start_time";
  const endKey = prefix === "current_interval" ? "end_time" : "weekly_end_time";
  if (
    ![
      `${prefix}_status`,
      `${prefix}_total_count`,
      `${prefix}_usage_count`,
      `${prefix}_remaining_percent`,
      startKey,
      endKey,
    ].some((key) => Object.hasOwn(row, key))
  ) {
    return undefined;
  }
  const startsAt = parseEpoch(row[startKey]);
  const resetsAt = parseEpoch(row[endKey]);
  const windowSeconds =
    startsAt && resetsAt
      ? (Date.parse(resetsAt) - Date.parse(startsAt)) / 1000
      : undefined;
  const explicit = numberValue(row[`${prefix}_remaining_percent`]);
  const percentRemaining =
    explicit !== undefined
      ? clampPercent(explicit)
      : remainingFromCounts(reported, total);
  const identity = miniMaxWindowIdentity(prefix, windowSeconds);
  const remaining = percentRemaining ?? (status === 2 ? 0 : undefined);
  return {
    id: `model:${modelId}:${identity.idSuffix}`,
    label: `${modelName} ${identity.label}`,
    kind: "model",
    ...(remaining !== undefined
      ? {
          percentUsed: clampPercent(100 - remaining),
          percentRemaining: remaining,
        }
      : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowSeconds !== undefined && windowSeconds > 0
      ? { windowSeconds }
      : {}),
  };
}

function isAuthoritativeEmptyMiniMaxAllocation(payload: unknown): boolean {
  const root = objectValue(payload);
  const data = objectValue(objectValue(root)?.data) ?? root;
  const rows =
    data && Array.isArray(data.model_remains) ? data.model_remains : [];
  return rows.length > 0 && rows.every(isNoAllocationModelRemain);
}

function isNoAllocationModelRemain(raw: unknown): boolean {
  const row = objectValue(raw);
  return (
    row !== undefined &&
    stringValue(row.model_name) !== undefined &&
    isNoAllocationModelWindow(row, "current_interval") &&
    isNoAllocationModelWindow(row, "current_weekly")
  );
}

function isNoAllocationModelWindow(
  row: Record<string, unknown>,
  prefix: "current_interval" | "current_weekly",
): boolean {
  return (
    numberValue(row[`${prefix}_status`]) === 3 &&
    numberValue(row[`${prefix}_total_count`]) === 0 &&
    numberValue(row[`${prefix}_usage_count`]) === 0
  );
}

function miniMaxWindowIdentity(
  prefix: "current_interval" | "current_weekly",
  windowSeconds: number | undefined,
): { idSuffix: string; label: string } {
  if (windowSeconds === 18_000) return { idSuffix: "5h", label: "5h" };
  if (windowSeconds === 604_800) return { idSuffix: "7d", label: "7d" };
  if (windowSeconds !== undefined && windowSeconds > 0) {
    const label = formatMiniMaxWindowSeconds(windowSeconds);
    return { idSuffix: `window:${label}`, label };
  }
  return prefix === "current_weekly"
    ? { idSuffix: "window:weekly", label: "weekly" }
    : { idSuffix: "window:current_interval", label: "current interval" };
}

function formatMiniMaxWindowSeconds(seconds: number): string {
  if (Number.isInteger(seconds / 86_400)) return `${seconds / 86_400}d`;
  if (Number.isInteger(seconds / 3_600)) return `${seconds / 3_600}h`;
  if (Number.isInteger(seconds / 60)) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function remainingFromCounts(
  reported: number | undefined,
  total: number | undefined,
): number | undefined {
  if (
    reported === undefined ||
    total === undefined ||
    total <= 0 ||
    reported < 0 ||
    reported > total
  )
    return undefined;
  // MiniMax's official CLI preserves the legacy meaning of usage_count when
  // no explicit percentage is present: it is the remaining count.
  return clampPercent((reported / total) * 100);
}

async function requestMiniMax(
  key: string,
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<unknown> {
  const apiKey = key.startsWith("sk-api-");
  const url = `${baseUrl}${apiKey ? MINIMAX_BALANCE_PATH : MINIMAX_QUOTA_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let response: Response | undefined;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await cancelBody(response);
      if (response.status === 401 || response.status === 403)
        throw new MiniMaxFailure("provider_auth_rejected", {
          status: "auth_required",
          definitiveAuth: true,
        });
      if (response.status === 429)
        throw new MiniMaxFailure("provider_rate_limited", {
          status: "rate_limited",
          staleEligible: true,
          retryAfter: normalizeRetryAfter(response.headers.get("retry-after")),
        });
      throw new MiniMaxFailure("provider_request_rejected", {
        staleEligible: true,
      });
    }
    const body = await readResponseBody(response, controller.signal);
    try {
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      ) as unknown;
      rejectMiniMaxApplicationError(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof MiniMaxFailure) throw error;
      throw new MiniMaxFailure("malformed_json", { staleEligible: true });
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new MiniMaxFailure("provider_timeout", { staleEligible: true });
    if (error instanceof MiniMaxFailure) throw error;
    throw new MiniMaxFailure("network_unavailable", { staleEligible: true });
  } finally {
    clearTimeout(timer);
  }
}

function rejectMiniMaxApplicationError(payload: unknown): void {
  const baseResp = objectValue(payload)?.base_resp;
  const statusCode = numberValue(objectValue(baseResp)?.status_code);
  if (statusCode === undefined || statusCode === 0) return;
  if (statusCode === 1004 || statusCode === 2049) {
    throw new MiniMaxFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (statusCode === 1002) {
    throw new MiniMaxFailure("provider_rate_limited", {
      status: "rate_limited",
    });
  }
  throw new MiniMaxFailure("provider_request_rejected", {
    staleEligible: true,
  });
}

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length")?.trim();
  if (
    declared &&
    /^\d+$/.test(declared) &&
    Number(declared) > RESPONSE_LIMIT_BYTES
  ) {
    await cancelBody(response);
    throw new MiniMaxFailure("response_too_large", { staleEligible: true });
  }
  if (!response.body)
    throw new MiniMaxFailure("response_size_unverifiable", {
      staleEligible: true,
    });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted)
        throw new MiniMaxFailure("provider_timeout", { staleEligible: true });
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > RESPONSE_LIMIT_BYTES)
        throw new MiniMaxFailure("response_too_large", { staleEligible: true });
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing a rejected response body is best effort.
  }
}

function credentialCandidates(
  dependencies: MiniMaxDependencies,
): MiniMaxCredentialResolution[] {
  const credentials = dependencies.credential();
  return Array.isArray(credentials) ? credentials : [credentials];
}

function chooseMiniMaxCredential(
  resolutions: MiniMaxCredentialResolution[],
): MiniMaxCredentialResolution {
  const attempts: SourceAttempt[] = [];
  for (const resolution of resolutions) {
    if (resolution.status === "available") {
      return withCredentialAttempts(resolution, attempts);
    }
    attempts.push({
      source: resolution.source,
      status: resolution.status === "missing" ? "skipped" : "failed",
      error: credentialError(resolution),
    });
  }
  const failed =
    resolutions.find((resolution) => resolution.status === "error") ??
    resolutions.find((resolution) => resolution.status === "invalid") ??
    resolutions[0] ??
    ({ status: "missing", source: MINIMAX_CLI_SOURCE } as const);
  return withCredentialAttempts(failed, attempts);
}

function preferMiniMaxFailure(
  current: MiniMaxFailure | undefined,
  next: MiniMaxFailure,
): MiniMaxFailure {
  if (!current || (current.definitiveAuth && !next.definitiveAuth)) return next;
  return current;
}

function withCredentialAttempts<T extends MiniMaxCredentialResolution>(
  resolution: T,
  attempts: SourceAttempt[],
): T {
  return { ...resolution, attempts };
}

function replaceCredentialAttempt(
  attempts: SourceAttempt[],
  source: string,
  attempt: SourceAttempt,
): void {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].source === source) {
      attempts[index] = attempt;
      return;
    }
  }
  attempts.push(attempt);
}

function credentialFailure(
  resolution: Exclude<MiniMaxCredentialResolution, { status: "available" }>,
): MiniMaxFailure {
  if (resolution.status === "missing")
    return new MiniMaxFailure("minimax_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    });
  if (resolution.status === "invalid")
    return new MiniMaxFailure("minimax_credential_invalid", {
      status: "auth_required",
      definitiveAuth: true,
    });
  return new MiniMaxFailure("credential_resolution_failed", {
    staleEligible: true,
  });
}

function credentialError(
  resolution: Exclude<MiniMaxCredentialResolution, { status: "available" }>,
): string {
  if (resolution.error) return resolution.error;
  return resolution.status === "missing"
    ? "minimax_credential_unavailable"
    : resolution.status === "invalid"
      ? "minimax_credential_invalid"
      : "credential_resolution_failed";
}

function configuredBaseUrl(): string {
  return safeBaseUrl(process.env.MINIMAX_BASE_URL) ?? MINIMAX_GLOBAL_BASE_URL;
}

function configBaseUrl(root: Record<string, unknown>): string {
  const explicit =
    safeBaseUrl(stringValue(root.base_url)) ??
    safeBaseUrl(stringValue(objectValue(root.oauth)?.resource_url));
  if (explicit) return explicit;
  return stringValue(root.region)?.toLowerCase() === "cn"
    ? MINIMAX_CHINA_BASE_URL
    : configuredBaseUrl();
}

function safeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return undefined;
    if (
      parsed.hostname !== "api.minimax.io" &&
      parsed.hostname !== "api.minimaxi.com"
    )
      return undefined;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function readBoundedJsonFile(path: string): JsonFileReadResult {
  let text: string;
  try {
    const size = statSync(path).size;
    if (size > CONFIG_FILE_LIMIT_BYTES)
      return { status: "invalid", error: "file_too_large" };
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = objectValue(error)?.code;
    return code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", error: "file_read_error" };
  }
  if (Buffer.byteLength(text, "utf8") > CONFIG_FILE_LIMIT_BYTES)
    return { status: "invalid", error: "file_too_large" };
  try {
    return { status: "success", value: JSON.parse(text) };
  } catch {
    return { status: "invalid", error: "json_parse_error" };
  }
}

function extractKey(
  entry: Record<string, unknown> | undefined,
): string | undefined {
  if (!entry) return undefined;
  for (const field of ["key", "apiKey", "api_key", "access", "accessToken"]) {
    const key = usableLiteralSecret(entry[field]);
    if (key) return key;
  }
  return undefined;
}

function parseEpoch(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return parseEpoch(numeric);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeRetryAfter(value: string | null): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    return isoFromTimestamp(Date.now() + Number(raw) * 1000);
  }
  return isoFromTimestamp(Date.parse(raw));
}

function isoFromTimestamp(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function modelSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorCode(error: unknown): string {
  return error instanceof MiniMaxFailure ? error.code : "quota_request_failed";
}

class MiniMaxFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: MiniMaxFailureOptions = {}) {
    super(code);
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible ?? false;
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.retryAfter = options.retryAfter;
  }
}
