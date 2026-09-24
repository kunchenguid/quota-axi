import { TextDecoder } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedDevinProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { retryAfterToIso } from "../lib/time.js";
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
import { staleFromCache } from "./common.js";
import { selectCredential } from "./credential-selection.js";
import {
  clearDevinReadingContextId,
  devinCacheContextId,
  publishDevinReadingContextId,
} from "./devin-cache-context.js";

export const DEVIN_API_ORIGIN = "https://server.codeium.com";
export const DEVIN_USER_STATUS_PATH =
  "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

export const DEVIN_ENV_SOURCE = "env:WINDSURF_API_KEY";
export const DEVIN_FILE_SOURCE = "file:credentials.toml";

/**
 * Ownership-stability order. The vendor CLI resolves `WINDSURF_API_KEY` before
 * the credentials file, so a non-blank environment value is this session's
 * identity. A blank value selects nothing and leaves the file path in place.
 */
export const DEVIN_SOURCE_ORDER = [
  DEVIN_ENV_SOURCE,
  DEVIN_FILE_SOURCE,
] as const;

export type DevinSourceName = (typeof DEVIN_SOURCE_ORDER)[number];

const LABEL = "Devin";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 1_048_576;
const CREDENTIALS_LIMIT_BYTES = 65_536;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;
const USER_AGENT = `quota-axi/${VERSION}`;
const QUOTA_BILLING = "BILLING_STRATEGY_QUOTA";
const QUOTA_FIELDS = [
  "weeklyQuotaRemainingPercent",
  "weeklyQuotaResetAtUnix",
  "dailyQuotaRemainingPercent",
  "dailyQuotaResetAtUnix",
];
const SIGN_IN_REMEDY = "devin auth login";

/**
 * Vendor session tokens embed one literal `$` separator
 * (`devin-session-token$<jwt>`). `usableLiteralSecret` rejects every `$` so a
 * shell or template reference is never executed; that rule would also refuse
 * every real Devin session. This pattern is the only `$` form accepted, and it
 * is sent verbatim rather than resolved.
 */
const DEVIN_SESSION_TOKEN =
  /^devin-session-token\$[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/;

const CREDENTIAL_KEYS = new Set(["windsurf_api_key", "api_server_url"]);

export type DevinResolvedCredential = {
  token: string;
  origin: string;
};

export type DevinLocalResolution =
  | { status: "resolved"; credential: DevinResolvedCredential }
  | { status: "absent" }
  | { status: "structurally_invalid"; error: string }
  | { status: "unsupported"; error: string }
  | { status: "read_error"; error: string };

export type DevinCredentialSource = {
  name: DevinSourceName;
  resolve(): DevinLocalResolution;
  inspect(): {
    status: AuthSourceReport["status"];
    error?: string;
    path?: string;
    credentialPresent?: boolean;
  };
};

export type NormalizedDevinPayload = {
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: NonNullable<ProviderQuota["credits"]>;
  untrustedWindowIds: string[];
};

type DevinDependencies = {
  sources: readonly DevinCredentialSource[];
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProviderFromDisk;
  deleteCachedProvider: (provider: "devin") => void;
  now: () => number;
  deadlineMs: number;
};

type DevinFailureOptions = {
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

type CredentialFields = {
  windsurf_api_key?: string;
  api_server_url?: string;
};

/**
 * Accept a Devin credential only when it is a literal secret. A vendor session
 * token is allowed through the `$` exception above; every other `$` or `!`
 * form is refused locally and never sent.
 */
export function usableDevinCredential(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (DEVIN_SESSION_TOKEN.test(trimmed)) return trimmed;
  return usableLiteralSecret(trimmed);
}

export function devinCredentialsFilePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: { platform?: NodeJS.Platform; home?: string } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const xdg = environment.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "devin", "credentials.toml");
  if (platform === "win32") {
    const appData = environment.APPDATA?.trim();
    return appData ? join(appData, "devin", "credentials.toml") : undefined;
  }
  return join(home, ".local", "share", "devin", "credentials.toml");
}

