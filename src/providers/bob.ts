import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedBobProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { readJsonFileResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { calendarMonthsBefore } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  bobCacheContextId,
  clearBobReadingContextId,
  publishBobReadingContextId,
} from "./bob-cache-context.js";
import { sourceNames, staleFromCache } from "./common.js";
import {
  type EnvPiCredentialResolution,
  errorCode,
  inspectEnvPiAuth,
  KeyEndpointError,
  keyCredentialFailure,
  preferCredentialFailure,
  pushEnvCredential,
  requestKeyEndpoint,
  statusFromRequestError,
} from "./env-pi-credential.js";

export const BOB_API_ORIGIN = "https://api.us-east.bob.ibm.com";
export const BOB_PROFILE_URL = `${BOB_API_ORIGIN}/admin/v1/profile`;

export const BOB_API_KEY_SOURCE = "env:BOB_API_KEY";
export const BOBSHELL_API_KEY_SOURCE = "env:BOBSHELL_API_KEY";

/**
 * Ownership-stability order. `BOB_API_KEY` is the variable Bob documents, and
 * Bob's own startup error names `BOBSHELL_API_KEY` as the one to retire. Bob
 * refuses to start when the two differ, so a different pair is reported as a
 * conflict instead of quota-axi picking an account for the user.
 */
export const BOB_SOURCE_ORDER = [
  BOB_API_KEY_SOURCE,
  BOBSHELL_API_KEY_SOURCE,
] as const;

const ENV_VARS = {
  [BOB_API_KEY_SOURCE]: "BOB_API_KEY",
  [BOBSHELL_API_KEY_SOURCE]: "BOBSHELL_API_KEY",
} as const;

const LABEL = "Bob";
const OPERATION_DEADLINE_MS = 15_000;
const CREDIT_UNIT = "bobcoins";
const API_KEY_SCHEME = "apikey";
const API_KEY_CONFLICT = "bob_api_key_conflict";
const UNSUPPORTED_SERVER = "unsupported_server";
const SETTINGS_UNREADABLE = "bob_settings_unreadable";
const TEAM_SELECTION_REQUIRED = "bob_team_selection_required";

/**
 * Plans whose profile has been read live. Their `refresh_at` is known to be a
 * monthly budget reset and their team budget the account's own. Any other plan
 * still reports its figures, but quota-axi asserts no reset, cycle, or bound for
 * it until a real reading of that plan establishes them.
 */
const OBSERVED_PLAN_IDS = new Set(["ibm_bob_pro_plus_plan"]);

/**
 * The only response keys that survive parsing. The profile also carries user,
 * subscription, instance, and team identifiers and names; a JSON reviver drops
 * every key outside this set while the body is parsed, so those values never
 * reach an object, an error, the cache, or any output.
 */
const RESPONSE_KEYS = new Set([
  "instances",
  "plan_id",
  "plan_name",
  "refresh_at",
  "allow_overage",
  "instance_status",
  "is_internal",
  "teams",
  "usage",
  "budget_limit",
]);

export type BobCredentials = {
  candidates: EnvPiCredentialResolution[];
  /** Set when a present key must not be sent at all. */
  blocked?:
    | typeof API_KEY_CONFLICT
    | typeof UNSUPPORTED_SERVER
    | typeof SETTINGS_UNREADABLE;
};

export type NormalizedBobPayload = {
  plan?: string;
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

type BobDependencies = {
  environment: () => Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: (provider: "bob") => void;
  now: () => number;
  deadlineMs: number;
};

type BobFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  authUsable?: boolean;
  retryAfter?: string;
};

/**
 * The two key variables plus the gateway check. A key is only ever sent to
 * {@link BOB_API_ORIGIN}: a gateway naming anything else means that key belongs
 * to another deployment, so nothing is sent and nothing is read.
 */
export function resolveBobCredentials(
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
): BobCredentials {
  const candidates: EnvPiCredentialResolution[] = [];
  for (const source of BOB_SOURCE_ORDER) {
    pushEnvCredential(candidates, environment, ENV_VARS[source], source);
  }
  if (candidates.every(({ status }) => status === "missing")) {
    return { candidates };
  }
  const { BOB_API_KEY: key, BOBSHELL_API_KEY: legacyKey } = environment;
  if (key?.trim() && legacyKey?.trim() && key !== legacyKey) {
    return { candidates, blocked: API_KEY_CONFLICT };
  }
  const blocked = gatewayBlock(environment.BOB_GATEWAY_URL, home);
  return blocked ? { candidates, blocked } : { candidates };
}

