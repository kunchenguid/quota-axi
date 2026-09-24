import { createHash } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import {
  cacheFilePath,
  claudeCredentialContextId,
  ensurePrivateParent,
  readJsonFile,
} from "./lib/fs.js";
import { kimiReadingContextId } from "./providers/kimi-cache-context.js";
import { commandCodeReadingContextId } from "./providers/commandcode-cache-context.js";
import { devinReadingContextId } from "./providers/devin-cache-context.js";
import { elevenLabsReadingContextId } from "./providers/elevenlabs-cache-context.js";
import { miniMaxReadingContextId } from "./providers/minimax-cache-context.js";
import { isPiCodexSource } from "./providers/pi-codex-credential.js";
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
const CACHE_SCHEMA_VERSION = 3;
/**
 * The filler an expanded report stamps on providers that selected one account.
 * It describes that report, not the snapshot, so it is never persisted: a stale
 * reading carrying it back would expand a report in which nothing expanded.
 */
const DEFAULT_ACCOUNT_KEY = "default";
const CREDENTIAL_CONTEXT_ID = /^[a-f0-9]{64}$/;

/**
 * Providers whose snapshots record which account they belong to, because the
 * cache slot alone does not say: a Claude profile selects the credential store,
 * a Kimi Code `config.toml` selects the deployment, Command Code's `whoami`
 * identifies the source-plus-account pair, an ElevenLabs API key is itself the
 * account, MiniMax stamps by credential source plus deployment host, and a
 * Codex slot can be signed in to another ChatGPT account. A snapshot from one
 * such context says nothing about another, so each is stamped on write and
 * checked on stale reuse - strictly for Claude, Kimi, Command Code, MiniMax,
 * ElevenLabs, and Devin, whose identity a reading always has (and which skip
 * write and clear when that identity is missing), and on proven mismatch for Codex,
 * whose stored account id is optional.
 *
 * How that stamp is obtained is not the same question for each. A Claude
 * profile is fixed by this process's own environment, so deriving it here reads
 * the same selection the reading used. Kimi's is not derivable here at all.
 * Kimi Code rewrites `config.toml` on login, so a read taken after the quota
 * request has returned can describe a deployment the numbers never came from;
 * and a Kimi reading need not come from that configuration in the first place,
 * because Pi brokers a credential for the default endpoint while naming no
 * deployment. Kimi therefore reports the identity of whatever actually produced
 * its reading. Command Code likewise publishes the source-plus-account identity
 * `whoami` established, rather than deriving one here. Codex's slot is not local configuration either: a failed probe
 * can only name the accounts the credentials still store, so the stamp is the
 * stored id of the one credential that answered (not the vendor's response id,
 * which can differ while the token is the same) hashed because the cache holds
 * no account identity in the clear. MiniMax publishes the answering credential
 * source plus the deployment host its resolution implies. ElevenLabs publishes
 * a one-way digest of the key that answered, because that key is the only thing
 * naming the subscription and its single slot would otherwise be shared by
 * every key. Devin publishes the answering source, host, and a one-way digest
 * of the session token, because a new login replaces that token.
 */
const CONTEXT_SCOPED_PROVIDERS: Partial<
  Record<ProviderId, (provider: ProviderQuota) => string | undefined>
> = {
  claude: claudeCredentialContextId,
  kimi: kimiReadingContextId,
  commandcode: commandCodeReadingContextId,
  elevenlabs: elevenLabsReadingContextId,
  devin: devinReadingContextId,
  codex: codexStampContextId,
  minimax: miniMaxReadingContextId,
};

/**
 * The stored ChatGPT account id the credential that produced this report named.
 * A symbol key so it survives the object copies the quota command makes between
 * the adapter and this writer, while staying off every serialized surface:
 * `JSON.stringify`, `Object.keys` and the TOON encoder all skip symbol keys.
 */
const CODEX_STORED_ACCOUNT_ID = Symbol("codexStoredAccountId");

type CodexStampedQuota = ProviderQuota & {
  [CODEX_STORED_ACCOUNT_ID]?: string;
};

export function stampCodexStoredAccountId(
  provider: ProviderQuota,
  accountId: string | undefined,
): void {
  if (accountId)
    (provider as CodexStampedQuota)[CODEX_STORED_ACCOUNT_ID] = accountId;
}

function codexStampContextId(provider: ProviderQuota): string | undefined {
  return codexAccountContextId(
    (provider as CodexStampedQuota)[CODEX_STORED_ACCOUNT_ID],
  );
}

function codexAccountContextId(accountId?: string): string | undefined {
  return accountId
    ? createHash("sha256")
        .update(JSON.stringify(["codex-account-v1", accountId]))
        .digest("hex")
    : undefined;
}

