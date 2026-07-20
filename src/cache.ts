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

const PROVIDER_CACHE_KEY = Symbol("quota-axi-provider-cache-key");
type CacheTaggedProvider = ProviderQuota & {
  [PROVIDER_CACHE_KEY]?: string;
};

export function tagProviderCacheKey<T extends ProviderQuota>(
  provider: T,
  cacheKey: string | undefined,
): T {
  if (cacheKey) {
    Object.defineProperty(provider, PROVIDER_CACHE_KEY, {
      configurable: false,
      enumerable: true,
      value: cacheKey,
    });
  }
  return provider;
}

export function readCachedProvider(
  provider: ProviderId,
  cacheKey?: string,
): ProviderQuota | undefined {
  return readCacheProviders().find(
    (item) => item.provider === provider && providerCacheKey(item) === cacheKey,
  );
}

export function writeCachedProviders(providers: ProviderQuota[]): void {
  const clearProviders = new Set(
    providers
      .filter(
        (provider) =>
          provider.state.status === "fresh" && provider.windows.length === 0,
      )
      .map(providerCacheIdentity),
  );
  const cacheable = providers
    .map(toCacheProvider)
    .filter((provider): provider is ProviderQuota => Boolean(provider));

  const file = cacheFilePath();
  const byProvider = new Map<string, ProviderQuota>();
  let clearedExisting = false;
  for (const provider of readCacheProviders()) {
    const identity = providerCacheIdentity(provider);
    if (clearProviders.has(identity)) {
      clearedExisting = true;
      continue;
    }
    byProvider.set(identity, provider);
  }
  if (cacheable.length === 0 && !clearedExisting) return;
  for (const provider of cacheable)
    byProvider.set(providerCacheIdentity(provider), provider);
  const merged = [...byProvider.values()].sort(compareCachedProviders);

  ensurePrivateParent(file);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        schemaVersion: 2,
        providers: merged.map(serializeCachedProvider),
      },
      null,
      2,
    )}\n`,
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
    (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) ||
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
  const normalized = normalizeCachedProvider({
    provider: provider.provider,
    // Multi-seat display metadata is added at the command boundary and must
    // not change the canonical cached provider label.
    label: provider.provider === "claude" ? "Claude" : provider.label,
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
  return normalized
    ? tagProviderCacheKey(normalized, providerCacheKey(provider))
    : undefined;
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
  return tagProviderCacheKey(result, stringValue(data.cacheKey));
}

function providerCacheKey(provider: ProviderQuota): string | undefined {
  return (provider as CacheTaggedProvider)[PROVIDER_CACHE_KEY];
}

function providerCacheIdentity(provider: ProviderQuota): string {
  return `${provider.provider}\u0000${providerCacheKey(provider) ?? ""}`;
}

function compareCachedProviders(
  left: ProviderQuota,
  right: ProviderQuota,
): number {
  const providerOrder =
    PROVIDER_IDS.indexOf(left.provider) - PROVIDER_IDS.indexOf(right.provider);
  if (providerOrder !== 0) return providerOrder;
  return (providerCacheKey(left) ?? "").localeCompare(
    providerCacheKey(right) ?? "",
  );
}

function serializeCachedProvider(provider: ProviderQuota): object {
  const cacheKey = providerCacheKey(provider);
  return cacheKey ? { ...provider, cacheKey } : provider;
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
