import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedCommandCodeProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { clampPercent, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { VERSION } from "../version.js";
import {
  COMMANDCODE_API_KEY_SOURCE,
  COMMANDCODE_CLI_CREDENTIAL_SOURCE,
  COMMAND_CODE_API_KEY_SOURCE,
  createCommandCodeCliCredentialSource,
  createCommandCodeEnvSource,
  createOmpCommandCodeCredentialSource,
  OMP_COMMANDCODE_CREDENTIAL_SOURCE,
  type CommandCodeEnvSource,
  type CommandCodeFileSource,
} from "./commandcode-api-key.js";
import {
  clearCommandCodeReadingContextId,
  commandCodeCacheContextId,
  publishCommandCodeReadingContextId,
} from "./commandcode-cache-context.js";
import { servableStaleWindows, servableUntrustedWindowIds } from "./common.js";
import {
  selectCredential,
  type CandidateLocalState,
} from "./credential-selection.js";
import {
  createPiCommandCodeCredentialBroker,
  PI_COMMANDCODE_CREDENTIAL_SOURCE,
  type CommandCodeLocalResolution,
  type PiCommandCodeCredentialBroker,
} from "./pi-commandcode-credential.js";

export const COMMANDCODE_API_ORIGIN = "https://api.commandcode.ai";
export const COMMANDCODE_WHOAMI_PATH = "/alpha/whoami";
export const COMMANDCODE_CREDITS_PATH = "/alpha/billing/credits";

export const COMMANDCODE_SOURCE_ORDER = [
  PI_COMMANDCODE_CREDENTIAL_SOURCE,
  COMMAND_CODE_API_KEY_SOURCE,
  COMMANDCODE_API_KEY_SOURCE,
  COMMANDCODE_CLI_CREDENTIAL_SOURCE,
  OMP_COMMANDCODE_CREDENTIAL_SOURCE,
] as const;

export type CommandCodeSourceName = (typeof COMMANDCODE_SOURCE_ORDER)[number];

const LABEL = "Command Code";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const USER_AGENT = `quota-axi/${VERSION}`;
const EXPECTED_WINDOW_IDS = ["five_hour", "weekly"] as const;
const KNOWN_WINDOW_LIMIT_KEYS = new Set(["limited", "fiveHour", "weekly"]);

export type CommandCodeDiagnostic =
  | { code: "credits_incomplete" }
  | { code: "expected_window_invalid"; id: "five_hour" | "weekly" }
  | { code: "unknown_window"; id: string }
  | { code: "org_limit"; id: string };

export type NormalizedCommandCodePayload = {
  credits?: { remaining: number; unit: "credits" };
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
  diagnostics: CommandCodeDiagnostic[];
};

type CommandCodeDependencies = {
  piBroker: PiCommandCodeCredentialBroker;
  officialEnv: CommandCodeEnvSource;
  legacyEnv: CommandCodeEnvSource;
  cliSource: CommandCodeFileSource;
  ompSource: CommandCodeFileSource;
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: (provider: "commandcode") => void;
  now: () => number;
  deadlineMs: number;
};

type CommandCodeFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  authUsable?: boolean;
  retryAfter?: string;
};

type ResponseBodyLifetime = {
  markConsumed(): void;
  cancel(action?: () => Promise<unknown> | undefined): Promise<void>;
};

type WhoamiIdentity = {
  orgId?: string;
  account?: ProviderQuota["account"];
  accountIdentity?: string;
  orgLimitWindows: QuotaWindow[];
  untrustedWindowIds: string[];
};

type CommandCodeCandidate =
  | { status: "available"; credential: string }
  | {
      status: "unavailable";
      failure: CommandCodeFailure;
      attemptStatus: "skipped" | "failed";
      credentialPresent: boolean;
    };

type FailureRecord = {
  failure: CommandCodeFailure;
  credentialPresent: boolean;
  cacheContextId?: string;
};

