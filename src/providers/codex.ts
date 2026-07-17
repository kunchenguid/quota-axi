import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { findCommandPath, terminateChild } from "../lib/process.js";
import {
  clampPercent,
  nowIso,
  parseEpochOrIso,
  retryAfterToIso,
} from "../lib/time.js";
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
  withRemaining,
} from "./common.js";

const ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
];
const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 8_000;
const CODEX_BINARY_ENV = "QUOTA_AXI_CODEX_BINARY";

type CodexBinaryState =
  | { status: "available"; path: string }
  | { status: "missing"; path?: string; error?: string };

type CodexCredentials = {
  accessToken: string;
  accountId?: string;
};

type AvailableCredentialState = {
  status: "available";
  credentials: CodexCredentials;
  source: AuthSourceReport;
};
type UnavailableCredentialState = {
  status: "missing" | "invalid" | "expired";
  source: AuthSourceReport;
};
type CredentialState = AvailableCredentialState | UnavailableCredentialState;

type RawWindow = {
  used_percent?: unknown;
  usedPercent?: unknown;
  reset_at?: unknown;
  resetsAt?: unknown;
  reset_after_seconds?: unknown;
  limit_window_seconds?: unknown;
  windowDurationMins?: unknown;
};

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  label: "Codex",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError = "Codex quota unavailable";
  let retryAfter: string | undefined;

  const credentialState = readCredentialState();
  if (credentialState.status === "available") {
    attempts.push({ source: "oauth", status: "failed" });
    try {
      const quota = await fetchOauthUsage(credentialState.credentials);
      attempts[attempts.length - 1] = { source: "oauth", status: "success" };
      return successProvider({
        provider: "codex",
        label: "Codex",
        source: "oauth",
        plan: quota.plan,
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
        source: "oauth",
        status: "failed",
        error: finalError,
      };
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
    }
  } else {
    attempts.push({
      source: "oauth",
      status: "skipped",
      error: `credentials_${credentialState.status}`,
    });
    if (credentialState.status !== "missing")
      finalError = "Codex sign-in required";
  }

  attempts.push({ source: "cli-rpc", status: "failed" });
  try {
    const quota = await probeCodexCli();
    attempts[attempts.length - 1] = { source: "cli-rpc", status: "success" };
    return successProvider({
      provider: "codex",
      label: "Codex",
      source: "cli-rpc",
      plan: quota.plan,
      account: quota.account,
      windows: quota.windows,
      credits: quota.credits,
      refreshedAt: quota.refreshedAt,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[attempts.length - 1] = {
      source: "cli-rpc",
      status: "failed",
      error: message,
    };
    finalError =
      finalError === "Codex quota unavailable" ? message : finalError;
  }

  const cached = readCachedProvider("codex");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "codex",
    label: "Codex",
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
  const authFile = codexAuthFile();
  const credentialState = readCredentialState(authFile);
  const binary = await resolveCodexBinary();
  return {
    provider: "codex",
    sources: [
      credentialState.source,
      {
        source: "cli-rpc",
        path: binary.path,
        status: binary.status,
        error: binary.status === "missing" ? binary.error : undefined,
      },
    ],
  };
}

export function normalizeCodexUsage(raw: unknown):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  // Both the direct ChatGPT backend calls and the codex app-server RPC
  // describe the same rate-limit concepts, but the RPC surface uses
  // camelCase field names while the HTTP backend uses snake_case; both
  // forms are tolerated wherever they appear below.
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const rateLimit = resolveRateLimitContainer(data);

  const windows = deduplicateWindowIds([
    ...windowPairFromContainer(
      rateLimit,
      "five_hour",
      "session",
      "session",
      "weekly",
      "week",
      "weekly",
    ),
    ...windowPairFromContainer(
      objectValue(data.code_review_rate_limit),
      "code_review_five_hour",
      "code review session",
      "session",
      "code_review_weekly",
      "code review week",
      "weekly",
    ),
    ...collectNamedRateLimitWindows(data),
  ]);

  if (windows.length === 0) return undefined;

  return {
    plan: stringValue(data.plan_type) ?? stringValue(data.planType),
    account: {
      email: stringValue(data.email),
      accountId: stringValue(data.account_id) ?? stringValue(data.accountId),
    },
    windows,
    credits: normalizeCredits(data.credits ?? rateLimit?.credits),
    refreshedAt: nowIso(),
  };
}

function resolveRateLimitContainer(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    objectValue(data.rate_limit) ??
    objectValue(data.rateLimits) ??
    objectValue(data.rate_limits) ??
    data
  );
}