/**
 * `BOB_GATEWAY_URL`, or when that is unset or blank the top-level `gatewayUrl`
 * IBM documents for `settings.json`. A file that cannot be read says nothing
 * about the deployment, so it blocks the key rather than guessing. Other
 * settings can be secrets such as MCP bearer tokens: the reviver drops them
 * while the file is parsed, so they never reach an object.
 */
function gatewayBlock(
  gateway: string | undefined,
  home: string,
): BobCredentials["blocked"] {
  if (gateway?.trim()) {
    return isDefaultGateway(gateway) ? undefined : UNSUPPORTED_SERVER;
  }
  const settings = readJsonFileResult(
    join(home, ".bob", "settings.json"),
    (name, value) => (name === "" || name === "gatewayUrl" ? value : undefined),
  );
  if (settings.status === "missing") return undefined;
  const parsed =
    settings.status === "success" ? objectValue(settings.value) : undefined;
  if (!parsed) return SETTINGS_UNREADABLE;
  const { gatewayUrl } = parsed;
  if (gatewayUrl === undefined) return undefined;
  if (typeof gatewayUrl !== "string") return SETTINGS_UNREADABLE;
  return !gatewayUrl.trim() || isDefaultGateway(gatewayUrl)
    ? undefined
    : UNSUPPORTED_SERVER;
}

function isDefaultGateway(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.origin === BOB_API_ORIGIN && url.pathname === "/";
  } catch {
    return false;
  }
}

export function createBobAdapter(
  overrides: Partial<BobDependencies> = {},
): ProviderAdapter {
  const dependencies: BobDependencies = {
    environment: () => process.env,
    homeDirectory: homedir,
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: () => deleteCachedProviderFromDisk("bob"),
    now: () => Date.now(),
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "bob",
    label: LABEL,
    fetchQuota(): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireBobQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    inspectAuth(): Promise<AuthProviderReport> {
      return Promise.resolve(inspectAuth(dependencies));
    },
  };
}

export const bobAdapter = createBobAdapter();

function inspectAuth(dependencies: BobDependencies): AuthProviderReport {
  const { candidates, blocked } = resolveBobCredentials(
    dependencies.environment(),
    dependencies.homeDirectory(),
  );
  const report = inspectEnvPiAuth("bob", candidates);
  const sources = report.sources.map((source): AuthSourceReport => {
    const path = ENV_VARS[source.source as keyof typeof ENV_VARS];
    return blocked && source.status !== "missing"
      ? {
          source: source.source,
          path,
          status: "skipped",
          error: blocked,
          credentialPresent: true,
        }
      : { ...source, path };
  });
  return { ...report, sources };
}

async function acquireBobQuota(
  dependencies: BobDependencies,
): Promise<ProviderQuota> {
  clearBobReadingContextId();
  const attempts: SourceAttempt[] = [];
  const { candidates, blocked } = resolveBobCredentials(
    dependencies.environment(),
    dependencies.homeDirectory(),
  );

  let credentialFailure: ReturnType<typeof keyCredentialFailure> | undefined;
  for (const resolution of candidates) {
    if (blocked && resolution.status !== "missing") {
      attempts.push({
        source: resolution.source,
        status: "skipped",
        error: blocked,
        credentialPresent: true,
      });
      continue;
    }
    if (resolution.status === "available") {
      return readProfile(resolution, attempts, dependencies);
    }
    const failure = keyCredentialFailure("bob", resolution);
    attempts.push({
      source: resolution.source,
      status: resolution.status === "missing" ? "skipped" : "failed",
      error: failure.error,
      ...(resolution.status === "missing" ? {} : { credentialPresent: true }),
    });
    credentialFailure = preferCredentialFailure(credentialFailure, failure);
  }

  if (blocked) {
    return failureReport(
      new BobFailure(blocked),
      undefined,
      attempts,
      dependencies,
    );
  }
  const failure = credentialFailure ?? {
    status: "auth_required" as const,
    error: "bob_credential_unavailable",
  };
  return failureReport(
    new BobFailure(failure.error, {
      status: failure.status,
      definitiveAuth: true,
    }),
    undefined,
    attempts,
    dependencies,
  );
}