export function createDevinEnvSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DevinCredentialSource {
  const resolve = (): DevinLocalResolution => {
    const raw = environment.WINDSURF_API_KEY;
    if (raw === undefined || raw.trim().length === 0)
      return { status: "absent" };
    return resolutionFromFields({
      windsurf_api_key: raw,
      api_server_url: blankToUndefined(environment.WINDSURF_API_SERVER_URL),
    });
  };
  return {
    name: DEVIN_ENV_SOURCE,
    resolve,
    inspect() {
      return inspectResolution(resolve(), "WINDSURF_API_KEY");
    },
  };
}

export function createDevinFileSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  io: {
    readFile?: (path: string) => Uint8Array;
    platform?: NodeJS.Platform;
    home?: string;
  } = {},
): DevinCredentialSource {
  const readFile =
    io.readFile ??
    ((path: string): Uint8Array => {
      const bytes = readFileSync(path);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    });
  const resolve = (): DevinLocalResolution => {
    const path = devinCredentialsFilePath(environment, io);
    if (!path) return { status: "absent" };
    let bytes: Uint8Array;
    try {
      bytes = readFile(path);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (code === "ENOENT") return { status: "absent" };
      return { status: "read_error", error: "devin_credentials_unreadable" };
    }
    if (bytes.byteLength > CREDENTIALS_LIMIT_BYTES) {
      return { status: "read_error", error: "devin_credentials_unreadable" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        status: "structurally_invalid",
        error: "devin_credentials_malformed",
      };
    }
    const fields = parseDevinCredentialsToml(text);
    if (!fields) {
      return {
        status: "structurally_invalid",
        error: "devin_credentials_malformed",
      };
    }
    if (fields.windsurf_api_key === undefined) return { status: "absent" };
    return resolutionFromFields(fields);
  };
  return {
    name: DEVIN_FILE_SOURCE,
    resolve,
    inspect() {
      const path = devinCredentialsFilePath(environment, io);
      return inspectResolution(resolve(), path);
    },
  };
}

export function createDevinAdapter(
  overrides: Partial<DevinDependencies> = {},
): ProviderAdapter {
  const dependencies: DevinDependencies = {
    sources: [createDevinEnvSource(), createDevinFileSource()],
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: () => deleteCachedProviderFromDisk("devin"),
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  let inFlight: Promise<ProviderQuota> | undefined;

  return {
    id: "devin",
    label: LABEL,
    isUncertainSkip(attempt) {
      return attempt.error === "unsupported_server";
    },
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      if (inFlight) return inFlight;
      const acquisition = acquireDevinQuota(dependencies).finally(() => {
        if (inFlight === acquisition) inFlight = undefined;
      });
      inFlight = acquisition;
      return acquisition;
    },
    inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
      return Promise.resolve(inspectAuth(dependencies));
    },
  };
}

export const devinAdapter = createDevinAdapter();

function inspectAuth(dependencies: DevinDependencies): AuthProviderReport {
  return {
    provider: "devin",
    sources: dependencies.sources.map((source) => {
      try {
        const inspection = source.inspect();
        return {
          source: source.name,
          ...(inspection.path ? { path: inspection.path } : {}),
          status: inspection.status,
          ...(inspection.error ? { error: inspection.error } : {}),
          ...(inspection.credentialPresent
            ? { credentialPresent: true as const }
            : {}),
        };
      } catch {
        return {
          source: source.name,
          status: "error" as const,
          error: "credential_resolution_failed",
        };
      }
    }),
  };
}

