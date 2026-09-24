import { deleteCachedProvider as deleteCachedProviderFromDisk } from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { clampPercent } from "../lib/time.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderId,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  errorCode,
  KeyEndpointError,
  keyCredentialFailure,
  requestKeyEndpoint,
  statusFromRequestError,
  type EnvPiCredentialResolution,
} from "./env-pi-credential.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

export const OLLAMA_CLOUD_USAGE_URL = "https://ollama.com/api/usage";
export const OLLAMA_CLOUD_API_KEY_SOURCE = "env:OLLAMA_API_KEY";

/** Ownership order for the only credential source quota-axi can prove is a Cloud key. */
export const OLLAMA_CLOUD_SOURCE_ORDER = [OLLAMA_CLOUD_API_KEY_SOURCE] as const;

const LABEL = "Ollama Cloud";
const REQUEST_DEADLINE_MS = 15_000;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

type WindowDescriptor = {
  key: "session" | "weekly";
  id: "five_hour" | "weekly";
  label: string;
  kind: "session" | "weekly";
  windowSeconds: number;
};

const WINDOWS: readonly WindowDescriptor[] = [
  {
    key: "session",
    id: "five_hour",
    label: "session",
    kind: "session",
    windowSeconds: FIVE_HOURS_SECONDS,
  },
  {
    key: "weekly",
    id: "weekly",
    label: "week",
    kind: "weekly",
    windowSeconds: WEEK_SECONDS,
  },
];

const WINDOW_KEYS: Readonly<Record<string, true>> = {
  session: true,
  weekly: true,
  monthly: true,
};

type Dependencies = {
  environment?: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
  deleteCachedProvider: (provider: ProviderId) => void;
};

type NormalizedOllamaCloudPayload = {
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

function resolveCredential(
  environment: Readonly<Record<string, string | undefined>>,
): EnvPiCredentialResolution {
  const source = OLLAMA_CLOUD_SOURCE_ORDER[0];
  const raw = environment.OLLAMA_API_KEY;
  if (raw === undefined || raw.trim().length === 0)
    return { status: "missing", source };
  const key = usableLiteralSecret(raw);
  return key
    ? { status: "available", key, source }
    : { status: "invalid", source };
}

function inspectAuth(
  environment: Readonly<Record<string, string | undefined>>,
): AuthProviderReport {
  try {
    const resolution = resolveCredential(environment);
    if (resolution.status === "available")
      return {
        provider: "ollama-cloud",
        sources: [
          {
            source: resolution.source,
            path: "OLLAMA_API_KEY",
            status: "available",
          },
        ],
      };
    const failure = keyCredentialFailure("ollama-cloud", resolution);
    return {
      provider: "ollama-cloud",
      sources: [
        {
          source: resolution.source,
          path: "OLLAMA_API_KEY",
          status: resolution.status === "missing" ? "missing" : "invalid",
          ...(resolution.status !== "missing" ? { error: failure.error } : {}),
        },
      ],
    };
  } catch {
    return {
      provider: "ollama-cloud",
      sources: [
        {
          source: OLLAMA_CLOUD_API_KEY_SOURCE,
          path: "OLLAMA_API_KEY",
          status: "error",
          error: "credential_resolution_failed",
        },
      ],
    };
  }
}

export function createOllamaCloudAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: REQUEST_DEADLINE_MS,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    ...overrides,
  };

  return {
    id: "ollama-cloud",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () =>
      Promise.resolve(inspectAuth(dependencies.environment ?? process.env)),
  };
}

