import { providerFetch } from "../lib/http.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderId,
  ProviderQuota,
  ProviderSpend,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import {
  type EnvPiCredentialResolution,
  errorCode,
  inspectEnvPiAuth,
  KeyEndpointError,
  keyCredentialFailure,
  pushEnvCredential,
  requestKeyEndpoint,
  statusFromRequestError,
} from "./env-pi-credential.js";

const DAY_MS = 86_400_000;
const DEADLINE_MS = 15_000;
/** The vendor caps a page at 31 daily buckets; a month fits in one or two pages. */
export const SPEND_PAGE_BUCKETS = 31;
const MAX_PAGES = 12;
/** A plain non-negative decimal amount of US dollars, such as `250` or `99.50`. */
const LIMIT_PATTERN = /^\d+(?:\.\d+)?$/;
export const MONTHLY_LIMIT_WINDOW_ID = "monthly_limit";

/** The UTC day range a spend report covers, `[start, end)`. */
export type SpendPeriod = { start: Date; end: Date };

/** One vendor page reduced to the figures quota-axi sums. */
export type SpendPage = {
  buckets: number;
  spentUsd: number;
  nextPage?: string;
};

export type ApiSpendSpec = {
  id: ProviderId;
  label: string;
  /** Explicit admin key variable; there is no other credential source. */
  envVar: string;
  /** Opt-in variable holding the user's own monthly USD limit for this spend. */
  limitEnvVar: string;
  /** Vendor-stated data delay, omitted when the vendor states none. */
  reportedLag?: string;
  url: (period: SpendPeriod, page: string | undefined) => string;
  headers: (key: string) => Record<string, string>;
  parsePage: (raw: unknown) => SpendPage;
};

type Dependencies = {
  environment: () => Readonly<Record<string, string | undefined>>;
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
};

/** The configured monthly limit: unset, a positive USD amount, or unusable. */
export type SpendLimit =
  | { status: "unset" }
  | { status: "set"; limitUsd: number }
  | { status: "invalid" };

/**
 * The current UTC calendar month. `period` is what the cost report is asked
 * for: the first day of the month through the end of the current UTC day, so
 * the day still accruing is included. `resetsAt` is the first instant of the
 * next UTC month, where a monthly limit starts over.
 */
export function currentSpendMonth(nowMs: number): {
  period: SpendPeriod;
  resetsAt: Date;
} {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const todayStart = Date.UTC(year, month, now.getUTCDate());
  return {
    period: {
      start: new Date(Date.UTC(year, month, 1)),
      end: new Date(todayStart + DAY_MS),
    },
    resetsAt: new Date(Date.UTC(year, month + 1, 1)),
  };
}

/**
 * An unset or blank variable means no limit. Anything other than a positive
 * plain decimal is unusable rather than ignored, because reading it as "no
 * limit" would report an account the user capped as uncapped.
 */
export function parseSpendLimit(value: string | undefined): SpendLimit {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return { status: "unset" };
  const limitUsd = Number(trimmed);
  return LIMIT_PATTERN.test(trimmed) &&
    Number.isFinite(limitUsd) &&
    limitUsd > 0
    ? { status: "set", limitUsd }
    : { status: "invalid" };
}

/**
 * The user's configured monthly limit as a window over the current UTC month.
 * The limit is the user's number, not the vendor's, so the window is labeled
 * as configured. Only spend at or over the limit reads 0 remaining: a sliver
 * below it never rounds down to exhaustion.
 */
export function monthlyLimitWindow(
  spentUsd: number,
  limitUsd: number,
  month: { period: SpendPeriod; resetsAt: Date },
): QuotaWindow {
  const percentRemaining =
    spentUsd >= limitUsd
      ? 0
      : Math.max(0.01, roundPercent(100 - (spentUsd / limitUsd) * 100));
  return {
    id: MONTHLY_LIMIT_WINDOW_ID,
    label: "configured monthly limit",
    kind: "monthly",
    percentUsed: roundPercent(100 - percentRemaining),
    percentRemaining,
    startsAt: month.period.start.toISOString(),
    resetsAt: month.resetsAt.toISOString(),
    spentUsd,
    limitUsd,
  };
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createApiSpendAdapter(
  spec: ApiSpendSpec,
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    environment: () => process.env,
    fetch: providerFetch,
    now: () => Date.now(),
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: spec.id,
    label: spec.label,
    fetchQuota: () => fetchSpend(spec, dependencies),
    inspectAuth: async (): Promise<AuthProviderReport> =>
      inspectEnvPiAuth(spec.id, [credential(spec, dependencies)]),
  };
}

