import { readCachedProvider, writeCachedProviders } from "./cache.js";
import { nowIso } from "./lib/time.js";
import { PROVIDERS, parseProviders } from "./providers/index.js";
import type {
  ProviderId,
  ProviderOptions,
  ProviderQuota,
  ProviderSource,
  ProviderStateReason,
  ProviderStatus,
  QuotaWindow,
} from "./types.js";
import { PROVIDER_IDS } from "./types.js";

export const WATCH_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SnapshotTrust = "fresh" | "cached" | "stale" | "unavailable";
export type SnapshotLevel = "ok" | "warn" | "critical";

export type BurnRate =
  | { available: true; percentPerHour: number }
  | {
      available: false;
      reason: "unavailable" | "insufficient_data";
    };

export type SnapshotWindow = {
  id: string;
  label: string;
  kind: QuotaWindow["kind"];
  percentRemaining?: number;
  percentUsed?: number;
  resetsAt?: string;
  resetInSeconds: number | null;
  resetText?: string;
  burnRate: BurnRate;
  level: SnapshotLevel;
};

export type ProviderSnapshot = {
  provider: ProviderId;
  label: string;
  trust: SnapshotTrust;
  status: ProviderStatus;
  source: ProviderSource;
  refreshedAt?: string;
  plan?: string;
  windows: SnapshotWindow[];
  primary?: SnapshotWindow;
  error?: string;
  reason?: ProviderStateReason;
  remedyCommand?: string;
};

export type WatchSnapshot = {
  generatedAt: string;
  schemaVersion: typeof WATCH_SNAPSHOT_SCHEMA_VERSION;
  mode: "cache" | "refresh";
  providers: ProviderSnapshot[];
};

export type WatchSnapshotOptions = {
  providers?: ProviderId[] | string;
  /** Default false: cache/last-known only (untaxed agent path). */
  refresh?: boolean;
  allowKeychainPrompt?: boolean;
  now?: Date;
};

export type WatchSnapshotDeps = {
  readCached?: (provider: ProviderId) => ProviderQuota | undefined;
  fetchProvider?: (
    provider: ProviderId,
    options: ProviderOptions,
  ) => Promise<ProviderQuota>;
  writeCache?: (providers: ProviderQuota[]) => void;
  nowIso?: () => string;
};

const WARN_REMAINING = 25;
const CRITICAL_REMAINING = 10;

/**
 * Aggregate provider quota into a render-ready watch snapshot.
 * Default path is cache-only so agent reads stay untaxed.
 */
export async function getWatchSnapshot(
  options: WatchSnapshotOptions = {},
  deps: WatchSnapshotDeps = {},
): Promise<WatchSnapshot> {
  const providers = resolveProviders(options.providers);
  const refresh = options.refresh === true;
  const now = options.now ?? new Date();
  const generatedAt = deps.nowIso?.() ?? nowIso();
  const readCached = deps.readCached ?? readCachedProvider;
  const fetchProvider =
    deps.fetchProvider ??
    ((provider: ProviderId, providerOptions: ProviderOptions) =>
      PROVIDERS[provider].fetchQuota(providerOptions));
  const writeCache = deps.writeCache ?? writeCachedProvidersBestEffort;

  if (!refresh) {
    const cached = providers.map(
      (provider) => readCached(provider) ?? missingCachedProvider(provider),
    );
    return buildWatchSnapshot(cached, {
      mode: "cache",
      now,
      generatedAt,
    });
  }

  const providerOptions: ProviderOptions = {
    allowKeychainPrompt: options.allowKeychainPrompt === true,
  };
  const live = await Promise.all(
    providers.map((provider) => fetchProvider(provider, providerOptions)),
  );
  writeCache(live);
  return buildWatchSnapshot(live, {
    mode: "refresh",
    now,
    generatedAt,
  });
}

export type BuildWatchSnapshotOptions = {
  mode?: "cache" | "refresh";
  now?: Date;
  generatedAt?: string;
};

/** Pure mapper from ProviderQuota[] to WatchSnapshot. */
export function buildWatchSnapshot(
  providers: ProviderQuota[],
  options: BuildWatchSnapshotOptions = {},
): WatchSnapshot {
  const mode = options.mode ?? "cache";
  const now = options.now ?? new Date();
  const generatedAt = options.generatedAt ?? nowIso();
  return {
    generatedAt,
    schemaVersion: WATCH_SNAPSHOT_SCHEMA_VERSION,
    mode,
    providers: providers.map((provider) =>
      toProviderSnapshot(provider, mode, now),
    ),
  };
}

function toProviderSnapshot(
  provider: ProviderQuota,
  mode: "cache" | "refresh",
  now: Date,
): ProviderSnapshot {
  const windows = provider.windows.map((window) =>
    toSnapshotWindow(window, now),
  );
  const primary = selectPrimaryWindow(windows);
  const snapshot: ProviderSnapshot = {
    provider: provider.provider,
    label: provider.label,
    trust: trustFor(provider, mode),
    status: provider.state.status,
    source: provider.source,
    windows,
  };
  if (provider.state.refreshedAt)
    snapshot.refreshedAt = provider.state.refreshedAt;
  if (provider.plan) snapshot.plan = provider.plan;
  if (primary) snapshot.primary = primary;
  if (provider.state.error) snapshot.error = provider.state.error;
  if (provider.state.reason) snapshot.reason = provider.state.reason;
  if (provider.state.remedyCommand)
    snapshot.remedyCommand = provider.state.remedyCommand;
  return snapshot;
}