async function readProfile(
  credential: Extract<EnvPiCredentialResolution, { status: "available" }>,
  attempts: SourceAttempt[],
  dependencies: BobDependencies,
): Promise<ProviderQuota> {
  const { key, source } = credential;
  // The key is the account here, so its identity is known before the request
  // and a failed read can still serve exactly its own cached snapshot.
  const cacheContextId = bobCacheContextId(source, key);
  publishBobReadingContextId(cacheContextId);
  try {
    const payload = await requestKeyEndpoint(
      BOB_PROFILE_URL,
      key,
      dependencies.fetch,
      dependencies.deadlineMs,
      {
        authScheme: API_KEY_SCHEME,
        jsonRejectionOnly: true,
        reviver: (name, value) =>
          name === "" || /^\d+$/.test(name) || RESPONSE_KEYS.has(name)
            ? value
            : undefined,
      },
    );
    const normalized = normalizeBobPayload(payload, dependencies.now());
    attempts.push({ source, status: "success" });
    return {
      provider: "bob",
      label: LABEL,
      source: "api",
      ...(normalized.plan ? { plan: normalized.plan } : {}),
      windows: normalized.windows,
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        refreshedAt: new Date(dependencies.now()).toISOString(),
        ...(normalized.untrustedWindowIds.length > 0
          ? { untrustedWindowIds: normalized.untrustedWindowIds }
          : {}),
        sourcesTried: sourceNames(attempts),
      },
      attempts,
    };
  } catch (error) {
    const failure = asBobFailure(error);
    attempts.push({ source, status: "failed", error: failure.code });
    return failureReport(failure, cacheContextId, attempts, dependencies);
  }
}