async function acquireDevinQuota(
  dependencies: DevinDependencies,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  const attempts: SourceAttempt[] = [];
  let rejectedContextId: string | undefined;
  let rejectedFailure: DevinFailure | undefined;
  clearDevinReadingContextId();

  try {
    for (const source of dependencies.sources) {
      const resolution = resolveSource(source);
      if (resolution.status === "absent") {
        attempts.push({
          source: source.name,
          status: "skipped",
          error: "devin_credential_unavailable",
        });
        continue;
      }
      if (resolution.status === "structurally_invalid") {
        attempts.push({
          source: source.name,
          status: "failed",
          error: resolution.error,
          credentialPresent: true,
        });
        // A present but unusable value is the identity the vendor would use.
        // Falling through would report a different account.
        return failureReport(
          new DevinFailure(resolution.error),
          undefined,
          attempts,
          dependencies,
        );
      }
      if (resolution.status === "read_error") {
        attempts.push({
          source: source.name,
          status: "failed",
          error: resolution.error,
        });
        return failureReport(
          new DevinFailure(resolution.error, { staleEligible: true }),
          undefined,
          attempts,
          dependencies,
        );
      }
      if (resolution.status === "unsupported") {
        attempts.push({
          source: source.name,
          status: "skipped",
          error: resolution.error,
          credentialPresent: true,
        });
        return failureReport(
          new DevinFailure(resolution.error),
          undefined,
          attempts,
          dependencies,
        );
      }

      const contextId = devinCacheContextId(
        source.name,
        resolution.credential.origin,
        resolution.credential.token,
      );
      publishDevinReadingContextId(contextId);
      let emptyReading: NormalizedDevinPayload | undefined;
      const selection = await selectCredential(
        [
          {
            source: source.name,
            localState: "valid",
            credential: resolution.credential,
          },
        ],
        async (candidate) => {
          try {
            const payload = await requestUserStatus(
              candidate.credential,
              controller.signal,
              dependencies,
            );
            const normalized = normalizeDevinPayload(
              payload,
              dependencies.now(),
            );
            if (
              normalized.windows.length === 0 &&
              normalized.credits === undefined
            ) {
              emptyReading = normalized;
              return { kind: "live_no_quota" };
            }
            return { kind: "quota", result: normalized };
          } catch (error) {
            const failure = asDevinFailure(error);
            if (failure.definitiveAuth) {
              return { kind: "rejected", error: failure.code };
            }
            return {
              kind: "transient",
              error: failure.code,
              ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
            };
          }
        },
      );

      if (selection.outcome === "quota" && selection.result) {
        attempts.push({ source: source.name, status: "success" });
        return freshReport(selection.result, attempts, dependencies);
      }
      if (selection.outcome === "live_no_quota" && emptyReading) {
        // The credential is live and this source is the session identity.
        // Handover waits for a definitive rejection, not an empty quota body.
        attempts.push({ source: source.name, status: "success" });
        return freshReport(emptyReading, attempts, dependencies);
      }
      if (selection.outcome === "transient") {
        attempts.push({
          source: source.name,
          status: "failed",
          error: selection.transientError,
        });
        return failureReport(
          failureFromTransient(selection.transientError, selection.retryAfter),
          contextId,
          attempts,
          dependencies,
        );
      }

      const error = selection.results[0]?.error ?? "provider_auth_rejected";
      attempts.push({
        source: source.name,
        status: "failed",
        error,
        credentialPresent: true,
      });
      rejectedContextId = contextId;
      rejectedFailure = new DevinFailure(error, {
        status: "auth_required",
        definitiveAuth: true,
      });
    }

    if (rejectedFailure) {
      return failureReport(
        rejectedFailure,
        rejectedContextId,
        attempts,
        dependencies,
      );
    }
    return failureReport(
      new DevinFailure("devin_credential_unavailable", {
        status: "auth_required",
        definitiveAuth: true,
      }),
      undefined,
      attempts,
      dependencies,
    );
  } catch (error) {
    const failure = asDevinFailure(error);
    if (attempts.length === 0) {
      attempts.push({
        source: DEVIN_ENV_SOURCE,
        status: "failed",
        error: failure.code,
      });
    }
    return failureReport(failure, undefined, attempts, dependencies);
  } finally {
    clearTimeout(deadline);
  }
}

