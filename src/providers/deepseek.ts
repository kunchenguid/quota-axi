import { providerFetch } from "../lib/http.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import {
  credentialCandidates,
  type EnvPiCredentialResolution,
  type EnvPiCredentialSources,
  errorCode,
  extractPiKeyCredential,
  inspectEnvPiAuth,
  KeyEndpointError,
  type KeyCredentialFailure,
  keyCredentialFailure,
  preferCredentialFailure,
  preferRemoteAuthFailure,
  requestKeyEndpoint,
  resolveEnvPiCredentials,
  statusFromRequestError,
} from "./env-pi-credential.js";

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEEPSEEK_PI_SOURCE = "pi:deepseek";
export const DEEPSEEK_ENV_SOURCE = "env:DEEPSEEK_API_KEY";

const LABEL = "DeepSeek";
const DEADLINE_MS = 15_000;

const DEEPSEEK_SOURCES: EnvPiCredentialSources = {
  envVar: "DEEPSEEK_API_KEY",
  envSource: DEEPSEEK_ENV_SOURCE,
  piProviderId: "deepseek",
  piSource: DEEPSEEK_PI_SOURCE,
};

const CURRENCIES = ["USD", "CNY"] as const;
type DeepSeekCurrency = (typeof CURRENCIES)[number];

type Dependencies = {
  credential: () => EnvPiCredentialResolution | EnvPiCredentialResolution[];
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedDeepSeekPayload = {
  metrics: {
    id: "usd-total" | "cny-total";
    value: string;
    currency: DeepSeekCurrency;
  }[];
};

export function resolveDeepSeekCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path?: string,
): EnvPiCredentialResolution[] {
  return resolveEnvPiCredentials(DEEPSEEK_SOURCES, environment, path);
}

export function extractDeepSeekCredential(
  value: unknown,
  path: string,
): EnvPiCredentialResolution {
  return extractPiKeyCredential(value, "deepseek", DEEPSEEK_PI_SOURCE, path);
}

export function createDeepSeekAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveDeepSeekCredentials(),
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
  const attempts: SourceAttempt[] = [];
  let finalFailure: KeyCredentialFailure | undefined;
  for (const resolution of credentialCandidates(dependencies.credential)) {
    if (resolution.status !== "available") {
      const failure = keyCredentialFailure("deepseek", resolution);
      attempts.push({
        source: resolution.source,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.error,
      });
      finalFailure = preferCredentialFailure(finalFailure, failure);
      continue;
    }

    try {
      const payload = await requestKeyEndpoint(
        DEEPSEEK_BALANCE_URL,
        resolution.key,
        dependencies.fetch,
        dependencies.deadlineMs,
      );
      const normalized = normalizeDeepSeekPayload(payload);
      attempts.push({ source: resolution.source, status: "success" });

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
      attempts.push({
        source: resolution.source,
        status: "failed",
        error: code,
      });
      if (code === "provider_auth_rejected") {
        finalFailure = preferRemoteAuthFailure(finalFailure, code);
        continue;
      }
      return failedProvider({
        provider: "deepseek",
        label: LABEL,
        status: statusFromRequestError(code),
        error: code,
        source: "unavailable",
        retryAfter:
          error instanceof KeyEndpointError ? error.retryAfter : undefined,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }
  }

  const failure = finalFailure ?? {
    status: "auth_required" as const,
    error: "deepseek_credential_unavailable",
  };
  return failedProvider({
    provider: "deepseek",
    label: LABEL,
    status: failure.status,
    error: failure.error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  return inspectEnvPiAuth(
    "deepseek",
    credentialCandidates(dependencies.credential),
  );
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

  return { metrics };
}

type DeepSeekWallet = { remaining: number; unit: "usd" | "cny" };

/**
 * A wallet is denominated in the currency the vendor reported, so its unit is
 * that currency rather than a generic `credits` label that would misstate a
 * CNY amount.
 */
function walletUnit(currency: DeepSeekCurrency): DeepSeekWallet["unit"] {
  return currency === "USD" ? "usd" : "cny";
}

/**
 * DeepSeek reports one wallet per currency and can report several at once, so
 * one scalar cannot carry the account. Every representable wallet is published
 * in `balances`; the scalar `remaining`/`unit` mirror the funded wallet so a
 * zero or unfunded wallet can never mask a funded one and single-value
 * consumers keep working. A lone wallet stays scalar-only.
 */
function computeCredits(
  metrics: NormalizedDeepSeekPayload["metrics"],
): ProviderQuota["credits"] | undefined {
  const balances: DeepSeekWallet[] = [];
  for (const metric of metrics) {
    const value = Number(metric.value);
    if (!Number.isFinite(value)) continue;
    balances.push({ remaining: value, unit: walletUnit(metric.currency) });
  }
  if (balances.length === 0) return undefined;
  const funded =
    balances.find((balance) => balance.remaining > 0) ??
    balances.find((balance) => balance.remaining !== 0) ??
    balances[0];
  return {
    remaining: funded.remaining,
    unit: funded.unit,
    ...(balances.length > 1 ? { balances } : {}),
  };
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
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
  );
}
