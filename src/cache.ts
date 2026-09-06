import { chmodSync, renameSync, writeFileSync } from "node:fs";
import {
  cacheFilePath,
  claudeCredentialContextId,
  ensurePrivateParent,
  readJsonFile,
} from "./lib/fs.js";
import { selectedKimiCodeContextId } from "./providers/kimi-code-cli-credential.js";
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
  "pi:openai-codex",
  "cli-rpc",
  "cli",
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
const CACHE_SCHEMA_VERSION = 2;
const CREDENTIAL_CONTEXT_ID = /^[a-f0-9]{64}$/;

/**
 * Providers whose local configuration decides which account a reading belongs
 * to: a Claude profile selects the credential store, and a Kimi Code
 * `config.toml` selects the deployment. A snapshot from one such context says
 * nothing about another, so each is stamped on write and required to match on
 * stale reuse.
 *
 * How that stamp is obtained is not the same question for both. A Claude
 * profile is fixed by this process's own environment, so deriving it here reads
 * the same selection the reading used. A Kimi Code environment is not: Kimi
 * Code rewrites `config.toml` on login, so a read taken here - after the quota
 * request has already returned - can describe a deployment the numbers never
 * came from and would file them under its identity. Kimi therefore reports the
 * environment its reading was actually taken under, and a run that selected
 * none leaves the snapshot unstamped, which only ever costs a later stale
 * reuse.
 */
const CONTEXT_SCOPED_PROVIDERS: Partial<
  Record<ProviderId, () => string | undefined>
> = {
  claude: claudeCredentialContextId,
  kimi: selectedKimiCodeContextId,
};

type CachedProvider = {
  snapshot: ProviderQuota;
  credentialContextId?: string;
};

export function readCachedProvider(
  provider: ProviderId,
): ProviderQuota | undefined {
  return readCacheProviders().find(
    (item) => item.snapshot.provider === provider,
  )?.snapshot;
}

/**
 * Claude stale quota may only be reused when the cache record proves it was
 * captured for the same locally selected credential context.
 */
export function readCachedClaudeProvider(
  contextId: string,
): ProviderQuota | undefined {
  return readCachedProviderInContext("claude", contextId);
}

/**
 * Kimi stale quota may only be reused when the cache record proves it was
 * captured for the same locally selected Kimi Code environment, so one
 * deployment's numbers can never stand in for the other's.
 */
export function readCachedKimiProvider(
  contextId: string,
): ProviderQuota | undefined {
  return readCachedProviderInContext("kimi", contextId);
}

function readCachedProviderInContext(
  provider: ProviderId,
  contextId: string,
): ProviderQuota | undefined {
  if (!CREDENTIAL_CONTEXT_ID.test(contextId)) return undefined;
  return readCacheProviders().find(
    (item) =>
      item.snapshot.provider === provider &&
      item.credentialContextId === contextId,
  )?.snapshot;
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
    .filter((provider): provider is CachedProvider => Boolean(provider));

  const file = cacheFilePath();
  const byProvider = new Map<ProviderId, CachedProvider>();
  let clearedExisting = false;
  for (const provider of readCacheProviders()) {
    if (clearProviders.has(provider.snapshot.provider)) {
      clearedExisting = true;
      continue;
    }
    byProvider.set(provider.snapshot.provider, provider);
  }
  if (cacheable.length === 0 && !clearedExisting) return;
  for (const provider of cacheable)
    byProvider.set(provider.snapshot.provider, provider);
  const merged = PROVIDER_IDS.map((provider) =>
    byProvider.get(provider),
  ).filter((provider): provider is CachedProvider => Boolean(provider));

  writeCacheFile(file, merged);
}

export function deleteCachedProvider(provider: ProviderId): void {
  const existing = readCacheProviders();
  if (!existing.some((item) => item.snapshot.provider === provider)) return;
  writeCacheFile(
    cacheFilePath(),
    existing.filter((item) => item.snapshot.provider !== provider),
  );
}

function writeCacheFile(file: string, providers: CachedProvider[]): void {
  ensurePrivateParent(file);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        schemaVersion: CACHE_SCHEMA_VERSION,
        providers: providers.map(serializeCachedProvider),
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

function readCacheProviders(): CachedProvider[] {
  const raw = readJsonFile(cacheFilePath());
  const payload = objectValue(raw);
  const schemaVersion = numberValue(payload?.schemaVersion);
  if (
    !payload ||
    (schemaVersion !== 1 && schemaVersion !== CACHE_SCHEMA_VERSION) ||
    !Array.isArray(payload.providers)
  )
    return [];
  return payload.providers
    .map((provider) => normalizeCachedProvider(provider, schemaVersion))
    .filter((provider): provider is CachedProvider => Boolean(provider));
}

function toCacheProvider(provider: ProviderQuota): CachedProvider | undefined {
  if (provider.state.status !== "fresh" || provider.windows.length === 0)
    return undefined;
  const snapshot = normalizeCachedProvider(
    {
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
        untrustedWindowIds: provider.state.untrustedWindowIds,
        sourcesTried: provider.state.sourcesTried,
      },
    },
    CACHE_SCHEMA_VERSION,
  )?.snapshot;
  if (!snapshot) return undefined;
  const contextId = CONTEXT_SCOPED_PROVIDERS[provider.provider]?.();
  return {
    snapshot,
    ...(contextId ? { credentialContextId: contextId } : {}),
  };
}