function resolveSource(source: DevinCredentialSource): DevinLocalResolution {
  try {
    return source.resolve();
  } catch {
    return { status: "read_error", error: "credential_resolution_failed" };
  }
}

function freshReport(
  normalized: NormalizedDevinPayload,
  attempts: SourceAttempt[],
  dependencies: DevinDependencies,
): ProviderQuota {
  return {
    provider: "devin",
    label: LABEL,
    source: "api",
    ...(normalized.plan ? { plan: normalized.plan } : {}),
    ...(normalized.account ? { account: normalized.account } : {}),
    windows: normalized.windows,
    ...(normalized.credits ? { credits: normalized.credits } : {}),
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: new Date(dependencies.now()).toISOString(),
      ...(normalized.untrustedWindowIds.length > 0
        ? { untrustedWindowIds: normalized.untrustedWindowIds }
        : {}),
      sourcesTried: attempts.map(({ source }) => source),
    },
    attempts,
  };
}

function failureReport(
  failure: DevinFailure,
  cacheContextId: string | undefined,
  attempts: SourceAttempt[],
  dependencies: DevinDependencies,
): ProviderQuota {
  if (failure.definitiveAuth && cacheContextId) {
    retireMatchingCache(cacheContextId, dependencies);
  }

  if (failure.staleEligible && cacheContextId) {
    try {
      const cached = dependencies.readCachedProvider(cacheContextId);
      const stale = cached
        ? staleFromCache(
            cached,
            failure.code,
            attempts.map(({ source }) => source),
            attempts,
            dependencies.now(),
          )
        : undefined;
      if (stale) {
        return {
          ...stale,
          label: LABEL,
          state: {
            ...stale.state,
            authStatus: failure.authUsable ? "usable" : stale.state.authStatus,
            ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
          },
        };
      }
    } catch {
      // Cache I/O cannot replace the bounded current provider failure.
    }
  }

  return {
    provider: "devin",
    label: LABEL,
    source: "unavailable",
    windows: [],
    state: {
      status: failure.status,
      stale: false,
      error: failure.code,
      ...(failure.authUsable ? { authStatus: "usable" as const } : {}),
      ...(failure.definitiveAuth ? { authStatus: "unusable" as const } : {}),
      ...(failure.status === "auth_required"
        ? { remedyCommand: SIGN_IN_REMEDY }
        : {}),
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: attempts.map(({ source }) => source),
    },
    attempts,
  };
}

function retireMatchingCache(
  contextId: string,
  dependencies: DevinDependencies,
): void {
  try {
    if (dependencies.readCachedProvider(contextId)) {
      dependencies.deleteCachedProvider("devin");
    }
  } catch {
    // The current auth failure is still definitive even if the cache is not writable.
  }
}

function failureFromTransient(
  error: string | undefined,
  retryAfter: string | undefined,
): DevinFailure {
  const code = error ?? "provider_unavailable";
  const httpFailure =
    code === "provider_request_rejected" ||
    code === "provider_unavailable" ||
    code === "provider_timeout" ||
    code === "provider_rate_limited";
  return new DevinFailure(code, {
    staleEligible: true,
    ...(httpFailure ? { authUsable: true } : {}),
    ...(code === "provider_rate_limited"
      ? { status: "rate_limited" as const }
      : {}),
    ...(retryAfter ? { retryAfter } : {}),
  });
}

