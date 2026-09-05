import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
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

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_PI_SOURCE = "pi:openrouter";
export const OPENROUTER_ENV_SOURCE = "env:OPENROUTER_API_KEY";

const LABEL = "OpenRouter";
const DEADLINE_MS = 15_000;

type CredentialResolution =
  | { status: "available"; key: string; source: string; path?: string }
  | { status: "missing" | "invalid" | "error"; source: string; path?: string };

type Dependencies = {
  credential: () => CredentialResolution;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedOpenRouterPayload = {
  label?: string;
  limit?: number;
  remaining?: number;
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  period?: string;
  isFreeTier: boolean;
  hasCap: boolean;
};

export function openrouterAuthFilePath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const home = process.env.HOME?.trim() || homedir();
  const directory =
    configured === undefined || configured === ""
      ? join(home, ".pi", "agent")
      : configured === "~"
        ? home
        : configured.startsWith("~/")
          ? join(home, configured.slice(2))
          : configured;
  return join(directory, "auth.json");
}

export function extractOpenRouterCredential(
  value: unknown,
  path: string,
): CredentialResolution {
  const root = objectValue(value);
  if (!root) return { status: "invalid", source: OPENROUTER_PI_SOURCE, path };
  for (const name of ["openrouter"]) {
    const entry = objectValue(root[name]);
    if (!entry) continue;
    const key = [
      entry.key,
      entry.apiKey,
      entry.api_key,
      entry.access,
      entry.token,
    ]
      .map(usableLiteralSecret)
      .find((candidate): candidate is string => candidate !== undefined);
    if (key)
      return { status: "available", key, source: OPENROUTER_PI_SOURCE, path };
  }
  return { status: "missing", source: OPENROUTER_PI_SOURCE, path };
}

export function resolveOpenRouterCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path = openrouterAuthFilePath(),
): CredentialResolution {
  const envKey = usableLiteralSecret(environment.OPENROUTER_API_KEY);
  if (envKey)
    return { status: "available", key: envKey, source: OPENROUTER_ENV_SOURCE };
  const result: JsonFileReadResult = readJsonFileResult(path);
  if (result.status === "missing")
    return { status: "missing", source: OPENROUTER_PI_SOURCE, path };
  if (result.status === "invalid") {
    return {
      status: result.error === "file_read_error" ? "error" : "invalid",
      source: OPENROUTER_PI_SOURCE,
      path,
    };
  }
  return extractOpenRouterCredential(result.value, path);
}

export function createOpenRouterAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveOpenRouterCredential(),
    fetch: globalThis.fetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "openrouter",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const openrouterAdapter = createOpenRouterAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const resolution = dependencies.credential();
  const attempts: SourceAttempt[] = [
    {
      source: resolution.source,
      status: resolution.status === "available" ? "success" : "skipped",
      ...(resolution.status !== "available"
        ? { error: credentialError(resolution) }
        : {}),
    },
  ];
  if (resolution.status !== "available") {
    return failedProvider({
      provider: "openrouter",
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
    const normalized = normalizeOpenRouterPayload(payload);
    attempts[0] = { source: resolution.source, status: "success" };

    const windows: QuotaWindow[] = [];
    if (
      normalized.hasCap &&
      normalized.limit !== undefined &&
      normalized.remaining !== undefined
    ) {
      const used = Math.max(0, normalized.limit - normalized.remaining);
      const percentUsed =
        normalized.limit > 0 ? (used / normalized.limit) * 100 : 0;
      windows.push({
        id: "key-limit",
        label: "Key spend cap",
        kind: "credits",
        spentUsd: used,
        limitUsd: normalized.limit,
        percentRemaining: clampPercent(100 - percentUsed),
        ...(normalized.period ? { resetText: normalized.period } : {}),
      });
    }

    return successProvider({
      provider: "openrouter",
      label: LABEL,
      source: "api",
      account: normalized.label ? { accountId: normalized.label } : undefined,
      windows,
      credits: {
        remaining: normalized.remaining ?? Number.POSITIVE_INFINITY,
        unit: "usd",
      },
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const code = errorCode(error);
    attempts[0] = { source: resolution.source, status: "failed", error: code };
    return failedProvider({
      provider: "openrouter",
      label: LABEL,
      status: statusFromError(code),
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
    source: resolution.source,
    path: resolution.path,
    status:
      resolution.status === "available"
        ? "available"
        : resolution.status === "missing"
          ? "missing"
          : resolution.status === "error"
            ? "error"
            : "invalid",
    ...(resolution.status === "error" || resolution.status === "invalid"
      ? { error: "credential_resolution_failed" }
      : {}),
  };
  return { provider: "openrouter", sources: [source] };
}

async function requestUsage(
  key: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetchImplementation(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + key,
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error("provider_auth_rejected");
    if (response.status === 429) throw new Error("provider_rate_limited");
    if (!response.ok) throw new Error("provider_error:" + response.status);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("invalid_json");
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeOpenRouterPayload(
  raw: unknown,
): NormalizedOpenRouterPayload {
  const root = objectValue(raw);
  if (!root) throw new Error("invalid_payload");
  const data = objectValue(root.data);
  if (!data) throw new Error("missing_data");

  const limit = asNonnegativeNumber(data.limit);
  const remaining = asNonnegativeNumber(data.limit_remaining);
  const usage = asNonnegativeNumber(data.usage) ?? 0;
  const usageDaily = asNonnegativeNumber(data.usage_daily) ?? 0;
  const usageWeekly = asNonnegativeNumber(data.usage_weekly) ?? 0;
  const usageMonthly = asNonnegativeNumber(data.usage_monthly) ?? 0;
  const period = asString(data.limit_reset);
  const label = asString(data.label);
  const isFreeTier = data.is_free_tier === true;
  const hasCap = data.limit !== null && limit !== undefined;

  return {
    label,
    limit,
    remaining,
    usage,
    usageDaily,
    usageWeekly,
    usageMonthly,
    period,
    isFreeTier,
    hasCap,
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  return value;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function statusFromError(error: string): ProviderStatus {
  if (error === "provider_auth_rejected") return "auth_required";
  if (error === "provider_rate_limited") return "rate_limited";
  return "error";
}

function credentialError(resolution: CredentialResolution): string {
  if (resolution.status === "missing")
    return "openrouter_credential_unavailable";
  if (resolution.status === "invalid") return "openrouter_credential_invalid";
  return "openrouter_credential_resolution_failed";
}

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