function windowPairFromContainer(
  container: Record<string, unknown> | undefined,
  primaryId: string,
  primaryLabel: string,
  primaryKind: QuotaWindow["kind"],
  secondaryId: string,
  secondaryLabel: string,
  secondaryKind: QuotaWindow["kind"],
): QuotaWindow[] {
  if (!container) return [];
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      primaryId,
      primaryLabel,
      primaryKind,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      secondaryId,
      secondaryLabel,
      secondaryKind,
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

// Beyond the base rate limit, both API shapes can carry extra limits scoped
// to a specific model or feature (e.g. a preview model with its own budget):
// the HTTP backend lists them under `additional_rate_limits`, keyed by
// `metered_feature`/`limit_name`; the app-server RPC exposes an equivalent
// `rateLimitsByLimitId` map keyed by limit id, where only the named entries
// are extras (the unnamed one duplicates the base limit already parsed above).
function collectNamedRateLimitWindows(
  data: Record<string, unknown>,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  const additional = Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits
    : [];
  for (const entry of additional) {
    const item = objectValue(entry);
    if (!item) continue;
    const id =
      stringValue(item.metered_feature) ?? stringValue(item.limit_name);
    const label = stringValue(item.limit_name) ?? id;
    const container = objectValue(item.rate_limit);
    if (!id || !label || !container) continue;
    windows.push(...namedLimitWindows(id, label, container));
  }

  const byLimitId = objectValue(data.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [limitId, value] of Object.entries(byLimitId)) {
      const item = objectValue(value);
      if (!item) continue;
      const label = stringValue(item.limitName) ?? stringValue(item.limit_name);
      if (!label) continue;
      windows.push(...namedLimitWindows(limitId, label, item));
    }
  }

  return windows;
}

function namedLimitWindows(
  id: string,
  label: string,
  container: Record<string, unknown>,
): QuotaWindow[] {
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      `model:${id}:5h`,
      `${label} session`,
      "model",
      { id, label },
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      `model:${id}:7d`,
      `${label} week`,
      "model",
      { id, label },
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

function deduplicateWindowIds(windows: QuotaWindow[]): QuotaWindow[] {
  const counts = new Map<string, number>();
  return windows.map((window) => {
    const count = (counts.get(window.id) ?? 0) + 1;
    counts.set(window.id, count);
    return count === 1 ? window : { ...window, id: `${window.id}_${count}` };
  });
}

export function mergeAccountAndLimits(
  account: unknown,
  limits: unknown,
): Record<string, unknown> {
  const accountData = objectValue(account) ?? {};
  const accountRecord = objectValue(accountData.account) ?? accountData;
  const limitData = objectValue(limits) ?? {};
  return {
    ...limitData,
    email: accountRecord.email ?? limitData.email,
    account_id:
      accountRecord.account_id ??
      accountRecord.accountId ??
      limitData.account_id,
    plan_type:
      accountRecord.plan_type ?? accountRecord.planType ?? limitData.plan_type,
  };
}

function codexAuthFile(): string {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

function readCredentialState(authFile = codexAuthFile()): CredentialState {
  return extractCredentialState(readJsonFileResult(authFile), authFile);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: { source: "auth-json", path, status: "missing" },
    };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: {
        source: "auth-json",
        path,
        status: "invalid",
        error: raw.error,
      },
    };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };
  const tokens = objectValue(data.tokens);
  if (!tokens)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };
  const accessToken =
    stringValue(tokens.access_token) ?? stringValue(tokens.accessToken);
  if (!accessToken)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };

  const idToken = stringValue(tokens.id_token) ?? stringValue(tokens.idToken);
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = decodeJwtPayload(accessToken);
  if (isExpiredJwtPayload(idPayload) || isExpiredJwtPayload(accessPayload)) {
    return {
      status: "expired",
      source: { source: "auth-json", path, status: "expired" },
    };
  }
  const decoded = idPayload ?? accessPayload;
  const accountId =
    stringValue(tokens.account_id) ??
    stringValue(tokens.accountId) ??
    stringValue(decoded?.["https://api.openai.com/auth/account_id"]) ??
    stringValue(decoded?.account_id);
  return {
    status: "available",
    credentials: { accessToken, accountId },
    source: { source: "auth-json", path, status: "available" },
  };
}