function credential(
  spec: ApiSpendSpec,
  dependencies: Dependencies,
): EnvPiCredentialResolution {
  const resolved: EnvPiCredentialResolution[] = [];
  pushEnvCredential(
    resolved,
    dependencies.environment(),
    spec.envVar,
    `env:${spec.envVar}`,
  );
  return resolved[0];
}

async function fetchSpend(
  spec: ApiSpendSpec,
  dependencies: Dependencies,
): Promise<ProviderQuota> {
  const resolution = credential(spec, dependencies);
  const attempts: SourceAttempt[] = [];
  if (resolution.status !== "available") {
    const failure = keyCredentialFailure(spec.id, resolution);
    attempts.push({
      source: resolution.source,
      status: resolution.status === "missing" ? "skipped" : "failed",
      error: failure.error,
      ...(resolution.status === "missing" ? {} : { credentialPresent: true }),
    });
    return failedProvider({
      provider: spec.id,
      label: spec.label,
      status: failure.status,
      error: failure.error,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  const limit = parseSpendLimit(dependencies.environment()[spec.limitEnvVar]);
  if (limit.status === "invalid") {
    // Checked before any request: a limit the user set but quota-axi cannot
    // read must not be reported as no limit.
    return failedProvider({
      provider: spec.id,
      label: spec.label,
      status: "error",
      error: "spend_limit_invalid",
      sourcesTried: [],
    });
  }

  const nowMs = dependencies.now();
  const month = currentSpendMonth(nowMs);
  try {
    const spend = await readSpend(
      spec,
      dependencies,
      resolution.key,
      month.period,
    );
    attempts.push({ source: resolution.source, status: "success" });
    const provider = successProvider({
      provider: spec.id,
      label: spec.label,
      source: "api",
      windows:
        limit.status === "set"
          ? [monthlyLimitWindow(spend.spentUsd, limit.limitUsd, month)]
          : [],
      spend,
      refreshedAt: new Date(nowMs).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    return { ...provider, state: { ...provider.state, authStatus: "usable" } };
  } catch (error) {
    const code = errorCode(error);
    attempts.push({ source: resolution.source, status: "failed", error: code });
    return failedProvider({
      provider: spec.id,
      label: spec.label,
      status: statusFromRequestError(code),
      error: code,
      retryAfter:
        error instanceof KeyEndpointError ? error.retryAfter : undefined,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function readSpend(
  spec: ApiSpendSpec,
  dependencies: Dependencies,
  key: string,
  period: SpendPeriod,
): Promise<ProviderSpend> {
  let spentUsd = 0;
  let buckets = 0;
  let page: string | undefined;
  for (let requests = 0; requests < MAX_PAGES; requests++) {
    const raw = await requestKeyEndpoint(
      spec.url(period, page),
      key,
      dependencies.fetch,
      dependencies.deadlineMs,
      spec.headers,
    );
    const parsed = spec.parsePage(raw);
    spentUsd += parsed.spentUsd;
    buckets += parsed.buckets;
    if (parsed.nextPage === undefined) {
      // A report with no buckets states nothing, so it is not a $0 reading.
      if (buckets === 0) throw new Error("spend_no_buckets");
      return {
        currency: "USD",
        // Round away binary-float dust from summing decimal amounts.
        spentUsd: Math.round(spentUsd * 1e6) / 1e6,
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        buckets,
        ...(spec.reportedLag ? { reportedLag: spec.reportedLag } : {}),
      };
    }
    page = parsed.nextPage;
  }
  throw new Error("spend_period_too_long");
}

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}