function failureReport(
  failure: BobFailure,
  cacheContextId: string | undefined,
  attempts: SourceAttempt[],
  dependencies: BobDependencies,
): ProviderQuota {
  if (failure.definitiveAuth && cacheContextId) {
    try {
      if (dependencies.readCachedProvider(cacheContextId)) {
        dependencies.deleteCachedProvider("bob");
      }
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible && cacheContextId) {
    try {
      const cached = dependencies.readCachedProvider(cacheContextId);
      const stale = cached
        ? staleFromCache(
            cached,
            failure.code,
            sourceNames(attempts),
            attempts,
            dependencies.now(),
          )
        : undefined;
      if (stale) {
        if (failure.retryAfter) stale.state.retryAfter = failure.retryAfter;
        return stale;
      }
    } catch {
      // Cache I/O cannot replace the bounded current provider failure.
    }
  }

  return {
    provider: "bob",
    label: LABEL,
    source: "unavailable",
    windows: [],
    state: {
      status: failure.status,
      stale: false,
      error: failure.code,
      ...(failure.authUsable ? { authStatus: "usable" as const } : {}),
      ...(failure.definitiveAuth ? { authStatus: "unusable" as const } : {}),
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: sourceNames(attempts),
    },
    attempts,
  };
}

/**
 * One budget window from a single instance's single team, in Bobcoins.
 *
 * Bob's profile names no cycle start, so a monthly cycle is stepped back from
 * `refresh_at` by one calendar month, and that cycle stands only while `now`
 * is inside it. Anything that cannot be read as that established shape stays
 * in `untrustedWindowIds`: the figures the vendor did supply are kept, and no
 * effective bound is claimed from them.
 *
 * More than one instance or team means the key's budget is ambiguous, and
 * quota-axi must not pick one, so that reading publishes no window at all.
 */
export function normalizeBobPayload(
  payload: unknown,
  now: number,
): NormalizedBobPayload {
  const instances = arrayValue(objectValue(payload)?.instances);
  if (!instances) throw schemaFailure();
  if (instances.length === 0) return { windows: [], untrustedWindowIds: [] };
  if (instances.length > 1) throw teamSelectionFailure();

  const instance = objectValue(instances[0]);
  const teams = arrayValue(instance?.teams);
  if (!instance || !teams) throw schemaFailure();
  if (teams.length > 1) throw teamSelectionFailure();

  const plan = nonemptyString(instance.plan_name);
  const planFields = plan ? { plan } : {};
  if (teams.length === 0) {
    return { ...planFields, windows: [], untrustedWindowIds: [] };
  }
  const team = objectValue(teams[0]);
  if (!team) throw schemaFailure();

  const observedPlan =
    typeof instance.plan_id === "string" &&
    OBSERVED_PLAN_IDS.has(instance.plan_id) &&
    instance.is_internal === false;
  const used = nonnegativeFinite(team.usage);
  const limit = nonnegativeFinite(team.budget_limit);
  const measurable = used !== undefined && limit !== undefined && limit > 0;
  const cycle = observedPlan
    ? currentCycle(parseUnixSeconds(instance.refresh_at), now)
    : undefined;

  const window = budgetWindow(observedPlan, instance.allow_overage);
  const trusted =
    observedPlan &&
    typeof instance.allow_overage === "boolean" &&
    instance.instance_status === "active" &&
    measurable &&
    cycle !== undefined;
  const untrustedWindowIds = trusted ? [] : [window.id];
  if (used === undefined && limit === undefined) {
    return { ...planFields, windows: [], untrustedWindowIds };
  }

  const percentUsed = measurable
    ? Math.min(100, (used / limit) * 100)
    : undefined;
  return {
    ...planFields,
    windows: [
      {
        ...window,
        ...(percentUsed !== undefined
          ? { percentUsed, percentRemaining: 100 - percentUsed }
          : {}),
        ...cycle,
        ...(limit !== undefined ? { limitCredits: limit } : {}),
        ...(used !== undefined ? { usedCredits: used } : {}),
        ...(measurable ? { remainingCredits: Math.max(0, limit - used) } : {}),
        creditUnit: CREDIT_UNIT,
      },
    ],
    untrustedWindowIds,
  };
}

/**
 * Opted-in overage bills past the budget, so a spent budget then means the
 * included allowance is gone, not that requests stop.
 */
function budgetWindow(
  observedPlan: boolean,
  allowOverage: unknown,
): Pick<QuotaWindow, "id" | "label" | "kind"> {
  if (!observedPlan) {
    return { id: "plan_budget", label: "budget", kind: "credits" };
  }
  return allowOverage === true
    ? { id: "included_monthly", label: "month", kind: "monthly" }
    : { id: "monthly_budget", label: "month", kind: "monthly" };
}

function currentCycle(
  resetsAt: string | undefined,
  now: number,
): Pick<QuotaWindow, "startsAt" | "resetsAt"> | undefined {
  const startsAt = resetsAt && calendarMonthsBefore(resetsAt, 1);
  return startsAt && Date.parse(startsAt) <= now && now < Date.parse(resetsAt)
    ? { startsAt, resetsAt }
    : undefined;
}

function parseUnixSeconds(value: unknown): string | undefined {
  const minResetMs = 1_000_000_000_000;
  const seconds = nonnegativeFinite(value);
  if (seconds === undefined) return undefined;
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || ms < minResetMs) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function asBobFailure(error: unknown): BobFailure {
  if (error instanceof BobFailure) return error;
  const code = errorCode(error);
  const retryAfter =
    error instanceof KeyEndpointError ? error.retryAfter : undefined;
  const status = statusFromRequestError(code);
  if (status === "auth_required") {
    return new BobFailure(code, { status, definitiveAuth: true });
  }
  return new BobFailure(code, { status, staleEligible: true, retryAfter });
}

function schemaFailure(): BobFailure {
  return new BobFailure("schema_invalid", { staleEligible: true });
}

function teamSelectionFailure(): BobFailure {
  return new BobFailure(TEAM_SELECTION_REQUIRED, {
    status: "unavailable",
    authUsable: true,
  });
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class BobFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly authUsable: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: BobFailureOptions = {}) {
    super(code);
    this.name = "BobFailure";
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible === true;
    this.definitiveAuth = options.definitiveAuth === true;
    this.authUsable = options.authUsable === true;
    this.retryAfter = options.retryAfter;
  }
}