export const ollamaCloudAdapter = createOllamaCloudAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let resolution: EnvPiCredentialResolution;
  try {
    resolution = resolveCredential(dependencies.environment ?? process.env);
  } catch {
    resolution = {
      status: "error",
      source: OLLAMA_CLOUD_SOURCE_ORDER[0],
    };
  }

  if (resolution.status !== "available") {
    const failure = keyCredentialFailure("ollama-cloud", resolution);
    attempts.push({
      source: resolution.source,
      status: resolution.status === "missing" ? "skipped" : "failed",
      error: failure.error,
      ...(resolution.status === "missing" ? {} : { credentialPresent: true }),
    });
    if (failure.status === "auth_required") deleteCachedProvider(dependencies);
    return failedProvider({
      provider: "ollama-cloud",
      label: LABEL,
      status: failure.status,
      error: failure.error,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  attempts.push({ source: resolution.source, status: "failed" });
  try {
    const payload = await requestKeyEndpoint(
      OLLAMA_CLOUD_USAGE_URL,
      resolution.key,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const normalized = normalizeOllamaCloudPayload(payload);
    attempts[0] = { source: resolution.source, status: "success" };
    const report = successProvider({
      provider: "ollama-cloud",
      label: LABEL,
      source: "api",
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    return {
      ...report,
      state: {
        ...report.state,
        authStatus: "usable",
        ...(normalized.untrustedWindowIds.length > 0
          ? { untrustedWindowIds: normalized.untrustedWindowIds }
          : {}),
      },
    };
  } catch (error) {
    const code = errorCode(error);
    attempts[0] = { source: resolution.source, status: "failed", error: code };
    if (code === "provider_auth_rejected") deleteCachedProvider(dependencies);
    return failedProvider({
      provider: "ollama-cloud",
      label: LABEL,
      status: statusFromRequestError(code),
      error: code,
      retryAfter:
        error instanceof KeyEndpointError ? error.retryAfter : undefined,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

function deleteCachedProvider(dependencies: Dependencies): void {
  try {
    dependencies.deleteCachedProvider("ollama-cloud");
  } catch {
    // Cache I/O must not replace the current credential result.
  }
}

export function normalizeOllamaCloudPayload(
  raw: unknown,
): NormalizedOllamaCloudPayload {
  const root = objectValue(raw);
  const limits = objectValue(root?.limits);
  if (!root || !limits) throw new Error("schema_invalid");

  const windows: QuotaWindow[] = [];
  const untrustedWindowIds = new Set<string>();
  for (const descriptor of WINDOWS) {
    const value = limits[descriptor.key];
    if (value === undefined || value === null) continue;
    const parsed = objectValue(value);
    const usage =
      typeof parsed?.usage === "number" && Number.isFinite(parsed.usage)
        ? parsed.usage
        : undefined;
    const base: QuotaWindow = {
      id: descriptor.id,
      label: descriptor.label,
      kind: descriptor.kind,
      windowSeconds: descriptor.windowSeconds,
    };
    if (usage === undefined) {
      windows.push(base);
      untrustedWindowIds.add(descriptor.id);
      continue;
    }
    const percentUsed = clampPercent(usage * 100);
    windows.push({
      ...base,
      percentUsed,
      percentRemaining: 100 - percentUsed,
    });
  }

  const monthly = limits.monthly;
  const monthlyEntry = objectValue(monthly);
  const monthlySpend =
    monthly !== undefined && monthly !== null
      ? nonnegativeAmount(monthlyEntry?.usage)
      : undefined;
  if (monthly !== undefined && monthly !== null) {
    if (monthlySpend === undefined) {
      untrustedWindowIds.add("monthly_spend");
    } else {
      windows.push({
        id: "monthly_spend",
        label: "monthly",
        kind: "monthly",
        spentUsd: monthlySpend,
      });
    }
  }

  const activityValue = root.activity;
  if (activityValue !== undefined && activityValue !== null) {
    const activity = objectValue(activityValue);
    const activitySpend = nonnegativeAmount(activity?.cost);
    if (activitySpend !== undefined) {
      windows.push({
        id: "activity",
        label: "activity",
        kind: "unknown",
        spentUsd: activitySpend,
      });
    } else {
      untrustedWindowIds.add("activity");
    }
  }

  const hasLegacyEntry = WINDOWS.some(
    ({ key }) => limits[key] !== undefined && limits[key] !== null,
  );
  if (monthlySpend === undefined || hasLegacyEntry) {
    for (const descriptor of WINDOWS) {
      if (
        limits[descriptor.key] === undefined ||
        limits[descriptor.key] === null
      )
        untrustedWindowIds.add(descriptor.id);
    }
  }

  let unknownWindow = 0;
  for (const key of Object.keys(limits)) {
    if (WINDOW_KEYS[key]) continue;
    unknownWindow += 1;
    const id = `limit:${unknownWindow}`;
    windows.push({ id, label: `limit ${unknownWindow}`, kind: "unknown" });
    untrustedWindowIds.add(id);
  }

  return { windows, untrustedWindowIds: [...untrustedWindowIds] };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}
function nonnegativeAmount(value: unknown): number | undefined {
  let amount: number;
  if (typeof value === "number") {
    amount = value;
  } else if (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value.trim())
  ) {
    amount = Number(value.trim());
  } else {
    return undefined;
  }
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}