function serializeCachedProvider(
  provider: CachedProvider,
): Record<string, unknown> {
  return {
    ...provider.snapshot,
    ...(provider.credentialContextId
      ? { credentialContext: provider.credentialContextId }
      : {}),
  };
}

function normalizeCachedProvider(
  raw: unknown,
  schemaVersion: number,
): CachedProvider | undefined {
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
    windows.length === 0 ||
    (provider === "codex" && hasInvalidCodexWindowIdentities(windows))
  )
    return undefined;

  const snapshot: ProviderQuota = {
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
  const untrustedWindowIds = stringArrayValue(state.untrustedWindowIds);
  const credits = normalizeCachedCredits(data.credits);
  if (plan) snapshot.plan = plan;
  if (refreshedAt) snapshot.state.refreshedAt = refreshedAt;
  if (untrustedWindowIds)
    snapshot.state.untrustedWindowIds = untrustedWindowIds;
  if (credits) snapshot.credits = credits;
  const credentialContext = stringValue(data.credentialContext);
  return {
    snapshot,
    ...(schemaVersion === CACHE_SCHEMA_VERSION &&
    snapshot.provider in CONTEXT_SCOPED_PROVIDERS &&
    credentialContext &&
    CREDENTIAL_CONTEXT_ID.test(credentialContext)
      ? { credentialContextId: credentialContext }
      : {}),
  };
}

function hasInvalidCodexWindowIdentities(windows: QuotaWindow[]): boolean {
  const counts = new Map<string, number>();
  for (const window of windows) {
    const baseId = codexWindowBaseIdentity(window);
    if (!baseId) return true;
    const count = (counts.get(baseId) ?? 0) + 1;
    counts.set(baseId, count);
    if (window.id !== (count === 1 ? baseId : `${baseId}_${count}`))
      return true;
  }
  return false;
}

function codexWindowBaseIdentity(window: QuotaWindow): string | undefined {
  const id = window.id.replace(/_[2-9]\d*$/, "");
  if (window.windowSeconds === undefined) {
    if (matchesWindowIdentity(window, id, "five_hour", "session", "session"))
      return id;
    if (matchesWindowIdentity(window, id, "weekly", "week", "weekly"))
      return id;
    if (
      matchesWindowIdentity(
        window,
        id,
        "code_review_five_hour",
        "code review session",
        "session",
      ) ||
      matchesWindowIdentity(
        window,
        id,
        "code_review_weekly",
        "code review week",
        "weekly",
      ) ||
      matchesModelWindowIdentity(window, id, "5h", "session") ||
      matchesModelWindowIdentity(window, id, "7d", "week")
    )
      return id;
    return undefined;
  }
  if (window.windowSeconds === 18_000) {
    if (
      matchesWindowIdentity(window, id, "five_hour", "session", "session") ||
      matchesWindowIdentity(
        window,
        id,
        "code_review_five_hour",
        "code review session",
        "session",
      ) ||
      matchesModelWindowIdentity(window, id, "5h", "session")
    )
      return id;
    return undefined;
  }

  if (window.windowSeconds === 604_800) {
    if (
      matchesWindowIdentity(window, id, "weekly", "week", "weekly") ||
      matchesWindowIdentity(
        window,
        id,
        "code_review_weekly",
        "code review week",
        "weekly",
      ) ||
      matchesModelWindowIdentity(window, id, "7d", "week")
    )
      return id;
    return undefined;
  }

  const duration = readableWindowDuration(window.windowSeconds);
  if (
    matchesWindowIdentity(
      window,
      id,
      `window:${duration}`,
      `${duration} window`,
      "unknown",
    ) ||
    matchesWindowIdentity(
      window,
      id,
      `code_review_window:${duration}`,
      `${duration} window`,
      "unknown",
    ) ||
    matchesModelWindowIdentity(
      window,
      id,
      `window:${duration}`,
      `${duration} window`,
    )
  )
    return id;
  return undefined;
}

function matchesWindowIdentity(
  window: QuotaWindow,
  actualId: string,
  expectedId: string,
  label: string,
  kind: QuotaWindow["kind"],
): boolean {
  return (
    actualId === expectedId && window.label === label && window.kind === kind
  );
}

function matchesModelWindowIdentity(
  window: QuotaWindow,
  id: string,
  suffix: string,
  labelSuffix: string,
): boolean {
  return (
    id.startsWith("model:") &&
    id.endsWith(`:${suffix}`) &&
    id.length > `model::${suffix}`.length &&
    window.label.endsWith(` ${labelSuffix}`) &&
    window.label.length > labelSuffix.length + 1 &&
    window.kind === "model"
  );
}

function readableWindowDuration(windowSeconds: number): string {
  const hours = windowSeconds / 3600;
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`;
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
  assignString(result, "startsAt", data.startsAt);
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
