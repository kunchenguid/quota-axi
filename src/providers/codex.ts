import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readCachedProvider } from "../cache.js";
import { readJsonFile } from "../lib/fs.js";
import { commandExists, terminateChild } from "../lib/process.js";
import { clampPercent, nowIso, parseEpochOrIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, staleFromCache, statusFromError, successProvider, withRemaining } from "./common.js";

const ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
];
const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 8_000;

type CodexCredentials = {
  accessToken: string;
  accountId?: string;
};

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

export async function fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError = "Codex quota unavailable";

  const credentials = readCredentials();
  if (credentials) {
    attempts.push({ source: "oauth", status: "failed" });
    try {
      const quota = await fetchOauthUsage(credentials);
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
      attempts[attempts.length - 1] = { source: "oauth", status: "failed", error: finalError };
    }
  } else {
    attempts.push({ source: "oauth", status: "skipped", error: "credentials_missing" });
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
    attempts[attempts.length - 1] = { source: "cli-rpc", status: "failed", error: message };
    finalError = finalError === "Codex quota unavailable" ? message : finalError;
  }

  const cached = readCachedProvider("codex");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "codex",
    label: "Codex",
    status: statusFromError(finalError),
    error: finalError,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
  const authFile = codexAuthFile();
  const raw = readJsonFile(authFile);
  const credentials = extractCredentials(raw);
  return {
    provider: "codex",
    sources: [
      {
        source: "auth-json",
        path: authFile,
        status: credentials ? "available" : raw === undefined ? "missing" : "invalid",
      },
      {
        source: "cli-rpc",
        status: (await commandExists("codex")) ? "available" : "missing",
      },
    ],
  };
}

export function normalizeCodexUsage(
  raw: unknown,
): { plan?: string; account?: ProviderQuota["account"]; windows: QuotaWindow[]; credits?: ProviderQuota["credits"]; refreshedAt: string } | undefined {
  // The response-shape tolerance for snake and camel fields follows the public
  // CodexBar adapter behavior by Peter Steinberger, translated under MIT.
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const rateLimit =
    objectValue(data.rate_limit) ??
    objectValue(data.rateLimits) ??
    objectValue(data.rate_limits) ??
    data;

  const windows = [
    normalizeWindow(rateLimit.primary_window ?? rateLimit.primary ?? data.primary_window, "five_hour", "session", "session"),
    normalizeWindow(rateLimit.secondary_window ?? rateLimit.secondary ?? data.secondary_window, "weekly", "week", "weekly"),
  ].filter((window): window is QuotaWindow => Boolean(window));

  if (windows.length === 0) return undefined;

  return {
    plan: stringValue(data.plan_type) ?? stringValue(data.planType),
    account: {
      email: stringValue(data.email),
      accountId: stringValue(data.account_id) ?? stringValue(data.accountId),
    },
    windows,
    credits: normalizeCredits(data.credits),
    refreshedAt: nowIso(),
  };
}

export function mergeAccountAndLimits(account: unknown, limits: unknown): Record<string, unknown> {
  const accountData = objectValue(account) ?? {};
  const accountRecord = objectValue(accountData.account) ?? accountData;
  const limitData = objectValue(limits) ?? {};
  return {
    ...limitData,
    email: accountRecord.email ?? limitData.email,
    account_id: accountRecord.account_id ?? accountRecord.accountId ?? limitData.account_id,
    plan_type: accountRecord.plan_type ?? accountRecord.planType ?? limitData.plan_type,
  };
}

function codexAuthFile(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "auth.json") : join(homedir(), ".codex", "auth.json");
}

function readCredentials(): CodexCredentials | undefined {
  return extractCredentials(readJsonFile(codexAuthFile()));
}

function extractCredentials(raw: unknown): CodexCredentials | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const apiKey = stringValue(data.OPENAI_API_KEY);
  if (apiKey) return { accessToken: apiKey };

  const tokens = objectValue(data.tokens);
  if (!tokens) return undefined;
  const accessToken = stringValue(tokens.access_token) ?? stringValue(tokens.accessToken);
  if (!accessToken) return undefined;

  const idToken = stringValue(tokens.id_token) ?? stringValue(tokens.idToken);
  const decoded = decodeJwtPayload(idToken) ?? decodeJwtPayload(accessToken);
  const accountId =
    stringValue(tokens.account_id) ??
    stringValue(tokens.accountId) ??
    stringValue(decoded?.["https://api.openai.com/auth/account_id"]) ??
    stringValue(decoded?.account_id);
  return { accessToken, accountId };
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
      if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
      const response = await fetch(endpoint, { headers, signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        rejected = true;
        continue;
      }
      if (!response.ok) continue;
      const quota = normalizeCodexUsage(await response.json());
      if (quota) return quota;
    } catch (error) {
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
  if (!(await commandExists("codex"))) throw new Error("Codex quota unavailable");
  const child = spawn("codex", ["-s", "read-only", "-a", "untrusted", "app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
  });

  let nextId = 1;
  let buffer = "";
  let fatalError: Error | undefined;
  const responses = new Map<number, unknown>();
  const waiters = new Map<number, { timer: NodeJS.Timeout; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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
        const message = JSON.parse(line) as { id?: unknown; result?: unknown; params?: unknown; error?: unknown };
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
    sendRpc(child, initId, "initialize", { clientInfo: { name: "quota-axi", version: "1" } });
    await waitFor(initId, CLI_TIMEOUT_MS);

    const accountId = nextId++;
    sendRpc(child, accountId, "account/read");
    const account = await waitFor(accountId, RPC_TIMEOUT_MS).catch(() => undefined);

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

function sendRpc(
  child: { stdin: { writable: boolean; write: (chunk: string) => unknown } },
  id: number,
  method: string,
  params: unknown = {},
) {
  if (!child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
}

function normalizeWindow(raw: unknown, id: string, label: string, kind: QuotaWindow["kind"]): QuotaWindow | undefined {
  const data = objectValue(raw) as RawWindow | undefined;
  if (!data) return undefined;
  const used = numberValue(data.used_percent) ?? numberValue(data.usedPercent);
  if (used === undefined) return undefined;
  const windowSeconds =
    numberValue(data.limit_window_seconds) ??
    (numberValue(data.windowDurationMins) === undefined ? undefined : numberValue(data.windowDurationMins)! * 60);
  const resetFromSeconds =
    numberValue(data.reset_after_seconds) === undefined
      ? undefined
      : new Date(Date.now() + numberValue(data.reset_after_seconds)! * 1000).toISOString();
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: clampPercent(used),
    resetsAt: parseEpochOrIso(data.reset_at) ?? parseEpochOrIso(data.resetsAt) ?? resetFromSeconds,
    windowSeconds,
  });
}

function normalizeCredits(raw: unknown): ProviderQuota["credits"] | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const balance = numberValue(data.balance);
  const unlimited = typeof data.unlimited === "boolean" ? data.unlimited : undefined;
  if (balance === undefined && unlimited === undefined) return undefined;
  return {
    remaining: balance,
    unlimited,
    unit: "credits",
  };
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
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
  if (error instanceof Error && error.name === "AbortError") return "Codex quota request timed out";
  return error instanceof Error ? error.message : "Codex quota unavailable";
}
