import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
} from "./common.js";

const CONSUMER_QUOTA_URL =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const API_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const GRPC_MESSAGE_LIMIT_CHARS = 1_024;
const EMPTY_GRPC_REQUEST = Uint8Array.from([0, 0, 0, 0, 0]);
const GROK_SOURCE = "web" as const;

const PRODUCT_NAMES: Record<number, { id: string; label: string }> = {
  0: { id: "unspecified", label: "Other" },
  1: { id: "api", label: "API" },
  2: { id: "grok_build", label: "Grok Build" },
  3: { id: "grok_plugins", label: "Grok Plugins" },
  4: { id: "chat", label: "Chat" },
  5: { id: "imagine", label: "Imagine" },
  6: { id: "voice", label: "Voice" },
};

type GrokCredentials = {
  key: string;
  email?: string;
  teamId?: string;
  expiresAt?: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: GrokCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid" | "expired"; source: AuthSourceReport };

type CredentialCandidate = GrokCredentials & {
  scope?: string;
  raw: Record<string, unknown>;
};

type NormalizedGrokQuota = {
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
};

type VarintField = { field: number; wire: 0; value: bigint };
type ByteField = { field: number; wire: 1 | 2 | 5; value: Uint8Array };
type ProtoField = VarintField | ByteField;

export const grokAdapter: ProviderAdapter = {
  id: "grok",
  label: "Grok",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;
  let retryAfter: string | undefined;

  const credentialState = readCredentialState();
  if (credentialState.status === "available") {
    attempts.push({ source: GROK_SOURCE, status: "failed" });
    try {
      const quota = await fetchGrokConsumerQuota(credentialState.credentials);
      attempts[attempts.length - 1] = {
        source: GROK_SOURCE,
        status: "success",
      };
      return successProvider({
        provider: "grok",
        label: "Grok",
        source: GROK_SOURCE,
        account: quota.account,
        windows: quota.windows,
        credits: quota.credits,
        refreshedAt: quota.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      finalError = errorMessage(error);
      attempts[attempts.length - 1] = {
        source: GROK_SOURCE,
        status: "failed",
        error: finalError,
      };
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
    }
  } else {
    attempts.push({
      source: credentialState.source.source,
      status: "skipped",
      error: `credentials_${credentialState.status}`,
    });
    finalError = "Grok sign-in required";
  }

  const cached = readCachedProvider("grok");
  if (cached?.source === GROK_SOURCE) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "grok",
    label: "Grok",
    status: retryAfter ? "rate_limited" : statusFromError(finalError),
    error: finalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const credentialState = readCredentialState();
  return { provider: "grok", sources: [credentialState.source] };
}

export function normalizeGrokConsumerPayload(
  payload: Uint8Array,
  credentials?: Pick<GrokCredentials, "email" | "teamId">,
): NormalizedGrokQuota {
  const response = scanMessage(payload);
  const config = firstMessage(response, 1);
  if (!config) throw new ProtocolError();

  const currentPeriod = firstMessage(config, 8);
  const periodType = currentPeriod
    ? periodTypeAt(currentPeriod)
    : "unspecified";
  const periodStart = currentPeriod ? timestampAt(currentPeriod, 2) : undefined;
  const resetsAt = currentPeriod ? timestampAt(currentPeriod, 3) : undefined;
  const validCurrentPeriod =
    (periodType === "weekly" || periodType === "monthly") &&
    periodStart !== undefined &&
    resetsAt !== undefined;

  const windows: QuotaWindow[] = [];
  const sharedExplicit = floatAt(config, 1);
  if (sharedExplicit !== undefined || validCurrentPeriod) {
    const percentUsed = clampExactPercent(sharedExplicit ?? 0);
    windows.push({
      id: "credits",
      label: "credits",
      kind: "credits",
      percentUsed,
      percentRemaining: 100 - percentUsed,
      resetsAt,
    });
  }

  for (const productPayload of messagesAt(config, 7)) {
    const product = scanMessage(productPayload);
    const explicit = floatAt(product, 2);
    if (explicit === undefined && !validCurrentPeriod) continue;
    const productNumber = safeNumber(varintAt(product, 1) ?? 0n);
    if (productNumber === undefined) continue;
    const productName = PRODUCT_NAMES[productNumber] ?? {
      id: `unknown_${productNumber}`,
      label: `Product ${productNumber}`,
    };
    const percentUsed = clampExactPercent(explicit ?? 0);
    windows.push({
      id: `product:${productName.id}`,
      label: productName.label,
      kind: "credits",
      percentUsed,
      percentRemaining: 100 - percentUsed,
      resetsAt,
    });
  }

  if (windows.length === 0) throw new ProtocolError();

  const prepaid = firstMessage(config, 12);
  const prepaidBalance = prepaid
    ? safeNumber(varintAt(prepaid, 1) ?? 0n)
    : undefined;
  if (prepaid && prepaidBalance === undefined) throw new ProtocolError();

  return {
    account: {
      email: credentials?.email,
      organization: credentials?.teamId,
    },
    windows,
    credits:
      prepaidBalance === undefined
        ? undefined
        : { remaining: prepaidBalance, unit: "credits" },
    refreshedAt: nowIso(),
  };
}

async function fetchGrokConsumerQuota(
  credentials: GrokCredentials,
): Promise<NormalizedGrokQuota> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(CONSUMER_QUOTA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.key}`,
          Accept: "*/*",
          "Content-Type": "application/grpc-web+proto",
          Origin: "https://grok.com",
          Referer: "https://grok.com/?_s=usage",
          "x-grpc-web": "1",
          "x-user-agent": "connect-es/2.1.1",
        },
        body: EMPTY_GRPC_REQUEST,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted)
        throw new TimeoutError();
      throw new SafeGrokError("Grok quota unavailable");
    }

    rejectUnusableUsageResponse(response);
    throwForGrpcStatus(
      response.headers.get("grpc-status"),
      response.headers.get("grpc-message"),
    );

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof SafeGrokError) throw error;
      if (isAbortError(error) || controller.signal.aborted)
        throw new TimeoutError();
      throw new SafeGrokError("Grok quota unavailable");
    }

    const payload = decodeGrpcWebPayload(bytes);
    return normalizeGrokConsumerPayload(payload, credentials);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    if (BigInt(contentLength) > BigInt(RESPONSE_LIMIT_BYTES))
      throw new ResponseTooLargeError();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
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

function decodeGrpcWebPayload(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) throw new ProtocolError();
  if (!looksFramed(bytes[0])) return bytes;

  const dataFrames: Uint8Array[] = [];
  let trailerSeen = false;
  let index = 0;
  while (index < bytes.length) {
    if (index + 5 > bytes.length) throw new ProtocolError();
    const flags = bytes[index];
    if ((flags & 0x01) !== 0) throw new ProtocolError();
    if (flags !== 0 && flags !== 0x80) throw new ProtocolError();

    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + index + 1,
      4,
    ).getUint32(0);
    if (length > RESPONSE_LIMIT_BYTES) throw new ProtocolError();
    const start = index + 5;
    const end = start + length;
    if (!Number.isSafeInteger(end) || end > bytes.length)
      throw new ProtocolError();

    const frame = bytes.slice(start, end);
    if (flags === 0x80) {
      if (trailerSeen) throw new ProtocolError();
      trailerSeen = true;
      const trailers = parseTrailerFields(frame);
      throwForGrpcStatus(
        trailers.get("grpc-status") ?? null,
        trailers.get("grpc-message") ?? null,
      );
    } else {
      if (trailerSeen || dataFrames.length > 0) throw new ProtocolError();
      dataFrames.push(frame);
    }
    index = end;
  }

  if (dataFrames.length !== 1) throw new ProtocolError();
  return dataFrames[0];
}

function looksFramed(firstByte: number): boolean {
  return firstByte === 0 || firstByte === 1 || (firstByte & 0x80) !== 0;
}

function parseTrailerFields(bytes: Uint8Array): Map<string, string> {
  const trailers = new Map<string, string>();
  const text = new TextDecoder().decode(bytes);
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    trailers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return trailers;
}

function throwForGrpcStatus(
  value: string | null,
  message: string | null = null,
): void {
  if (value === null) return;
  if (!/^(?:[0-9]|1[0-6])$/.test(value)) throw new ProtocolError();
  const status = Number(value);
  if (status === 0) return;
  if (status === 16) throw new SafeGrokError("Grok sign-in required");
  if (status === 7 && grpcMessageIndicatesAuthFailure(message))
    throw new SafeGrokError("Grok sign-in required");
  if (status === 8) throw new RateLimitError();
  throw new SafeGrokError("Grok quota unavailable");
}

function grpcMessageIndicatesAuthFailure(value: string | null): boolean {
  if (!value || value.length > GRPC_MESSAGE_LIMIT_CHARS) return false;
  let message: string;
  try {
    message = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (message.length > GRPC_MESSAGE_LIMIT_CHARS) return false;
  return (
    /\b(?:unauthenticated|authentication required|sign[ -]?in required)\b/i.test(
      message,
    ) ||
    /\b(?:invalid|expired|missing|revoked)\s+(?:(?:oauth|access|auth(?:entication)?|bearer)\s+)*(?:token|credentials?|jwt)\b/i.test(
      message,
    ) ||
    /\b(?:token|credentials?|jwt)\s+(?:is |are )?(?:invalid|expired|missing|revoked)\b/i.test(
      message,
    )
  );
}

function scanMessage(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let index = 0;
  while (index < bytes.length) {
    const key = readVarint(bytes, index);
    index = key.index;
    const fieldValue = key.value >> 3n;
    if (fieldValue <= 0n || fieldValue > 0x1fffffffn) throw new ProtocolError();
    const field = Number(fieldValue);
    const wire = Number(key.value & 7n);

    if (wire === 0) {
      const scalar = readVarint(bytes, index);
      fields.push({ field, wire, value: scalar.value });
      index = scalar.index;
      continue;
    }

    if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (index + length > bytes.length) throw new ProtocolError();
      fields.push({
        field,
        wire,
        value: bytes.slice(index, index + length),
      });
      index += length;
      continue;
    }

    if (wire === 2) {
      const lengthValue = readVarint(bytes, index);
      index = lengthValue.index;
      if (lengthValue.value > BigInt(RESPONSE_LIMIT_BYTES))
        throw new ProtocolError();
      const length = Number(lengthValue.value);
      const end = index + length;
      if (!Number.isSafeInteger(end) || end > bytes.length)
        throw new ProtocolError();
      fields.push({ field, wire, value: bytes.slice(index, end) });
      index = end;
      continue;
    }

    throw new ProtocolError();
  }
  return fields;
}

function readVarint(
  bytes: Uint8Array,
  start: number,
): { value: bigint; index: number } {
  let value = 0n;
  let index = start;
  for (let count = 0; count < 10 && index < bytes.length; count += 1) {
    const byte = bytes[index];
    index += 1;
    if (count === 9 && byte > 1) throw new ProtocolError();
    value |= BigInt(byte & 0x7f) << BigInt(count * 7);
    if ((byte & 0x80) === 0) return { value, index };
  }
  throw new ProtocolError();
}

function messagesAt(fields: ProtoField[], field: number): Uint8Array[] {
  return fields
    .filter(
      (entry): entry is ByteField => entry.field === field && entry.wire === 2,
    )
    .map((entry) => entry.value);
}

function firstMessage(
  fields: ProtoField[],
  field: number,
): ProtoField[] | undefined {
  const bytes = messagesAt(fields, field)[0];
  return bytes ? scanMessage(bytes) : undefined;
}

function varintAt(fields: ProtoField[], field: number): bigint | undefined {
  return fields.find(
    (entry): entry is VarintField => entry.field === field && entry.wire === 0,
  )?.value;
}

function floatAt(fields: ProtoField[], field: number): number | undefined {
  const found = fields.find(
    (entry): entry is ByteField => entry.field === field && entry.wire === 5,
  );
  if (!found) return undefined;
  const value = new DataView(
    found.value.buffer,
    found.value.byteOffset,
    4,
  ).getFloat32(0, true);
  if (!Number.isFinite(value)) throw new ProtocolError();
  return value;
}

function timestampAt(fields: ProtoField[], field: number): string | undefined {
  const timestamp = firstMessage(fields, field);
  if (!timestamp) return undefined;
  const seconds = safeNumber(varintAt(timestamp, 1));
  if (seconds === undefined) return undefined;
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function periodTypeAt(
  period: ProtoField[],
): "weekly" | "monthly" | "unspecified" {
  const value = varintAt(period, 1);
  if (value === 2n) return "weekly";
  if (value === 1n) return "monthly";
  return "unspecified";
}

function safeNumber(value: bigint | undefined): number | undefined {
  if (value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER))
    return undefined;
  return Number(value);
}

function clampExactPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function readCredentialState(): CredentialState {
  const explicitAuthFile = stringValue(process.env.GROK_AUTH_JSON);
  if (explicitAuthFile) {
    return extractCredentialState(
      readJsonFileResult(explicitAuthFile),
      explicitAuthFile,
    );
  }
  const inlineAuth = stringValue(process.env.GROK_AUTH);
  if (inlineAuth) {
    return extractCredentialState(
      readInlineAuth(inlineAuth),
      undefined,
      "auth-env",
    );
  }
  const authFile = grokAuthFile();
  return extractCredentialState(readJsonFileResult(authFile), authFile);
}

function readInlineAuth(value: string): JsonFileReadResult {
  const text = value.trim();
  try {
    return { status: "success", value: normalizeInlineAuth(JSON.parse(text)) };
  } catch {
    return { status: "success", value: inlineTokenAuth(text) };
  }
}

function normalizeInlineAuth(value: unknown): unknown {
  return typeof value === "string" ? inlineTokenAuth(value) : value;
}

function inlineTokenAuth(key: string): Record<string, unknown> {
  return { "https://accounts.x.ai/sign-in": { key } };
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path?: string,
  source = "auth-json",
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: authSource(source, path, "missing"),
    };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: authSource(source, path, "invalid", raw.error),
    };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "invalid",
      source: authSource(source, path, "invalid"),
    };
  let expired = false;
  for (const candidate of selectedCredentialCandidates(data)) {
    const expiresAt = candidate.expiresAt;
    if (isExpired(expiresAt)) {
      expired = true;
      continue;
    }
    return {
      status: "available",
      credentials: {
        key: candidate.key,
        email: candidate.email,
        teamId: candidate.teamId,
        expiresAt,
      },
      source: authSource(source, path, "available"),
    };
  }
  if (expired) {
    return {
      status: "expired",
      source: authSource(source, path, "expired"),
    };
  }
  return {
    status: "invalid",
    source: authSource(source, path, "invalid"),
  };
}

function grokAuthFile(): string {
  return (
    stringValue(process.env.GROK_AUTH_JSON) ??
    stringValue(process.env.GROK_AUTH_PATH) ??
    join(grokHomeDir(), "auth.json")
  );
}

function grokHomeDir(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new SafeGrokError("Grok sign-in required");
  }
  if (response.status === 429) {
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  }
  if (!response.ok) throw new SafeGrokError("Grok quota unavailable");
}

function isExpired(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed <= Date.now();
}

function authSource(
  source: string,
  path: string | undefined,
  status: AuthSourceReport["status"],
  error?: string,
): AuthSourceReport {
  return {
    source,
    path,
    status,
    error,
  };
}

function selectedCredentialCandidates(
  data: Record<string, unknown>,
): CredentialCandidate[] {
  const candidates = credentialCandidates(data);
  const sessionCandidates = candidates.filter(isGrokSessionCandidate);
  if (sessionCandidates.length > 0) return sessionCandidates;
  return candidates.filter((candidate) => !isGrokApiKeyCandidate(candidate));
}

function credentialCandidates(
  data: Record<string, unknown>,
): CredentialCandidate[] {
  const direct = credentialCandidate(data, stringValue(data.scope));
  if (direct) return [direct];
  return Object.entries(data).flatMap(([scope, value]) => {
    const item = objectValue(value);
    const candidate = item ? credentialCandidate(item, scope) : undefined;
    return candidate ? [candidate] : [];
  });
}

function credentialCandidate(
  item: Record<string, unknown>,
  scope: string | undefined,
): CredentialCandidate | undefined {
  const key = stringValue(item.key);
  if (!key) return undefined;
  return {
    key,
    scope: credentialScope(scope, item),
    raw: item,
    email: stringValue(item.email),
    teamId: stringValue(item.team_id) ?? stringValue(item.teamId),
    expiresAt: stringValue(item.expires_at) ?? stringValue(item.expiresAt),
  };
}

function credentialScope(
  scope: string | undefined,
  item: Record<string, unknown>,
): string | undefined {
  return (
    stringValue(item.scope) ??
    stringValue(item.url) ??
    stringValue(item.audience) ??
    scope
  );
}

function isGrokSessionCandidate(candidate: CredentialCandidate): boolean {
  if (isGrokApiKeyCandidate(candidate)) return false;
  const scope = parseScope(candidate.scope);
  if (!scope) return false;
  if (scope.host === "auth.x.ai" && isOidcCredential(candidate.raw))
    return true;
  if (scope.host === "accounts.x.ai" && scope.path.startsWith("/sign-in"))
    return true;
  return scope.host === "grok.com" || scope.host === "www.grok.com";
}

function isOidcCredential(item: Record<string, unknown>): boolean {
  const authMode =
    stringValue(item.auth_mode)?.toLowerCase() ??
    stringValue(item.authMode)?.toLowerCase();
  return authMode === "oidc";
}

function isGrokApiKeyCandidate(candidate: CredentialCandidate): boolean {
  const scope = parseScope(candidate.scope);
  const loweredScope = candidate.scope?.toLowerCase() ?? "";
  const type =
    stringValue(candidate.raw.type)?.toLowerCase() ??
    stringValue(candidate.raw.kind)?.toLowerCase();
  return (
    type === "api-key" ||
    type === "api_key" ||
    loweredScope.includes("api-key") ||
    loweredScope.includes("api_key") ||
    scope?.host === "api.x.ai" ||
    scope?.host === "api.grok.com"
  );
}

function parseScope(
  value: string | undefined,
): { host: string; path: string } | undefined {
  if (!value) return undefined;
  const scope = normalizeCredentialScope(value);
  try {
    const url = new URL(scope.includes("://") ? scope : `https://${scope}`);
    return { host: url.hostname.toLowerCase(), path: url.pathname };
  } catch {
    return undefined;
  }
}

function normalizeCredentialScope(value: string): string {
  return value.replace(/::[^/]*$/, "");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof SafeGrokError
    ? error.message
    : "Grok quota unavailable";
}

class SafeGrokError extends Error {}

class ProtocolError extends SafeGrokError {
  constructor() {
    super("Grok quota response invalid");
  }
}

class ResponseTooLargeError extends SafeGrokError {
  constructor() {
    super("Grok quota response too large");
  }
}

class TimeoutError extends SafeGrokError {
  constructor() {
    super("Grok quota request timed out");
  }
}

class RateLimitError extends SafeGrokError {
  constructor(readonly retryAfter?: string) {
    super("Grok quota endpoint rate limited");
  }
}