export function toSnapshotWindow(
  window: QuotaWindow,
  now: Date = new Date(),
): SnapshotWindow {
  const resetInSeconds = computeResetInSeconds(window.resetsAt, now);
  const burnRate = deriveBurnRate(window, now, resetInSeconds);
  const snapshot: SnapshotWindow = {
    id: window.id,
    label: window.label,
    kind: window.kind,
    resetInSeconds,
    burnRate,
    level: levelForRemaining(window.percentRemaining),
  };
  if (window.percentRemaining !== undefined)
    snapshot.percentRemaining = window.percentRemaining;
  if (window.percentUsed !== undefined)
    snapshot.percentUsed = window.percentUsed;
  if (window.resetsAt) snapshot.resetsAt = window.resetsAt;
  if (window.resetText) snapshot.resetText = window.resetText;
  return snapshot;
}

export function deriveBurnRate(
  window: QuotaWindow,
  now: Date = new Date(),
  resetInSeconds: number | null = computeResetInSeconds(window.resetsAt, now),
): BurnRate {
  if (
    window.percentUsed === undefined ||
    window.windowSeconds === undefined ||
    window.windowSeconds <= 0 ||
    resetInSeconds === null
  ) {
    return { available: false, reason: "insufficient_data" };
  }
  const elapsedSeconds = window.windowSeconds - resetInSeconds;
  if (elapsedSeconds <= 0) {
    return { available: false, reason: "insufficient_data" };
  }
  const percentPerHour = (window.percentUsed / elapsedSeconds) * 3600;
  if (!Number.isFinite(percentPerHour) || percentPerHour < 0) {
    return { available: false, reason: "unavailable" };
  }
  return {
    available: true,
    percentPerHour: roundBurn(percentPerHour),
  };
}

export function levelForRemaining(
  percentRemaining: number | undefined,
): SnapshotLevel {
  if (percentRemaining === undefined) return "ok";
  if (percentRemaining <= CRITICAL_REMAINING) return "critical";
  if (percentRemaining <= WARN_REMAINING) return "warn";
  return "ok";
}

export function selectPrimaryWindow(
  windows: SnapshotWindow[],
): SnapshotWindow | undefined {
  if (windows.length === 0) return undefined;
  const session = windows.filter((window) => window.kind === "session");
  const pool = session.length > 0 ? session : windows;
  return [...pool].sort(compareUrgency)[0];
}

function compareUrgency(left: SnapshotWindow, right: SnapshotWindow): number {
  const leftRemaining = left.percentRemaining ?? Number.POSITIVE_INFINITY;
  const rightRemaining = right.percentRemaining ?? Number.POSITIVE_INFINITY;
  if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining;
  const leftReset = left.resetInSeconds ?? Number.POSITIVE_INFINITY;
  const rightReset = right.resetInSeconds ?? Number.POSITIVE_INFINITY;
  return leftReset - rightReset;
}

function trustFor(
  provider: ProviderQuota,
  mode: "cache" | "refresh",
): SnapshotTrust {
  const status = provider.state.status;
  if (
    status === "unavailable" ||
    status === "auth_required" ||
    status === "error" ||
    status === "rate_limited"
  ) {
    return "unavailable";
  }
  if (status === "stale" || provider.state.stale) return "stale";
  if (mode === "cache" || provider.source === "cache") return "cached";
  if (status === "fresh") return "fresh";
  return "unavailable";
}

function computeResetInSeconds(
  resetsAt: string | undefined,
  now: Date,
): number | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  const seconds = Math.floor((resetMs - now.getTime()) / 1000);
  return seconds > 0 ? seconds : null;
}

function roundBurn(value: number): number {
  return Math.round(value * 100) / 100;
}

function resolveProviders(
  value: WatchSnapshotOptions["providers"],
): ProviderId[] {
  if (value === undefined) return [...PROVIDER_IDS];
  if (typeof value === "string") return parseProviders(value);
  return value;
}

function missingCachedProvider(provider: ProviderId): ProviderQuota {
  return {
    provider,
    label: defaultLabel(provider),
    source: "unavailable",
    windows: [],
    state: {
      status: "unavailable",
      stale: false,
      error: "cache_miss",
      sourcesTried: ["cache"],
    },
  };
}

function defaultLabel(provider: ProviderId): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "copilot":
      return "GitHub Copilot";
    case "grok":
      return "Grok";
    case "agy":
      return "Antigravity";
  }
}

function writeCachedProvidersBestEffort(providers: ProviderQuota[]): void {
  try {
    writeCachedProviders(providers);
  } catch {
    return;
  }
}