async function requestUserStatus(
  credential: DevinResolvedCredential,
  signal: AbortSignal,
  dependencies: DevinDependencies,
): Promise<unknown> {
  const url = new URL(DEVIN_USER_STATUS_PATH, credential.origin).href;
  const body = JSON.stringify({
    metadata: {
      apiKey: credential.token,
      ideName: "quota-axi",
      ideVersion: VERSION,
      extensionName: "quota-axi",
      extensionVersion: VERSION,
    },
  });
  let response: Response;
  try {
    response = await waitForDeadline(
      dependencies.fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "user-agent": USER_AGENT,
        },
        body,
        credentials: "omit",
        redirect: "manual",
        signal,
      }),
      signal,
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new DevinFailure("request_timeout", { staleEligible: true });
    }
    throw new DevinFailure(localTransportCode(error), { staleEligible: true });
  }

  const lifetime = createResponseBodyLifetime(response);
  try {
    rejectHttpFailure(response, dependencies.now());
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, signal, lifetime);
      lifetime.markConsumed();
    } catch (error) {
      if (error instanceof DevinFailure) throw error;
      if (signal.aborted || isAbortError(error)) {
        throw new DevinFailure("request_timeout", { staleEligible: true });
      }
      throw new DevinFailure("network_unavailable", { staleEligible: true });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DevinFailure("response_invalid_utf8", { staleEligible: true });
    }
    let payload: unknown;
    try {
      payload = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      throw new DevinFailure("malformed_json", { staleEligible: true });
    }
    return payload;
  } finally {
    void lifetime.cancel();
  }
}