async function fetchOauthUsage(credentials: CodexCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  let rejected = false;
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${credentials.accessToken}`,
        accept: "application/json",
      };
      if (credentials.accountId)
        headers["ChatGPT-Account-Id"] = credentials.accountId;
      const response = await fetch(endpoint, {
        headers,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        rejected = true;
        continue;
      }
      if (response.status === 429)
        throw new RateLimitError(
          retryAfterToIso(response.headers.get("retry-after")),
        );
      if (!response.ok) continue;
      const quota = normalizeCodexUsage(await response.json());
      if (quota) return quota;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (rejected) throw new Error("Codex sign-in required");
  if (lastError) throw lastError;
  throw new Error("Codex quota unavailable");
}

async function probeCodexCli(): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  const binary = await resolveCodexBinary();
  if (binary.status === "missing") {
    throw new Error(codexBinaryErrorMessage(binary));
  }
  const child = spawn(
    binary.path,
    ["-s", "read-only", "-a", "untrusted", "app-server"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    },
  );

  let nextId = 1;
  let buffer = "";
  let fatalError: Error | undefined;
  const responses = new Map<number, unknown>();
  const waiters = new Map<
    number,
    {
      timer: NodeJS.Timeout;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  const failAll = (error: Error) => {
    if (fatalError) return;
    fatalError = error;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };

  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.on("error", () => failAll(new Error("Codex quota unavailable")));
  child.on("close", () => failAll(new Error("Codex quota unavailable")));

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as {
          id?: unknown;
          result?: unknown;
          params?: unknown;
          error?: unknown;
        };
        if (typeof message.id !== "number") continue;
        const value = message.error ?? message.result ?? message.params;
        const waiter = waiters.get(message.id);
        if (waiter) {
          waiters.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        } else {
          responses.set(message.id, value);
        }
      } catch {
        // Ignore non-JSON startup output.
      }
    }
  });

  const waitFor = (id: number, timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      if (responses.has(id)) {
        resolve(responses.get(id));
        return;
      }
      if (fatalError) {
        reject(fatalError);
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error("Codex quota unavailable"));
      }, timeoutMs);
      waiters.set(id, { timer, resolve, reject });
    });

  try {
    const initId = nextId++;
    sendRpc(child, initId, "initialize", {
      clientInfo: { name: "quota-axi", version: "1" },
    });
    await waitFor(initId, CLI_TIMEOUT_MS);

    const accountId = nextId++;
    sendRpc(child, accountId, "account/read");
    const account = await waitFor(accountId, RPC_TIMEOUT_MS).catch(
      () => undefined,
    );

    const limitsId = nextId++;
    sendRpc(child, limitsId, "account/rateLimits/read");
    const limits = await waitFor(limitsId, RPC_TIMEOUT_MS);
    const quota = normalizeCodexUsage(mergeAccountAndLimits(account, limits));
    if (!quota) throw new Error("Codex quota unavailable");
    return quota;
  } finally {
    terminateChild(child);
  }
}

async function resolveCodexBinary(): Promise<CodexBinaryState> {
  const configured = process.env[CODEX_BINARY_ENV];
  if (configured !== undefined) {
    const path = configured.trim();
    if (!path || !isAbsolute(path)) {
      return {
        status: "missing",
        error: "codex_binary_override_not_absolute",
      };
    }
    const executable = await findCommandPath(path);
    if (!executable) {
      return {
        status: "missing",
        path,
        error: "codex_binary_override_not_executable",
      };
    }
    return { status: "available", path: executable };
  }

  const executable = await findCommandPath("codex");
  return executable
    ? { status: "available", path: executable }
    : { status: "missing" };
}

function codexBinaryErrorMessage(
  binary: Extract<CodexBinaryState, { status: "missing" }>,
): string {
  if (binary.error === "codex_binary_override_not_absolute") {
    return "Configured Codex binary must be an absolute executable path";
  }
  if (binary.error === "codex_binary_override_not_executable") {
    return "Configured Codex binary is not executable";
  }
  return "Codex quota unavailable";
}

function sendRpc(
  child: { stdin: { writable: boolean; write: (chunk: string) => unknown } },
  id: number,
  method: string,
  params: unknown = {},
) {
  if (!child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
}

function normalizeWindow(
  raw: unknown,
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  namedLimit?: { id: string; label: string },
): QuotaWindow | undefined {
  const data = objectValue(raw) as RawWindow | undefined;
  if (!data) return undefined;
  const used = numberValue(data.used_percent) ?? numberValue(data.usedPercent);
  if (used === undefined) return undefined;
  const windowSeconds =
    numberValue(data.limit_window_seconds) ??
    (numberValue(data.windowDurationMins) === undefined
      ? undefined
      : numberValue(data.windowDurationMins)! * 60);
  const resetFromSeconds =
    numberValue(data.reset_after_seconds) === undefined
      ? undefined
      : new Date(
          Date.now() + numberValue(data.reset_after_seconds)! * 1000,
        ).toISOString();
  const identity = windowIdentity(windowSeconds, id, label, kind, namedLimit);
  return withRemaining({
    ...identity,
    percentUsed: clampPercent(used),
    resetsAt:
      parseEpochOrIso(data.reset_at) ??
      parseEpochOrIso(data.resetsAt) ??
      resetFromSeconds,
    windowSeconds,
  });
}

function windowIdentity(
  windowSeconds: number | undefined,
  fallbackId: string,
  fallbackLabel: string,
  fallbackKind: QuotaWindow["kind"],
  namedLimit?: { id: string; label: string },
): Pick<QuotaWindow, "id" | "label" | "kind"> {
  if (windowSeconds === undefined) {
    return { id: fallbackId, label: fallbackLabel, kind: fallbackKind };
  }

  if (windowSeconds <= 21_600) {
    return namedLimit
      ? {
          id: `model:${namedLimit.id}:5h`,
          label: `${namedLimit.label} session`,
          kind: "model",
        }
      : { id: "five_hour", label: "session", kind: "session" };
  }

  if (windowSeconds >= 518_400) {
    return namedLimit
      ? {
          id: `model:${namedLimit.id}:7d`,
          label: `${namedLimit.label} week`,
          kind: "model",
        }
      : { id: "seven_day", label: "week", kind: "weekly" };
  }

  const duration = readableWindowDuration(windowSeconds);
  return namedLimit
    ? {
        id: `model:${namedLimit.id}:window:${duration}`,
        label: `${namedLimit.label} ${duration} window`,
        kind: "model",
      }
    : {
        id: `window:${duration}`,
        label: `${duration} window`,
        kind: fallbackKind,
      };
}

function readableWindowDuration(windowSeconds: number): string {
  const hours = windowSeconds / 3600;
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`;
}

function normalizeCredits(raw: unknown): ProviderQuota["credits"] | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const balance = numberValue(data.balance);
  const unlimited =
    typeof data.unlimited === "boolean" ? data.unlimited : undefined;
  if (balance === undefined && unlimited === undefined) return undefined;
  return {
    remaining: balance,
    unlimited,
    unit: "credits",
  };
}

function decodeJwtPayload(
  token: string | undefined,
): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function isExpiredJwtPayload(
  payload: Record<string, unknown> | undefined,
): boolean {
  const exp = numberValue(payload?.exp);
  return exp !== undefined && exp <= Math.floor(Date.now() / 1000);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Codex quota request timed out";
  return error instanceof Error ? error.message : "Codex quota unavailable";
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Codex quota endpoint rate limited");
  }
}