type CachedProvider = {
  snapshot: ProviderQuota;
  credentialContextId?: string;
};

export function readCachedProvider(
  provider: ProviderId,
  accountKey?: string,
): ProviderQuota | undefined {
  return readCachedRecord(provider, accountKey)?.snapshot;
}

function readCachedRecord(
  provider: ProviderId,
  accountKey?: string,
): CachedProvider | undefined {
  return readCacheProviders().find(
    (item) =>
      item.snapshot.provider === provider &&
      (item.snapshot.accountKey ?? DEFAULT_ACCOUNT_KEY) ===
        (accountKey ?? DEFAULT_ACCOUNT_KEY),
  );
}

/**
 * Codex stale quota, withheld when the snapshot was stamped with a stored
 * ChatGPT account id none of the failed reading's tried credentials name. A
 * Codex slot is not tied to one account by its name: the keyless slot is shared
 * by a sole discovered lane and the single-account path, and a stable Pi entry
 * key can be signed in to a different account, so the slot alone cannot say
 * whose windows it holds.
 *
 * The stamp is the stored id, not the vendor response id: those can differ
 * while the same token is live, and a later failed probe only has the store.
 * An unstamped snapshot, or a reading whose tried credentials name no account,
 * proves nothing either way and is served as before.
 */
export function readCachedCodexProvider(
  accountKey: string | undefined,
  accountIds: readonly string[],
): ProviderQuota | undefined {
  const record = readCachedRecord("codex", accountKey);
  if (!record) return undefined;
  const contextId = record.credentialContextId;
  if (!contextId || accountIds.length === 0) return record.snapshot;
  return accountIds.some((id) => codexAccountContextId(id) === contextId)
    ? record.snapshot
    : undefined;
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
 * captured from the same source and endpoint the caller is asking about, so one
 * deployment's numbers can never stand in for the other's and a Pi reading of
 * the default endpoint can never stand in for either.
 */
export function readCachedKimiProvider(
  contextId: string,
): ProviderQuota | undefined {
  return readCachedProviderInContext("kimi", contextId);
}

/**
 * Command Code stale quota may only be reused when the cache record proves it
 * was captured for the same source and account the current `whoami` identified.
 */
export function readCachedCommandCodeProvider(
  contextId: string,
): ProviderQuota | undefined {
  return readCachedProviderInContext("commandcode", contextId);
}

/**
 * MiniMax stale quota may only be reused when the cache record proves it was
 * captured from the same credential source and deployment host the caller is
 * asking about.
 */
export function readCachedMiniMaxProvider(
  contextId: string,
): ProviderQuota | undefined {
  return readCachedProviderInContext("minimax", contextId);
}

/**
 * ElevenLabs stale quota may only be reused when the cache record proves it was
 * captured with the same API key, so one subscription's characters can never
 * stand in for another's.
 */
export function readCachedElevenLabsProvider(
  contextId: string,
): ProviderQuota | undefined {
  return readCachedProviderInContext("elevenlabs", contextId);
}

/**
 * Devin stale quota may only be reused when the cache record proves it was
 * captured for the same source, host, and key, so one login's windows can
 * never stand in for another's.
 */
export function readCachedDevinProvider(
  contextId: string,
): ProviderQuota | undefined {
  return readCachedProviderInContext("devin", contextId);
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
  providers = providers.filter(
    (provider) =>
      !(
        (provider.provider === "claude" || provider.provider === "copilot") &&
        provider.source === "cli"
      ),
  );
  const clearProviders = new Set(
    providers
      .filter(
        (provider) =>
          provider.state.status === "fresh" &&
          provider.windows.length === 0 &&
          !missingRequiredContext(provider.provider),
      )
      .map(cacheIdentity),
  );
  const cacheable = providers
    .map(toCacheProvider)
    .filter((provider): provider is CachedProvider => Boolean(provider));

  const file = cacheFilePath();
  const byProvider = new Map<string, CachedProvider>();
  let clearedExisting = false;
  for (const provider of readCacheProviders()) {
    if (clearProviders.has(cacheIdentity(provider.snapshot))) {
      clearedExisting = true;
      continue;
    }
    byProvider.set(cacheIdentity(provider.snapshot), provider);
  }
  if (cacheable.length === 0 && !clearedExisting) return;
  for (const provider of cacheable)
    byProvider.set(cacheIdentity(provider.snapshot), provider);
  const merged = [...byProvider.values()].sort(
    (a, b) =>
      PROVIDER_IDS.indexOf(a.snapshot.provider) -
        PROVIDER_IDS.indexOf(b.snapshot.provider) ||
      (a.snapshot.accountKey ?? DEFAULT_ACCOUNT_KEY).localeCompare(
        b.snapshot.accountKey ?? DEFAULT_ACCOUNT_KEY,
      ),
  );

  writeCacheFile(file, merged);
}

function cacheIdentity(provider: ProviderQuota): string {
  return `${provider.provider}/${provider.accountKey ?? DEFAULT_ACCOUNT_KEY}`;
}

export function deleteCachedProvider(
  provider: ProviderId,
  accountKey?: string,
): void {
  const existing = readCacheProviders();
  const remaining = existing.filter((item) =>
    item.snapshot.provider !== provider
      ? true
      : accountKey !== undefined &&
        (item.snapshot.accountKey ?? DEFAULT_ACCOUNT_KEY) !== accountKey,
  );
  if (remaining.length === existing.length) return;
  writeCacheFile(cacheFilePath(), remaining);
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
    (schemaVersion !== 1 &&
      schemaVersion !== 2 &&
      schemaVersion !== CACHE_SCHEMA_VERSION) ||
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
      accountKey:
        provider.accountKey === DEFAULT_ACCOUNT_KEY
          ? undefined
          : provider.accountKey,
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
  const contextId = CONTEXT_SCOPED_PROVIDERS[provider.provider]?.(provider);
  // Claude, Kimi, Command Code, MiniMax, ElevenLabs, and Devin require a published
  // identity; Codex stamps are optional and withheld only on proven mismatch
  // at read time.
  if (
    provider.provider !== "codex" &&
    CONTEXT_SCOPED_PROVIDERS[provider.provider] &&
    !contextId
  )
    return undefined;
  return {
    snapshot,
    ...(contextId ? { credentialContextId: contextId } : {}),
  };
}

function missingRequiredContext(provider: ProviderId): boolean {
  // Codex stamps are optional; Claude, Kimi, Command Code, MiniMax, ElevenLabs,
  // and Devin must
  // not clear when the current reading has no published context identity.
  if (provider === "codex") return false;
  const scope = CONTEXT_SCOPED_PROVIDERS[provider];
  return scope !== undefined && !scope({ provider } as ProviderQuota);
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
  const source = cachedSource(data.source);
  const state = objectValue(data.state);
  const status = literalValue(state?.status, PROVIDER_STATUSES);
  const sourcesTried = stringArrayValue(state?.sourcesTried);
  const windows = Array.isArray(data.windows)
    ? data.windows
        .map(normalizeCachedWindow)
        .filter((window): window is QuotaWindow => Boolean(window))
        .map((window) =>
          provider === "kimi" ? upgradeLegacyKimiShareWindow(window) : window,
        )
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

  const accountKey = stringValue(data.accountKey);
  if (
    data.accountKey !== undefined &&
    (schemaVersion < 3 ||
      !accountKey ||
      !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(accountKey))
  )
    return undefined;
  const snapshot: ProviderQuota = {
    provider,
    ...(accountKey ? { accountKey } : {}),
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
    ...(schemaVersion >= 2 &&
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
  assignString(result, "shareOf", data.shareOf);
  assignString(result, "startsAt", data.startsAt);
  assignString(result, "resetsAt", data.resetsAt);
  assignString(result, "resetText", data.resetText);
  assignNumber(result, "windowSeconds", data.windowSeconds);
  assignNumber(result, "spentUsd", data.spentUsd);
  assignNumber(result, "limitUsd", data.limitUsd);
  return result;
}

// Kimi snapshots cached before `shareOf` existed store `month_code` with only
// `percentUsed`. `shareOf` is the sole share rule, so restore the marker on
// read; otherwise a stale fallback would render that share as missing data.
function upgradeLegacyKimiShareWindow(window: QuotaWindow): QuotaWindow {
  return window.id === "month_code" &&
    window.shareOf === undefined &&
    window.percentUsed !== undefined
    ? { ...window, shareOf: "month_total" }
    : window;
}

function normalizeCachedCredits(
  raw: unknown,
): ProviderQuota["credits"] | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const remaining = numberValue(data.remaining);
  const unlimited = booleanValue(data.unlimited);
  const unit = literalValue(data.unit, ["usd", "cny", "credits"] as const);
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

function cachedSource(value: unknown): ProviderSource | undefined {
  const source = stringValue(value);
  if (!source) return undefined;
  if ((PROVIDER_SOURCES as readonly string[]).includes(source)) {
    return source as ProviderSource;
  }
  return isPiCodexSource(source) ? (source as ProviderSource) : undefined;
}

function literalValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined {
  return typeof value === "string" && values.includes(value)
    ? value
    : undefined;
}