function rejectHttpFailure(response: Response, receivedAt: number): void {
  const status = response.status;
  if (status === 200) return;
  if (status >= 300 && status <= 399) {
    throw new DevinFailure("redirect_rejected", { staleEligible: true });
  }
  if (status === 401 || status === 403) {
    throw new DevinFailure("provider_auth_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (status === 408) {
    throw new DevinFailure("provider_timeout", {
      authUsable: true,
      staleEligible: true,
    });
  }
  if (status === 429) {
    throw new DevinFailure("provider_rate_limited", {
      status: "rate_limited",
      authUsable: true,
      staleEligible: true,
      retryAfter: retryAfterToIso(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  }
  if (status >= 500 && status <= 599) {
    throw new DevinFailure("provider_unavailable", {
      authUsable: true,
      staleEligible: true,
    });
  }
  throw new DevinFailure("provider_request_rejected", {
    authUsable: true,
    staleEligible: true,
  });
}

/**
 * Normalize a Connect-JSON `GetUserStatus` body.
 *
 * Quota windows are published only for `BILLING_STRATEGY_QUOTA`. The daily
 * window reuses the existing `session` kind (id `daily`, label `day`) so the
 * published window-kind enum stays unchanged; `windowSeconds` carries the
 * vendor's 86,400s day. `hideDailyQuota: true` omits that window, because Max
 * has no daily cap; a missing flag leaves the daily cap unresolved rather than
 * allowing a potentially unenforced figure to bind included quota.
 * Every other expected window whose figure is missing or belongs to a finished
 * cycle is named as untrusted, and a body carrying quota fields without a
 * billing strategy, or with no usable expected window, is `schema_incomplete`.
 *
 * Remaining percents are the vendor's own `*_quota_remaining_percent`. Proto3
 * JSON omits zero-valued scalars, so a missing percent whose reset is present
 * is 0 remaining.
 */
export function normalizeDevinPayload(
  payload: unknown,
  now: number,
): NormalizedDevinPayload {
  const root = objectValue(payload);
  const userStatus = objectValue(root?.userStatus);
  if (!root || !userStatus) {
    throw new DevinFailure("schema_invalid", { staleEligible: true });
  }
  if (
    Object.hasOwn(root, "planInfo") &&
    root.planInfo !== undefined &&
    !objectValue(root.planInfo)
  ) {
    throw new DevinFailure("schema_invalid", { staleEligible: true });
  }
  const planInfo = objectValue(root.planInfo);
  if (
    planInfo &&
    Object.hasOwn(planInfo, "billingStrategy") &&
    planInfo.billingStrategy !== undefined &&
    typeof planInfo.billingStrategy !== "string"
  ) {
    throw new DevinFailure("schema_invalid", { staleEligible: true });
  }
  if (
    planInfo &&
    Object.hasOwn(planInfo, "hideDailyQuota") &&
    planInfo.hideDailyQuota !== undefined &&
    typeof planInfo.hideDailyQuota !== "boolean"
  ) {
    throw new DevinFailure("schema_invalid", { staleEligible: true });
  }
  const planStatus = objectValue(userStatus.planStatus);
  if (
    Object.hasOwn(userStatus, "planStatus") &&
    userStatus.planStatus !== undefined &&
    !planStatus
  ) {
    throw new DevinFailure("schema_invalid", { staleEligible: true });
  }

  const plan = nonemptyString(userStatus.teamsTier);
  const email = nonemptyString(userStatus.email);
  const accountId = nonemptyString(userStatus.userId);
  const account =
    email || accountId
      ? {
          ...(email ? { email } : {}),
          ...(accountId ? { accountId } : {}),
        }
      : undefined;
  const credits = planStatus ? creditsFromMicros(planStatus) : undefined;
  const untrustedWindowIds: string[] = [];
  const windows: QuotaWindow[] = [];
  const quotaFields =
    planStatus !== undefined &&
    QUOTA_FIELDS.some((key) => Object.hasOwn(planStatus, key));
  if (quotaFields && planInfo?.billingStrategy === undefined) {
    throw new DevinFailure("schema_incomplete", { staleEligible: true });
  }
  if (quotaFields && planInfo?.billingStrategy === QUOTA_BILLING) {
    const expected: [string, QuotaWindow | undefined][] = [
      [
        "weekly",
        normalizeQuotaWindow(
          planStatus,
          "weekly",
          "week",
          "weekly",
          WEEK_SECONDS,
          "weeklyQuotaRemainingPercent",
          "weeklyQuotaResetAtUnix",
          now,
        ),
      ],
    ];
    if (planInfo.hideDailyQuota === false) {
      expected.push([
        "daily",
        normalizeQuotaWindow(
          planStatus,
          "daily",
          "day",
          "session",
          DAY_SECONDS,
          "dailyQuotaRemainingPercent",
          "dailyQuotaResetAtUnix",
          now,
        ),
      ]);
    } else if (planInfo.hideDailyQuota !== true) {
      // A missing flag cannot distinguish an enforced daily cap from a Max
      // plan's vestigial, unenforced daily figure. Neither value may bind.
      untrustedWindowIds.push("daily");
    }
    for (const [id, window] of expected) {
      if (window) windows.push(window);
      if (window?.percentRemaining === undefined) untrustedWindowIds.push(id);
    }
    if (windows.length === 0) {
      throw new DevinFailure("schema_incomplete", { staleEligible: true });
    }
  }

  return {
    ...(plan ? { plan } : {}),
    ...(account ? { account } : {}),
    windows,
    ...(credits ? { credits } : {}),
    untrustedWindowIds,
  };
}

function normalizeQuotaWindow(
  planStatus: Record<string, unknown>,
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  windowSeconds: number,
  percentKey: string,
  resetKey: string,
  now: number,
): QuotaWindow | undefined {
  const hasPercent = Object.hasOwn(planStatus, percentKey);
  const hasReset = Object.hasOwn(planStatus, resetKey);
  if (!hasPercent && !hasReset) return undefined;

  const percent = hasPercent
    ? integerPercent(planStatus[percentKey])
    : undefined;
  const resetsAt = hasReset
    ? parseUnixSeconds(planStatus[resetKey])
    : undefined;
  // A reset the vendor says has already passed belongs to a finished cycle.
  if (resetsAt && Date.parse(resetsAt) <= now) return undefined;
  if (hasPercent && percent === undefined) {
    return windowWithoutPercent(id, label, kind, windowSeconds, resetsAt);
  }
  if (!hasPercent && !resetsAt) return undefined;
  const percentRemaining = percent ?? 0;
  const startsAt = resetsAt
    ? new Date(Date.parse(resetsAt) - windowSeconds * 1000).toISOString()
    : undefined;
  return {
    id,
    label,
    kind,
    percentRemaining,
    percentUsed: 100 - percentRemaining,
    windowSeconds,
    ...(startsAt ? { startsAt } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function windowWithoutPercent(
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  windowSeconds: number,
  resetsAt: string | undefined,
): QuotaWindow {
  const startsAt = resetsAt
    ? new Date(Date.parse(resetsAt) - windowSeconds * 1000).toISOString()
    : undefined;
  return {
    id,
    label,
    kind,
    windowSeconds,
    ...(startsAt ? { startsAt } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function creditsFromMicros(
  planStatus: Record<string, unknown>,
): NormalizedDevinPayload["credits"] | undefined {
  if (!Object.hasOwn(planStatus, "overageBalanceMicros")) return undefined;
  const micros = integerValue(planStatus.overageBalanceMicros);
  if (micros === undefined || micros < 0) return undefined;
  return { remaining: micros / 1_000_000, unit: "usd" };
}

function resolutionFromFields(fields: CredentialFields): DevinLocalResolution {
  const token = usableDevinCredential(fields.windsurf_api_key);
  if (!token) {
    return {
      status: "structurally_invalid",
      error: "devin_credential_invalid",
    };
  }
  const origin = classifyOrigin(fields.api_server_url);
  if (origin.status === "invalid") {
    return { status: "structurally_invalid", error: "devin_server_invalid" };
  }
  if (origin.status === "unsupported") {
    return { status: "unsupported", error: "unsupported_server" };
  }
  return { status: "resolved", credential: { token, origin: origin.origin } };
}

function classifyOrigin(
  value: string | undefined,
):
  | { status: "default" | "allowed"; origin: string }
  | { status: "invalid" }
  | { status: "unsupported" } {
  if (value === undefined)
    return { status: "default", origin: DEVIN_API_ORIGIN };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { status: "invalid" };
  }
  if (
    url.username ||
    url.password ||
    url.protocol !== "https:" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    (url.port !== "" && url.port !== "443") ||
    url.hostname !== "server.codeium.com"
  ) {
    return { status: "unsupported" };
  }
  return { status: "allowed", origin: DEVIN_API_ORIGIN };
}

function inspectResolution(
  resolution: DevinLocalResolution,
  path: string | undefined,
): ReturnType<DevinCredentialSource["inspect"]> {
  const located = path ? { path } : {};
  if (resolution.status === "resolved")
    return { status: "available", ...located };
  if (resolution.status === "absent") return { status: "missing", ...located };
  if (resolution.status === "unsupported") {
    return {
      status: "skipped",
      error: resolution.error,
      credentialPresent: true,
      ...located,
    };
  }
  if (resolution.status === "structurally_invalid") {
    return {
      status: "invalid",
      error: resolution.error,
      credentialPresent: true,
      ...located,
    };
  }
  return { status: "error", error: resolution.error, ...located };
}

/**
 * A deliberately narrow TOML reader for the flat credentials file. It keeps
 * only top-level `windsurf_api_key` and `api_server_url`. Other lines and
 * sections are ignored; malformed or duplicate needed values fail closed.
 */
export function parseDevinCredentialsToml(
  text: string,
): CredentialFields | undefined {
  const fields: CredentialFields = {};
  const seen = new Set<string>();
  let inSection = false;
  let index = 0;
  if (text.charCodeAt(0) === 0xfeff) index = 1;
  const source = text;

  const atEnd = (): boolean => index >= source.length;
  const skipIgnorable = (): void => {
    while (!atEnd()) {
      const char = source[index];
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        index += 1;
      } else if (char === "#") {
        while (!atEnd() && source[index] !== "\n") index += 1;
      } else {
        return;
      }
    }
  };

  try {
    while (true) {
      skipIgnorable();
      if (atEnd()) return fields;
      const lineEnd = source.indexOf("\n", index);
      const line = source.slice(index, lineEnd < 0 ? undefined : lineEnd);
      if (line.startsWith("[")) inSection = true;
      const key = line.match(/^([A-Za-z0-9_-]+)[ \t]*=/)?.[1];
      if (inSection || !key || !CREDENTIAL_KEYS.has(key)) {
        index = lineEnd < 0 ? source.length : lineEnd + 1;
        continue;
      }
      readKey();
      skipInline();
      if (source[index] !== "=") return undefined;
      index += 1;
      skipInline();
      const value = readString();
      if (value === undefined) return undefined;
      skipInline();
      if (!atEnd() && source[index] === "#") {
        while (!atEnd() && source[index] !== "\n") index += 1;
      }
      if (!atEnd() && source[index] !== "\n" && source[index] !== "\r") {
        return undefined;
      }
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (key === "windsurf_api_key") fields.windsurf_api_key = value;
      if (key === "api_server_url") fields.api_server_url = value;
    }
  } catch {
    return undefined;
  }

  function readKey(): string {
    const start = index;
    while (!atEnd() && /[A-Za-z0-9_-]/.test(source[index])) index += 1;
    if (index === start) throw new Error("key");
    return source.slice(start, index);
  }

  function skipInline(): void {
    while (!atEnd() && (source[index] === " " || source[index] === "\t")) {
      index += 1;
    }
  }

  function readString(): string | undefined {
    const quote = source[index];
    if (quote !== '"' && quote !== "'") return undefined;
    index += 1;
    if (quote === "'") {
      const start = index;
      while (!atEnd() && source[index] !== "'") index += 1;
      if (atEnd()) return undefined;
      const value = source.slice(start, index);
      index += 1;
      return value;
    }
    let value = "";
    while (!atEnd()) {
      const char = source[index];
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char === "\n" || char === "\r") return undefined;
      if (char === "\\") {
        index += 1;
        const escaped = source[index];
        if (escaped === "\\") value += "\\";
        else if (escaped === '"') value += '"';
        else if (escaped === "n") value += "\n";
        else if (escaped === "t") value += "\t";
        else if (escaped === "r") value += "\r";
        else return undefined;
        index += 1;
        continue;
      }
      value += char;
      index += 1;
    }
    return undefined;
  }
}

function integerPercent(value: unknown): number | undefined {
  const number = integerValue(value);
  if (number === undefined || number < 0 || number > 100) return undefined;
  return number;
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

function parseUnixSeconds(value: unknown): string | undefined {
  const seconds = integerValue(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const ms = seconds * 1000;
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  lifetime: ResponseBodyLifetime,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(RESPONSE_LIMIT_BYTES)) {
      throw new DevinFailure("response_too_large", { staleEligible: true });
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readBodyChunk(reader, signal, lifetime);
      if (done) break;
      length += value.length;
      if (length > RESPONSE_LIMIT_BYTES) {
        throw new DevinFailure("response_too_large", { staleEligible: true });
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
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const cancelReader = () => lifetime.cancel(() => reader.cancel());
  if (signal.aborted) {
    void cancelReader();
    throw new DevinFailure("request_timeout", { staleEligible: true });
  }
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      void cancelReader();
      reject(new DevinFailure("request_timeout", { staleEligible: true }));
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
    cancel(action = () => response.body?.cancel()) {
      if (consumed) return Promise.resolve();
      cancellation ??= (async () => {
        try {
          await action();
        } catch {
          // Cancellation only releases the connection; the read already failed.
        }
      })();
      return cancellation;
    },
  };
}

function waitForDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new DevinFailure("request_timeout", { staleEligible: true }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new DevinFailure("request_timeout", { staleEligible: true }));
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

function asDevinFailure(error: unknown): DevinFailure {
  return error instanceof DevinFailure
    ? error
    : new DevinFailure("credential_resolution_failed");
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

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class DevinFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly authUsable: boolean;
  readonly retryAfter?: string;

  constructor(code: string, options: DevinFailureOptions = {}) {
    super(code);
    this.name = "DevinFailure";
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible === true;
    this.definitiveAuth = options.definitiveAuth === true;
    this.authUsable = options.authUsable === true;
    this.retryAfter = options.retryAfter;
  }
}
