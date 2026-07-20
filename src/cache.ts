import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { cacheFilePath, ensurePrivateParent, readJsonFile } from "./lib/fs.js";
import type {
  ProviderId,
  ProviderQuota,
  ProviderSource,
  ProviderStatus,
  QuotaWindow,
} from "./types.js";
import { PROVIDER_IDS } from "./types.js";

const PROVIDER_SOURCES = [
  "oauth",
  "cli-rpc",
  "api",
  "web",
  "cache",
  "unavailable",
] as const satisfies readonly ProviderSource[];
const PROVIDER_STATUSES = [
  "fresh",
  "stale",
  "unavailable",
  "auth_required",
  "rate_limited",
  "error",
] as const satisfies readonly ProviderStatus[];
const WINDOW_KINDS = [
  "session",
  "weekly",
  "monthly",
  "model",
  "credits",
  "unknown",
] as const satisfies readonly QuotaWindow["kind"][];

export function readCachedProvider(
  provider: ProviderId,
): ProviderQuota | undefined {
  return readCacheProviders().find((item) => item.provider === provider);
}

export function writeCachedProviders(providers: ProviderQuota[]): void {
  const clearProviders = new Set(
    providers
      .filter(
        (provider) =>
          provider.state.status === "fresh" && provider.windows.length === 0,
      )
      .map((provider) => provider.provider),
  );
  const cacheable = providers
    .map(toCacheProvider)
    .filter((provider): provider is ProviderQuota => Boolean(provider));

  const file = cacheFilePath();
  const byProvider = new Map<ProviderId, ProviderQuota>();
  let clearedExisting = false;
  for (const provider of readCacheProviders()) {
    if (clearProviders.has(provider.provider)) {
      clearedExisting = true;
      continue;
    }
    byProvider.set(provider.provider, provider);
  }
  if (cacheable.length === 0 && !clearedExisting) return;
  for (const provider of cacheable) byProvider.set(provider.provider, provider);
  const merged = PROVIDER_IDS.map((provider) =>
    byProvider.get(provider),
  ).filter((provider): provider is ProviderQuota => Boolean(provider));

  writeCacheFile(file, merged);
}

export function deleteCachedProvider(provider: ProviderId): void {
  const existing = readCacheProviders();
  if (!existing.some((item) => item.provider === provider)) return;
  writeCacheFile(
    cacheFilePath(),
    existing.filter((item) => item.provider !== provider),
  );
}

function writeCacheFile(file: string, providers: ProviderQuota[]): void {
  ensurePrivateParent(file);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), schemaVersion: 1, providers }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function readCacheProviders(): ProviderQuota[] {
  const raw = readJsonFile(cacheFilePath());
  const payload = objectValue(raw);
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    !Array.isArray(payload.providers)
  )
    return [];
  return payload.providers
    .map(normalizeCachedProvider)
    .filter((provider): provider is ProviderQuota => Boolean(provider));
}

function toCacheProvider(provider: ProviderQuota): ProviderQuota | undefined {
  if (provider.state.status !== "fresh" || provider.windows.length === 0)
    return undefined;
  return normalizeCachedProvider({
    provider: provider.provider,
    label: provider.label,
    source: provider.source,
    plan: provider.plan,
    windows: provider.windows,
    credits: provider.credits,
    state: {
      status: provider.state.status,
      stale: false,
      refreshedAt: provider.state.refreshedAt,
      sourcesTried: provider.state.sourcesTried,
    },
  });
}

function normalizeCachedProvider(raw: unknown): ProviderQuota | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const provider = literalValue(data.provider, PROVIDER_IDS);
  const label = stringValue(data.label);
  const source = literalValue(data.source, PROVIDER_SOURCES);
  const state = objectValue(data.state);
  const status = literalValue(state?.status, PROVIDER_STATUSES);
  const sourcesTried = stringArrayValue(state?.sourcesTried);
  const windows = Array.isArray(data.windows)
    ? data.windows
        .map(normalizeCachedWindow)
        .filter((window): window is QuotaWindow => Boolean(window))
    : [];
  if (
    !provider ||
    !label ||
    !source ||
    !state ||
    !status ||
    !sourcesTried ||
    windows.length === 0
  )
    return undefined;

  const result: ProviderQuota = {
    provider,
    label,
    source,
    windows,
    state: {
      status,
      stale: booleanValue(state.stale) ?? false,
      sourcesTried,
    },
  };
  const plan = stringValue(data.plan);
  const refreshedAt = stringValue(state.refreshedAt);
  const credits = normalizeCachedCredits(data.credits);
  if (plan) result.plan = plan;
  if (refreshedAt) result.state.refreshedAt = refreshedAt;
  if (credits) result.credits = credits;
  return result;
}

function normalizeCachedWindow(raw: unknown): QuotaWindow | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const id = stringValue(data.id);
  const label = stringValue(data.label);
  const kind = literalValue(data.kind, WINDOW_KINDS);
  if (!id || !label || !kind) return undefined;
  const result: QuotaWindow = { id, label, kind };
  assignNumber(result, "percentUsed", data.percentUsed);
  assignNumber(result, "percentRemaining", data.percentRemaining);
  assignString(result, "resetsAt", data.resetsAt);
  assignString(result, "resetText", data.resetText);
  assignNumber(result, "windowSeconds", data.windowSeconds);
  assignNumber(result, "spentUsd", data.spentUsd);
  assignNumber(result, "limitUsd", data.limitUsd);
  return result;
}

function normalizeCachedCredits(
  raw: unknown,
): ProviderQuota["credits"] | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const remaining = numberValue(data.remaining);
  const unlimited = booleanValue(data.unlimited);
  const unit = literalValue(data.unit, ["usd", "credits"] as const);
  if (remaining === undefined && unlimited === undefined && unit === undefined)
    return undefined;
  return {
    remaining,
    unlimited,
    unit,
  };
}

function assignNumber<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  const number = numberValue(value);
  if (number !== undefined) target[key] = number as T[K];
}

function assignString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  const string = stringValue(value);
  if (string !== undefined) target[key] = string as T[K];
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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function literalValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined {
  return typeof value === "string" && values.includes(value)
    ? value
    : undefined;
}
