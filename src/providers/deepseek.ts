import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { piAuthFilePath } from "./pi-auth.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  ProviderStatus,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEEPSEEK_PI_SOURCE = "pi:deepseek";
export const DEEPSEEK_ENV_SOURCE = "env:DEEPSEEK_API_KEY";

const LABEL = "DeepSeek";
const DEADLINE_MS = 15_000;

const CURRENCIES = ["USD", "CNY"] as const;
type DeepSeekCurrency = (typeof CURRENCIES)[number];

type CredentialResolution =
  | { status: "available"; key: string; source: string; path?: string }
  | { status: "missing" | "invalid" | "error"; source: string; path?: string };

type Dependencies = {
  credential: () => CredentialResolution;
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedDeepSeekPayload = {
  available: boolean;
  metrics: {
    id: "usd-total" | "cny-total";
    value: string;
    currency: DeepSeekCurrency;
  }[];
};

export function resolveDeepSeekCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path = piAuthFilePath(),
): CredentialResolution {
  const envKey = usableLiteralSecret(environment.DEEPSEEK_API_KEY);
  if (envKey)
    return { status: "available", key: envKey, source: DEEPSEEK_ENV_SOURCE };
  const result: JsonFileReadResult = readJsonFileResult(path);
  if (result.status === "missing")
    return { status: "missing", source: DEEPSEEK_PI_SOURCE, path };
  if (result.status === "invalid") {
    return {
      status: result.error === "file_read_error" ? "error" : "invalid",
      source: DEEPSEEK_PI_SOURCE,
      path,
    };
  }
  return extractDeepSeekCredential(result.value, path);
}

export function extractDeepSeekCredential(
  value: unknown,
  path: string,
): CredentialResolution {
  const root = objectValue(value);
  if (!root) return { status: "invalid", source: DEEPSEEK_PI_SOURCE, path };
  const entry = objectValue(root.deepseek);
  if (!entry) return { status: "missing", source: DEEPSEEK_PI_SOURCE, path };
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
    return { status: "available", key, source: DEEPSEEK_PI_SOURCE, path };
  return { status: "invalid", source: DEEPSEEK_PI_SOURCE, path };
}

export function createDeepSeekAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveDeepSeekCredential(),
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "deepseek",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const deepseekAdapter = createDeepSeekAdapter();

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
      provider: "deepseek",
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
    const normalized = normalizeDeepSeekPayload(payload);
    attempts[0] = { source: resolution.source, status: "success" };

    return successProvider({
      provider: "deepseek",
      label: LABEL,
      source: "api",
      windows: [],
      credits: computeCredits(normalized.metrics),
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const code = errorCode(error);
    attempts[0] = { source: resolution.source, status: "failed", error: code };
    return failedProvider({
      provider: "deepseek",
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
  return { provider: "deepseek", sources: [source] };
}

async function requestUsage(
  key: string,
  fetchImplementation: typeof providerFetch,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetchImplementation(DEEPSEEK_BALANCE_URL, {
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

export function normalizeDeepSeekPayload(
  raw: unknown,
): NormalizedDeepSeekPayload {
  const root = objectValue(raw);
  if (!root) throw new Error("invalid_payload");
  if (typeof root.is_available !== "boolean") {
    throw new Error("missing_availability");
  }
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos : [];
  const balances = new Map<DeepSeekCurrency, Record<string, unknown>>();
  for (const rawInfo of infos) {
    const info = objectValue(rawInfo);
    if (!info) throw new Error("invalid_balance_row");
    const currency = deepSeekCurrency(info.currency);
    if (!currency) throw new Error("unsupported_currency");
    if (balances.has(currency)) throw new Error("duplicate_currency");
    if (!decimalAmount(info.total_balance)) {
      throw new Error("invalid_amount:Total balance");
    }
    balances.set(currency, info);
  }

  const metrics: NormalizedDeepSeekPayload["metrics"] = [];
  for (const currency of CURRENCIES) {
    const balance = balances.get(currency);
    if (!balance) continue;
    metrics.push({
      id: (currency.toLowerCase() +
        "-total") as NormalizedDeepSeekPayload["metrics"][number]["id"],
      value: String(balance.total_balance),
      currency,
    });
  }

  return { available: root.is_available, metrics };
}

function computeCredits(
  metrics: NormalizedDeepSeekPayload["metrics"],
): ProviderQuota["credits"] | undefined {
  const usdTotal = metrics.find(
    (m) => m.currency === "USD" && m.id === "usd-total",
  );
  if (usdTotal) {
    const value = Number(usdTotal.value);
    if (Number.isFinite(value) && value >= 0) {
      return { remaining: value, unit: "usd" };
    }
  }
  const cnyTotal = metrics.find(
    (m) => m.currency === "CNY" && m.id === "cny-total",
  );
  if (cnyTotal) {
    const value = Number(cnyTotal.value);
    if (Number.isFinite(value) && value >= 0) {
      return { remaining: value, unit: "credits" };
    }
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function deepSeekCurrency(value: unknown): DeepSeekCurrency | undefined {
  return CURRENCIES.find((currency) => currency === value);
}

function decimalAmount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    value.length > 0 &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
  );
}

function credentialError(resolution: CredentialResolution): string {
  if (resolution.status === "missing") return "deepseek_credential_unavailable";
  if (resolution.status === "invalid") return "deepseek_credential_invalid";
  return "deepseek_credential_resolution_failed";
}

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function statusFromError(error: string): ProviderStatus {
  if (error === "provider_auth_rejected") return "auth_required";
  if (error === "provider_rate_limited") return "rate_limited";
  return "error";
}