export function createCommandCodeAdapter(
  overrides: Partial<CommandCodeDependencies> = {},
): ProviderAdapter {
  const dependencies: CommandCodeDependencies = {
    piBroker: createPiCommandCodeCredentialBroker(),
    officialEnv: createCommandCodeEnvSource("COMMAND_CODE_API_KEY"),
    legacyEnv: createCommandCodeEnvSource("COMMANDCODE_API_KEY"),
    cliSource: createCommandCodeCliCredentialSource(),
    ompSource: createOmpCommandCodeCredentialSource(),
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: () => deleteCachedProviderFromDisk("commandcode"),
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "commandcode",
    label: LABEL,
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireCommandCodeQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const commandCodeAdapter = createCommandCodeAdapter();

async function inspectAuth(
  dependencies: CommandCodeDependencies,
): Promise<AuthProviderReport> {
  const [pi, official, legacy, cli, omp] = await Promise.all([
    inspectPi(dependencies.piBroker),
    inspectEnv(COMMAND_CODE_API_KEY_SOURCE, dependencies.officialEnv),
    inspectEnv(COMMANDCODE_API_KEY_SOURCE, dependencies.legacyEnv),
    inspectFile(COMMANDCODE_CLI_CREDENTIAL_SOURCE, dependencies.cliSource),
    inspectFile(OMP_COMMANDCODE_CREDENTIAL_SOURCE, dependencies.ompSource),
  ]);
  return {
    provider: "commandcode",
    sources: [pi, official, legacy, cli, omp],
  };
}

async function inspectPi(
  broker: PiCommandCodeCredentialBroker,
): Promise<AuthSourceReport> {
  try {
    const inspection = await broker.inspect();
    return {
      source: PI_COMMANDCODE_CREDENTIAL_SOURCE,
      path: inspection.path,
      status: inspection.status,
      ...(inspection.error ? { error: inspection.error } : {}),
    };
  } catch {
    return {
      source: PI_COMMANDCODE_CREDENTIAL_SOURCE,
      status: "error",
      error: "credential_resolution_failed",
    };
  }
}

async function inspectEnv(
  source: string,
  envSource: CommandCodeEnvSource,
): Promise<AuthSourceReport> {
  try {
    const inspection = await envSource.inspect();
    return {
      source,
      status: inspection.status,
      ...(inspection.error ? { error: inspection.error } : {}),
    };
  } catch {
    return { source, status: "error", error: "credential_resolution_failed" };
  }
}

async function inspectFile(
  source: string,
  fileSource: CommandCodeFileSource,
): Promise<AuthSourceReport> {
  try {
    const inspection = await fileSource.inspect();
    return {
      source,
      path: inspection.path,
      status: inspection.status,
      ...(inspection.error ? { error: inspection.error } : {}),
    };
  } catch {
    return { source, status: "error", error: "credential_resolution_failed" };
  }
}

async function acquireCommandCodeQuota(
  dependencies: CommandCodeDependencies,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  const attempts: SourceAttempt[] = [];
  const failures: FailureRecord[] = [];
  let cacheContextId: string | undefined;
  clearCommandCodeReadingContextId();

  try {
    for (const source of COMMANDCODE_SOURCE_ORDER) {
      const candidate = await resolveCandidate(source, dependencies);
      if (candidate.status === "unavailable") {
        attempts.push({
          source,
          status: candidate.attemptStatus,
          error: candidate.failure.code,
          ...(candidate.credentialPresent ? { credentialPresent: true } : {}),
        });
        failures.push({
          failure: candidate.failure,
          credentialPresent: candidate.credentialPresent,
        });
        if (controller.signal.aborted) break;
        continue;
      }

      let report: ProviderQuota | undefined;
      const credentialSelection = await selectCredential(
        [
          {
            source,
            localState: "valid" as CandidateLocalState,
            credential: candidate.credential,
          },
        ],
        async (selected) => {
          attempts.push({ source, status: "failed" });
          try {
            const reading = await readCommandCodeQuota(
              selected.credential,
              source,
              attempts,
              controller.signal,
              dependencies,
            );
            report = reading.report;
            cacheContextId = reading.cacheContextId;
            if (cacheContextId) {
              publishCommandCodeReadingContextId(cacheContextId);
            }
            return { kind: "quota", result: report };
          } catch (error) {
            const failure = asCommandCodeFailure(error);
            attempts[attempts.length - 1] = {
              source,
              status: "failed",
              error: failure.code,
            };
            if (failure.cacheContextId) cacheContextId = failure.cacheContextId;
            failures.push({
              failure,
              credentialPresent: true,
              cacheContextId: failure.cacheContextId ?? cacheContextId,
            });
            return failure.definitiveAuth
              ? { kind: "rejected", error: failure.code }
              : { kind: "transient", error: failure.code };
          }
        },
      );
      if (credentialSelection.outcome === "quota" && report) return report;
      if (
        credentialSelection.outcome !== "all_rejected" ||
        controller.signal.aborted
      ) {
        break;
      }
    }

    const defining = definingFailure(failures);
    return failureReport(
      defining.failure,
      defining.cacheContextId,
      attempts,
      dependencies,
    );
  } catch (error) {
    const failure = asCommandCodeFailure(error);
    if (attempts.length === 0) {
      attempts.push({
        source: PI_COMMANDCODE_CREDENTIAL_SOURCE,
        status: "failed",
        error: failure.code,
      });
    } else {
      attempts[attempts.length - 1] = {
        source: attempts[attempts.length - 1].source,
        status: "failed",
        error: failure.code,
      };
    }
    return failureReport(failure, cacheContextId, attempts, dependencies);
  } finally {
    clearTimeout(deadline);
  }
}

async function resolveCandidate(
  source: CommandCodeSourceName,
  dependencies: CommandCodeDependencies,
): Promise<CommandCodeCandidate> {
  try {
    const resolution = await resolverFor(source, dependencies).resolve();
    if (resolution.status === "resolved") {
      return { status: "available", credential: resolution.credential };
    }
    return unavailableCandidate(
      credentialFailureFor(resolution),
      resolution.status === "read_error" ? "failed" : "skipped",
      resolution.status !== "absent",
    );
  } catch (error) {
    return unavailableCandidate(asCommandCodeFailure(error), "failed", true);
  }
}

function resolverFor(
  source: CommandCodeSourceName,
  dependencies: CommandCodeDependencies,
): { resolve(): Promise<CommandCodeLocalResolution> } {
  switch (source) {
    case PI_COMMANDCODE_CREDENTIAL_SOURCE:
      return dependencies.piBroker;
    case COMMAND_CODE_API_KEY_SOURCE:
      return dependencies.officialEnv;
    case COMMANDCODE_API_KEY_SOURCE:
      return dependencies.legacyEnv;
    case COMMANDCODE_CLI_CREDENTIAL_SOURCE:
      return dependencies.cliSource;
    case OMP_COMMANDCODE_CREDENTIAL_SOURCE:
      return dependencies.ompSource;
  }
}

function unavailableCandidate(
  failure: CommandCodeFailure,
  attemptStatus: "skipped" | "failed",
  credentialPresent: boolean,
): CommandCodeCandidate {
  return { status: "unavailable", failure, attemptStatus, credentialPresent };
}

async function readCommandCodeQuota(
  credential: string,
  source: string,
  attempts: SourceAttempt[],
  signal: AbortSignal,
  dependencies: CommandCodeDependencies,
): Promise<{ report: ProviderQuota; cacheContextId?: string }> {
  const whoami = await requestJson(
    whoamiUrl(),
    credential,
    signal,
    dependencies,
    "whoami",
  );
  const identity = identityFromWhoami(whoami);
  const cacheContextId = identity.accountIdentity
    ? commandCodeCacheContextId(source, identity.accountIdentity)
    : undefined;
  if (cacheContextId) publishCommandCodeReadingContextId(cacheContextId);

  let creditsPayload: unknown;
  try {
    creditsPayload = await requestJson(
      creditsUrl(identity.orgId),
      credential,
      signal,
      dependencies,
      "credits",
    );
  } catch (error) {
    const failure = asCommandCodeFailure(error);
    failure.authUsable = true;
    failure.staleEligible = true;
    failure.cacheContextId = cacheContextId;
    throw failure;
  }

  const normalized = normalizeCommandCodePayload(creditsPayload, identity);
  const refreshedAt = new Date(dependencies.now()).toISOString();
  attempts[attempts.length - 1] = { source, status: "success" };
  return {
    cacheContextId,
    report: {
      provider: "commandcode",
      label: LABEL,
      source: "api",
      ...(identity.account ? { account: identity.account } : {}),
      windows: normalized.windows,
      ...(normalized.credits ? { credits: normalized.credits } : {}),
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        refreshedAt,
        ...(normalized.untrustedWindowIds.length > 0
          ? { untrustedWindowIds: normalized.untrustedWindowIds }
          : {}),
        sourcesTried: attempts.map(({ source: name }) => name),
      },
      attempts,
    },
  };
}

function whoamiUrl(): string {
  const url = new URL(COMMANDCODE_WHOAMI_PATH, COMMANDCODE_API_ORIGIN);
  url.searchParams.set("limits", "1");
  return url.href;
}

function creditsUrl(orgId: string | undefined): string {
  const url = new URL(COMMANDCODE_CREDITS_PATH, COMMANDCODE_API_ORIGIN);
  if (orgId) url.searchParams.set("orgId", orgId);
  return url.href;
}

async function requestJson(
  url: string,
  credential: string,
  signal: AbortSignal,
  dependencies: CommandCodeDependencies,
  surface: "whoami" | "credits",
): Promise<unknown> {
  let response: Response;
  try {
    response = await waitForDeadline(
      dependencies.fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        credentials: "omit",
        redirect: "manual",
        signal,
      }),
      signal,
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new CommandCodeFailure("request_timeout", {
        staleEligible: surface === "credits",
        authUsable: surface === "credits",
      });
    }
    throw new CommandCodeFailure(localTransportCode(error), {
      staleEligible: surface === "credits",
      authUsable: surface === "credits",
    });
  }

  const lifetime = createResponseBodyLifetime(response);
  try {
    const receivedAt = dependencies.now();
    rejectHttpFailure(response, receivedAt, surface);
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      throw new CommandCodeFailure("unexpected_content_type", {
        staleEligible: surface === "credits",
        authUsable: surface === "credits",
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, signal, lifetime, surface);
      lifetime.markConsumed();
    } catch (error) {
      if (error instanceof CommandCodeFailure) throw error;
      if (signal.aborted || isAbortError(error)) {
        throw new CommandCodeFailure("request_timeout", {
          staleEligible: surface === "credits",
          authUsable: surface === "credits",
        });
      }
      throw new CommandCodeFailure("network_unavailable", {
        staleEligible: surface === "credits",
        authUsable: surface === "credits",
      });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CommandCodeFailure("response_invalid_utf8", {
        staleEligible: surface === "credits",
        authUsable: surface === "credits",
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CommandCodeFailure("malformed_json", {
        staleEligible: surface === "credits",
        authUsable: surface === "credits",
      });
    }
  } finally {
    await lifetime.cancel();
  }
}

function rejectHttpFailure(
  response: Response,
  receivedAt: number,
  surface: "whoami" | "credits",
): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new CommandCodeFailure("redirect_rejected", {
      authUsable: surface === "credits",
      staleEligible: surface === "credits",
    });
  }
  if (status === 401) {
    throw new CommandCodeFailure(
      surface === "whoami"
        ? "provider_auth_rejected"
        : "provider_request_rejected",
      {
        status: surface === "whoami" ? "auth_required" : "error",
        definitiveAuth: surface === "whoami",
        authUsable: surface === "credits",
        staleEligible: surface === "credits",
      },
    );
  }
  if (status === 403) {
    throw new CommandCodeFailure("provider_request_rejected", {
      authUsable: surface === "credits",
      staleEligible: surface === "credits",
    });
  }
  if (status === 408) {
    throw new CommandCodeFailure("provider_timeout", {
      staleEligible: surface === "credits",
      authUsable: surface === "credits",
    });
  }
  if (status === 429) {
    throw new CommandCodeFailure("provider_rate_limited", {
      status: "rate_limited",
      staleEligible: surface === "credits",
      authUsable: surface === "credits",
      retryAfter: retryAfterToIso(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new CommandCodeFailure("provider_unavailable", {
      staleEligible: surface === "credits",
      authUsable: surface === "credits",
    });
  }
  throw new CommandCodeFailure("provider_request_rejected", {
    authUsable: surface === "credits",
    staleEligible: surface === "credits",
  });
}

export function normalizeCommandCodePayload(
  payload: unknown,
  identity: Pick<WhoamiIdentity, "orgLimitWindows" | "untrustedWindowIds"> = {
    orgLimitWindows: [],
    untrustedWindowIds: [],
  },
): NormalizedCommandCodePayload {
  const root = objectValue(payload);
  const data = objectValue(root?.data) ?? root;
  if (!data) {
    throw new CommandCodeFailure("schema_invalid", {
      staleEligible: true,
      authUsable: true,
    });
  }

  const credits = exactCredits(data);
  const windowLimits = objectValue(data.windowLimits);
  const diagnostics: CommandCodeDiagnostic[] = [];
  const windows: QuotaWindow[] = [];
  const untrustedWindowIds = [...identity.untrustedWindowIds];

  if (credits === undefined && objectValue(data) && !hasCreditFields(data)) {
    diagnostics.push({ code: "credits_incomplete" });
  } else if (credits === undefined && hasPartialCreditFields(data)) {
    diagnostics.push({ code: "credits_incomplete" });
  }

  const limited = data.windowLimits === undefined ? undefined : windowLimits;
  const limitedFlag =
    limited && typeof limited.limited === "boolean"
      ? limited.limited
      : undefined;

  // limited:false is credit-only: leftover five-hour/weekly fields are omitted.
  // Any other present windowLimits object jointly binds five-hour and weekly;
  // a missing companion stays untrusted.
  for (const id of EXPECTED_WINDOW_IDS) {
    if (limitedFlag === false) continue;
    const key = id === "five_hour" ? "fiveHour" : "weekly";
    const entry = windowLimits ? windowLimits[key] : undefined;
    const measured = measuredWindow(id, entry);
    if (measured) {
      windows.push(measured);
      continue;
    }
    if (windowLimits) {
      windows.push(placeholderWindow(id));
      untrustedWindowIds.push(id);
      diagnostics.push({ code: "expected_window_invalid", id });
    }
  }

  if (windowLimits) {
    for (const [key, value] of Object.entries(windowLimits)) {
      if (KNOWN_WINDOW_LIMIT_KEYS.has(key)) continue;
      const unknownId = `window:${sanitizeId(key)}`;
      if (isObject(value)) {
        windows.push(unknownWindow(unknownId, value, key));
      }
      untrustedWindowIds.push(unknownId);
      diagnostics.push({ code: "unknown_window", id: unknownId });
    }
  }

  for (const window of identity.orgLimitWindows) {
    windows.push(window);
    untrustedWindowIds.push(window.id);
    diagnostics.push({ code: "org_limit", id: window.id });
  }

  if (
    credits === undefined &&
    windows.length === 0 &&
    windowLimits === undefined &&
    identity.orgLimitWindows.length === 0
  ) {
    throw new CommandCodeFailure("schema_invalid", {
      staleEligible: true,
      authUsable: true,
    });
  }

  if (credits === undefined && hasPartialCreditFields(data)) {
    // Keep independently valid windows; withhold the exact aggregate.
  }

  return {
    ...(credits ? { credits } : {}),
    windows,
    untrustedWindowIds: [...new Set(untrustedWindowIds)],
    diagnostics,
  };
}

function exactCredits(
  data: Record<string, unknown>,
): { remaining: number; unit: "credits" } | undefined {
  const monthly = nonnegativeFinite(data.monthlyCredits);
  const purchased = nonnegativeFinite(data.purchasedCredits);
  const free = nonnegativeFinite(data.freeCredits);
  if (monthly === undefined || purchased === undefined || free === undefined) {
    return undefined;
  }
  return { remaining: monthly + purchased + free, unit: "credits" };
}

function hasCreditFields(data: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(data, "monthlyCredits") ||
    Object.hasOwn(data, "purchasedCredits") ||
    Object.hasOwn(data, "freeCredits")
  );
}

function hasPartialCreditFields(data: Record<string, unknown>): boolean {
  return hasCreditFields(data) && exactCredits(data) === undefined;
}

function measuredWindow(
  id: "five_hour" | "weekly",
  raw: unknown,
): QuotaWindow | undefined {
  const entry = objectValue(raw);
  if (!entry) return undefined;
  const used = nonnegativeFinite(entry.used);
  const cap = nonnegativeFinite(entry.cap);
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  const percentUsed = clampPercent((used / cap) * 100);
  const resetsAt = parseResetAt(
    entry.resetAt ?? entry.resetTime ?? entry.reset_at ?? entry.reset_time,
  );
  return {
    id,
    label: id === "five_hour" ? "5-hour" : "Weekly",
    kind: id === "five_hour" ? "session" : "weekly",
    percentUsed,
    percentRemaining: clampPercent(100 - percentUsed),
    windowSeconds: id === "five_hour" ? FIVE_HOURS_SECONDS : WEEK_SECONDS,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function placeholderWindow(id: "five_hour" | "weekly"): QuotaWindow {
  return {
    id,
    label: id === "five_hour" ? "5-hour" : "Weekly",
    kind: id === "five_hour" ? "session" : "weekly",
    windowSeconds: id === "five_hour" ? FIVE_HOURS_SECONDS : WEEK_SECONDS,
  };
}

function unknownWindow(
  id: string,
  entry: Record<string, unknown>,
  key: string,
): QuotaWindow {
  const used = nonnegativeFinite(entry.used);
  const cap = nonnegativeFinite(entry.cap);
  const resetsAt = parseResetAt(
    entry.resetAt ?? entry.resetTime ?? entry.reset_at ?? entry.reset_time,
  );
  const percentages =
    used !== undefined && cap !== undefined && cap > 0
      ? {
          percentUsed: clampPercent((used / cap) * 100),
          percentRemaining: clampPercent(
            100 - clampPercent((used / cap) * 100),
          ),
        }
      : {};
  return {
    id,
    label: sanitizeLabel(stringValue(entry.label) ?? key),
    kind: "unknown",
    ...percentages,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function identityFromWhoami(payload: unknown): WhoamiIdentity {
  const root = objectValue(payload);
  const data = objectValue(root?.data) ?? root;
  if (!data) return { orgLimitWindows: [], untrustedWindowIds: [] };

  const org = objectValue(data.org) ?? objectValue(data.organization);
  const user = objectValue(data.user);
  const orgId = nonemptyString(org?.id);
  const userId =
    nonemptyString(data.id) ??
    nonemptyString(data.userId) ??
    nonemptyString(user?.id);
  const login =
    nonemptyString(org?.login) ??
    nonemptyString(org?.name) ??
    nonemptyString(user?.name) ??
    nonemptyString(data.login) ??
    nonemptyString(data.email) ??
    nonemptyString(user?.email);

  const accountIdentity = orgId
    ? `org:${orgId}`
    : userId
      ? `user:${userId}`
      : login
        ? `login:${sanitizeId(login)}`
        : undefined;

  const organization = sanitizeOptionalLabel(
    nonemptyString(org?.login) ?? nonemptyString(org?.name),
  );
  const identityStatus: "verified" | "unverified" =
    orgId || userId ? "verified" : "unverified";
  const account =
    orgId || userId || organization
      ? {
          ...(organization ? { organization } : {}),
          ...(orgId || userId ? { accountId: orgId ?? userId } : {}),
          identityStatus,
        }
      : undefined;

  const { windows, untrustedWindowIds } = orgLimitWindows(data.orgLimits);
  return {
    ...(orgId ? { orgId } : {}),
    ...(account ? { account } : {}),
    ...(accountIdentity ? { accountIdentity } : {}),
    orgLimitWindows: windows,
    untrustedWindowIds,
  };
}

function orgLimitWindows(raw: unknown): {
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
} {
  if (raw === undefined || raw === null) {
    return { windows: [], untrustedWindowIds: [] };
  }
  if (!Array.isArray(raw)) {
    const id = "org_limit";
    return {
      windows: [
        {
          id,
          label: "org limit",
          kind: "unknown",
        },
      ],
      untrustedWindowIds: [id],
    };
  }
  if (raw.length === 0) return { windows: [], untrustedWindowIds: [] };

  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];
  for (const [offset, entry] of raw.entries()) {
    const id = raw.length === 1 ? "org_limit" : `org_limit:${offset + 1}`;
    untrustedWindowIds.push(id);
    const object = objectValue(entry);
    if (!object) {
      windows.push({ id, label: `org limit ${offset + 1}`, kind: "unknown" });
      continue;
    }
    const spent = nonnegativeFinite(entrySpent(object));
    const limit = nonnegativeFinite(entryLimit(object));
    const resetsAt = parseResetAt(
      object.resetAt ??
        object.resetTime ??
        object.reset_at ??
        object.reset_time,
    );
    const percentages =
      spent !== undefined && limit !== undefined && limit > 0
        ? {
            percentUsed: clampPercent((spent / limit) * 100),
            percentRemaining: clampPercent(
              100 - clampPercent((spent / limit) * 100),
            ),
          }
        : {};
    windows.push({
      id,
      label: sanitizeLabel(
        nonemptyString(object.name) ??
          nonemptyString(object.label) ??
          `org limit ${offset + 1}`,
      ),
      kind: "unknown",
      ...percentages,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return { windows, untrustedWindowIds };
}

function entrySpent(object: Record<string, unknown>): unknown {
  return object.spent ?? object.used;
}

function entryLimit(object: Record<string, unknown>): unknown {
  return object.limit ?? object.cap;
}

function parseResetAt(value: unknown): string | undefined {
  // Command Code leaves unused rolling windows at resetAt 0 / epoch. Treat those
  // as "no reset yet" rather than 1970-01-01, which poisons pace as expired.
  const minResetMs = 1_000_000_000_000;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value >= minResetMs ? value : value * 1000;
    if (!Number.isFinite(ms) || ms < minResetMs) return undefined;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
      return parseResetAt(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed) || parsed < minResetMs) return undefined;
    return new Date(parsed).toISOString();
  }
  return undefined;
}

function credentialFailureFor(
  resolution: Exclude<CommandCodeLocalResolution, { status: "resolved" }>,
): CommandCodeFailure {
  if (resolution.status === "absent") {
    return new CommandCodeFailure("commandcode_sign_in_required", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "unsupported") {
    return new CommandCodeFailure("unsupported_credential_type", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (resolution.status === "read_error") {
    return new CommandCodeFailure("credential_resolution_failed", {
      staleEligible: false,
    });
  }
  return new CommandCodeFailure("commandcode_credential_invalid", {
    status: "auth_required",
    definitiveAuth: true,
  });
}

function definingFailure(failures: FailureRecord[]): FailureRecord {
  return (
    // A context-carrying stale-eligible failure can still serve this account's
    // cached snapshot, so an earlier context-less resolver error must not
    // suppress it. Definitive auth failures are never preferred over it.
    failures.find(
      (record) =>
        !record.failure.definitiveAuth &&
        record.failure.staleEligible &&
        record.cacheContextId !== undefined,
    ) ??
    failures.find((record) => !record.failure.definitiveAuth) ??
    failures.find((record) => record.credentialPresent) ??
    failures[0] ?? {
      failure: new CommandCodeFailure("commandcode_sign_in_required", {
        status: "auth_required",
        definitiveAuth: true,
      }),
      credentialPresent: false,
    }
  );
}

function asCommandCodeFailure(error: unknown): CommandCodeFailure {
  return error instanceof CommandCodeFailure
    ? error
    : new CommandCodeFailure("credential_resolution_failed");
}

function failureReport(
  failure: CommandCodeFailure,
  cacheContextId: string | undefined,
  attempts: SourceAttempt[],
  dependencies: CommandCodeDependencies,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      dependencies.deleteCachedProvider("commandcode");
    } catch {
      // The current auth failure is still definitive even if the cache is not writable.
    }
  }

  if (failure.staleEligible && cacheContextId) {
    try {
      const cached = dependencies.readCachedProvider(cacheContextId);
      const stale = cached
        ? staleCommandCodeReport(cached, failure, attempts, dependencies.now())
        : undefined;
      if (stale) return stale;
    } catch {
      // Cache I/O cannot replace the bounded current provider failure.
    }
  }

  return {
    provider: "commandcode",
    label: LABEL,
    source: "unavailable",
    windows: [],
    state: {
      status: failure.status,
      stale: false,
      error: failure.definitiveAuth
        ? signInError(failure.code, attempts)
        : failure.code,
      ...(failure.authUsable ? { authStatus: "usable" as const } : {}),
      ...(failure.definitiveAuth && !failure.authUsable
        ? { authStatus: "unusable" as const }
        : {}),
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: attempts.map(({ source }) => source),
    },
    attempts,
  };
}

function signInError(code: string, attempts: SourceAttempt[]): string {
  const present = attempts.some(
    (attempt) =>
      attempt.credentialPresent === true || attempt.status === "failed",
  );
  if (!present) return "commandcode_sign_in_required";
  return code === "provider_auth_rejected"
    ? "commandcode_sign_in_required"
    : code;
}

function staleCommandCodeReport(
  cached: ProviderQuota,
  failure: CommandCodeFailure,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "commandcode" ||
    cached.source !== "api" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  ) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(cached.state.refreshedAt))) return undefined;
  const windows = servableStaleWindows(cached, now);
  if (windows.length === 0) return undefined;
  const untrustedWindowIds = servableUntrustedWindowIds(cached, windows);

  return {
    provider: "commandcode",
    label: LABEL,
    source: "cache",
    windows,
    ...(cached.credits ? { credits: cached.credits } : {}),
    state: {
      status: "stale",
      stale: true,
      authStatus: failure.authUsable ? "usable" : cached.state.authStatus,
      refreshedAt: cached.state.refreshedAt,
      error: failure.code,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      ...(untrustedWindowIds ? { untrustedWindowIds } : {}),
      sourcesTried: [...attempts.map(({ source }) => source), "cache"],
    },
    attempts,
  };
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
  surface: "whoami" | "credits",
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      throw new CommandCodeFailure("response_too_large", {
        staleEligible: surface === "credits",
        authUsable: surface === "credits",
      });
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readBodyChunk(
        reader,
        signal,
        lifetime,
        surface,
      );
      if (done) break;
      length += value.length;
      if (length > RESPONSE_LIMIT_BYTES) {
        throw new CommandCodeFailure("response_too_large", {
          staleEligible: surface === "credits",
          authUsable: surface === "credits",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
  surface: "whoami" | "credits",
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const cancelReader = () => lifetime.cancel(() => reader.cancel());
  if (signal.aborted) {
    await cancelReader();
    throw new CommandCodeFailure("request_timeout", {
      staleEligible: surface === "credits",
      authUsable: surface === "credits",
    });
  }
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      cancelReader().then(() => {
        reject(
          new CommandCodeFailure("request_timeout", {
            staleEligible: surface === "credits",
            authUsable: surface === "credits",
          }),
        );
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => {
        if (aborted) return;
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        if (aborted) return;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function createResponseBodyLifetime(response: Response): ResponseBodyLifetime {
  let consumed = false;
  let cancellation: Promise<void> | undefined;

  return {
    markConsumed() {
      if (!cancellation) consumed = true;
    },
    async cancel(action = () => response.body?.cancel()) {
      if (consumed) return;
      cancellation ??= Promise.resolve()
        .then(action)
        .then(() => undefined)
        .catch(() => undefined);
      await cancellation;
    },
  };
}

function waitForDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new CommandCodeFailure("request_timeout"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CommandCodeFailure("request_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function localTransportCode(
  error: unknown,
): "tls_failed" | "network_unavailable" {
  const cause = objectValue(objectValue(error)?.cause);
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  return code && /(?:TLS|SSL|CERT|UNABLE_TO_VERIFY)/i.test(code)
    ? "tls_failed"
    : "network_unavailable";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function nonnegativeFinite(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "unknown";
}

function sanitizeLabel(value: string): string {
  const cleaned = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  return (cleaned.length > 0 ? cleaned : "unknown").slice(0, 80);
}

function sanitizeOptionalLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const label = sanitizeLabel(value);
  return label === "unknown" && value.trim().length === 0 ? undefined : label;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

class CommandCodeFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  staleEligible: boolean;
  readonly definitiveAuth: boolean;
  authUsable: boolean;
  readonly retryAfter?: string;
  cacheContextId?: string;

  constructor(code: string, options: CommandCodeFailureOptions = {}) {
    super(code);
    this.name = "CommandCodeFailure";
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible === true;
    this.definitiveAuth = options.definitiveAuth === true;
    this.authUsable = options.authUsable === true;
    this.retryAfter = options.retryAfter;
  }
}
