/**
 * MiniMax (minimax) provider adapter.
 *
 * MiniMax's Coding Plan remains endpoint reports the vendor's current
 * time- or count-metered allowance. The adapter publishes only its supplied
 * percentages and counter-derived values; it never calls inference.
 *
 * It honours the smallest opt-in surface agreed in the package:
 *  - `$MINIMAX_API_KEY` first (explicit caller intent).
 *  - opencode `auth.json` `minimax`, `MiniMax`, or `minimax-coding-plan`.
 *  - Pi's `$PI_CODING_AGENT_DIR/auth.json` under those same ids.
 *
 * Nothing else is read or written. The adapter never refreshes credentials,
 * never calls inference, and never derives a quota percentage from model
 * presence.
 */

import { providerFetch } from "../lib/http.js";
import { readBoundedResponseText } from "../lib/bounded-response.js";
import { selectCredential } from "./credential-selection.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { parseEpochOrIso } from "../lib/time.js";
import { withUsageFetchFailure } from "./usage-fetch-failure.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";

const LABEL = "MiniMax";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const MINIMAX_HOST = "api.minimax.io";
const MINIMAX_PROBE_PATH = "/v1/api/openplatform/coding_plan/remains";

const MINIMAX_PROVIDER_IDS = ["minimax", "MiniMax", "minimax-coding-plan"];
const MINIMAX_CREDENTIAL_KEYS = [
  "key",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "auth_token",
];

const ENV_MINIMAX_API_KEY = "MINIMAX_API_KEY";
const OPENCODE_AUTH_SOURCE = "opencode:auth.json";
const PI_MINIMAX_SOURCE = "pi:minimax";

export type MinimaxCredentialResolution =
  | { status: "available"; apiKey: string; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export type MinimaxCredentialInspection =
  | { status: "available"; path: string }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "error"; path: string; error: string };

export function opencodeAuthFilePath(): string {
  const xdg = stringValue(process.env.XDG_DATA_HOME);
  if (xdg) return join(xdg, "opencode", "auth.json");
  if (process.platform === "win32") {
    const localAppData = stringValue(process.env.LOCALAPPDATA);
    if (localAppData) return join(localAppData, "opencode", "auth.json");
  }
  return join(join(homedir(), ".local", "share"), "opencode", "auth.json");
}

export function extractMinimaxCredential(
  value: unknown,
  path: string,
): MinimaxCredentialResolution {
  const data = objectValue(value);
  if (!data) return { status: "invalid", path, error: "json_parse_error" };
  let presentEntry = false;
  for (const providerId of MINIMAX_PROVIDER_IDS) {
    const entry = data[providerId];
    if (entry === undefined || entry === null) continue;
    presentEntry = true;
    const key = extractCredentialKey(entry);
    if (key) return { status: "available", apiKey: key, path };
  }
  if (presentEntry)
    return { status: "invalid", path, error: "invalid_credential" };
  return { status: "missing", path };
}

function extractPiMinimaxCredential(
  value: unknown,
  path: string,
): MinimaxCredentialResolution {
  for (const providerId of MINIMAX_PROVIDER_IDS) {
    const classified = classifyPiAuthEntry(value, providerId);
    if (classified.status === "missing") continue;
    if (classified.status === "invalid") {
      return { status: "invalid", path, error: "pi_entry_invalid" };
    }
    const entry = classified.entry;
    const type = entryType(entry);
    if (type === "api_key") {
      const key = usableLiteralSecret(entry.key);
      if (key) return { status: "available", apiKey: key, path };
      return { status: "invalid", path, error: "invalid_credential" };
    }
    if (type === "oauth") {
      const token = usableLiteralSecret(entry.access);
      if (token) return { status: "available", apiKey: token, path };
      return { status: "invalid", path, error: "invalid_credential" };
    }
    return { status: "invalid", path, error: "unsupported_entry_type" };
  }
  return { status: "missing", path };
}

function entryType(entry: Record<string, unknown>): string | undefined {
  const raw = entry.type;
  return typeof raw === "string" && raw.trim()
    ? raw.trim().toLowerCase()
    : undefined;
}

function extractCredentialKey(entry: unknown): string | undefined {
  if (typeof entry === "string") return usableLiteralSecret(entry);
  if (!objectValue(entry)) return undefined;
  for (const key of MINIMAX_CREDENTIAL_KEYS) {
    const candidate = usableLiteralSecret(
      (entry as Record<string, unknown>)[key],
    );
    if (candidate) return candidate;
  }
  return undefined;
}

export type MinimaxCredentialSource = {
  name: string;
  path: () => string;
  extract: (value: unknown, path: string) => MinimaxCredentialResolution;
};

function resolveMinimaxCredentialSource(
  source: MinimaxCredentialSource,
): MinimaxCredentialResolution {
  const path = source.path();
  const result: JsonFileReadResult = readJsonFileResult(path);
  if (result.status === "missing") return { status: "missing", path };
  if (result.status === "invalid") {
    return result.error === "file_read_error"
      ? { status: "error", path, error: result.error }
      : { status: "invalid", path, error: result.error };
  }
  return source.extract(result.value, path);
}

function inspectMinimaxCredentialSource(
  source: MinimaxCredentialSource,
): MinimaxCredentialInspection {
  const resolution = resolveMinimaxCredentialSource(source);
  if (resolution.status === "available")
    return { status: "available", path: resolution.path };
  if (resolution.status === "missing")
    return { status: "missing", path: resolution.path };
  return resolution;
}

export function defaultMinimaxCredentialSources(): MinimaxCredentialSource[] {
  return [
    {
      name: OPENCODE_AUTH_SOURCE,
      path: opencodeAuthFilePath,
      extract: extractMinimaxCredential,
    },
    {
      name: PI_MINIMAX_SOURCE,
      path: resolvePiAuthFilePath,
      extract: extractPiMinimaxCredential,
    },
  ];
}

type MinimaxDependencies = {
  credentialSources: MinimaxCredentialSource[];
  envApiKey: () => string | undefined;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedMinimaxProbe = {
  accountLabel?: string;
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

export function createMinimaxAdapter(
  overrides: Partial<MinimaxDependencies> = {},
): ProviderAdapter {
  const dependencies: MinimaxDependencies = {
    credentialSources: defaultMinimaxCredentialSources(),
    envApiKey: () => process.env[ENV_MINIMAX_API_KEY],
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "minimax",
    label: LABEL,
    fetchQuota: (options: ProviderOptions) =>
      fetchQuotaWithDependencies(dependencies, options),
    inspectAuth: (_options: ProviderOptions) =>
      inspectAuthWithDependencies(dependencies),
  };
}

export const minimaxAdapter = createMinimaxAdapter();

async function fetchQuotaWithDependencies(
  dependencies: MinimaxDependencies,
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let credentialMissing = true;
  let definitiveAuth: string | undefined;
  let readError: string | undefined;
  let lastError: string | undefined;

  async function tryCredential(
    source: string,
    apiKey: string,
  ): Promise<ProviderQuota | undefined> {
    const selection = await selectCredential(
      [{ source, credential: apiKey, localState: "valid" }],
      async (candidate) => {
        try {
          return {
            kind: "quota",
            result: await probeMinimax(candidate.credential, dependencies),
          };
        } catch (error) {
          const code = errorCode(error);
          return {
            kind: code === "provider_auth_rejected" ? "rejected" : "transient",
            error: code,
          };
        }
      },
    );
    if (selection.outcome === "quota") {
      attempts.push({ source, status: "success" });
      return successMinimaxReport(selection.result!, attempts, dependencies);
    }
    const code = selection.transientError ?? selection.results[0]!.error!;
    attempts.push({ source, status: "failed", error: code });
    if (selection.outcome === "transient") {
      return failedMinimaxReport(attempts, code);
    }
    credentialMissing = false;
    definitiveAuth = preferDefinitiveAuth(definitiveAuth, code);
    lastError = code;
    return undefined;
  }

  const envKey = dependencies.envApiKey();
  if (envKey) {
    const report = await tryCredential(ENV_MINIMAX_API_KEY, envKey);
    if (report) return report;
  }

  for (const source of dependencies.credentialSources) {
    const resolution = resolveMinimaxCredentialSource(source);
    if (resolution.status !== "available") {
      attempts.push({
        source: source.name,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: credentialError(resolution),
        ...(resolution.status !== "missing" ? { credentialPresent: true } : {}),
      });
      if (resolution.status !== "missing") {
        credentialMissing = false;
        if (resolution.status === "error") {
          readError ??= credentialError(resolution);
        } else {
          definitiveAuth = preferDefinitiveAuth(
            definitiveAuth,
            credentialError(resolution),
          );
        }
      }
      lastError = credentialError(resolution);
      continue;
    }

    const report = await tryCredential(source.name, resolution.apiKey);
    if (report) return report;
  }

  if (attempts.length === 0) {
    attempts.push({
      source: ENV_MINIMAX_API_KEY,
      status: "skipped",
      error: "minimax_credential_unavailable",
    });
    lastError = "minimax_credential_unavailable";
  }

  return failedMinimaxReport(
    attempts,
    readError ?? definitiveAuth ?? lastError ?? "minimax_quota_failed",
    credentialMissing && !definitiveAuth,
  );
}

function preferDefinitiveAuth(
  current: string | undefined,
  next: string,
): string {
  if (!current) return next;
  if (current === "provider_auth_rejected") return current;
  if (next === "provider_auth_rejected") return next;
  return current;
}

async function probeMinimax(
  apiKey: string,
  dependencies: MinimaxDependencies,
): Promise<NormalizedMinimaxProbe> {
  const url = `https://${MINIMAX_HOST}${MINIMAX_PROBE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.deadlineMs);
  try {
    const response = await dependencies.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("provider_auth_rejected");
    }
    if (response.status === 429) throw new Error("provider_rate_limited");
    if (!response.ok) throw new Error("provider_request_rejected");
    const text = await readBoundedResponseText(response, RESPONSE_LIMIT_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("malformed_json");
    }
    const baseResponse = objectValue(objectValue(payload)?.base_resp);
    if (numericValue(baseResponse?.status_code) !== undefined) {
      const statusCode = numericValue(baseResponse?.status_code)!;
      if (statusCode !== 0) {
        throw new Error(
          statusCode === 1004
            ? "provider_auth_rejected"
            : "provider_request_rejected",
        );
      }
    }
    return normalizeMinimaxProbe(payload);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("provider_timeout", { cause: error });
    }
    if (
      error instanceof Error &&
      [
        "provider_auth_rejected",
        "provider_rate_limited",
        "provider_request_rejected",
        "response_too_large",
        "malformed_json",
        "provider_timeout",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("network_unavailable", { cause: error });
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

function normalizeMinimaxProbe(raw: unknown): NormalizedMinimaxProbe {
  const root = objectValue(raw);
  if (!root) return { windows: [], untrustedWindowIds: [] };
  const data = objectValue(root.data) ?? root;
  const label = firstString(data, ["label", "name", "username"]);
  const models = Array.isArray(data.model_remains) ? data.model_remains : [];
  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];

  for (const [index, candidate] of models.entries()) {
    const model = objectValue(candidate);
    if (!model) continue;
    const name = stringValue(model.model_name) ?? `${index + 1}`;
    const prefix = `model:${name}`;
    for (const period of [
      {
        id: "interval",
        label: "interval",
        kind: "session" as const,
        remainingPercent: "current_interval_remaining_percent",
        total: "current_interval_total_count",
        usage: "current_interval_usage_count",
        remaining: "current_interval_remain_count",
        resetsAt: ["end_time", "current_interval_end_time"],
        remainsTime: "remains_time",
      },
      {
        id: "weekly",
        label: "weekly",
        kind: "weekly" as const,
        remainingPercent: "current_weekly_remaining_percent",
        total: "current_weekly_total_count",
        usage: "current_weekly_usage_count",
        remaining: "current_weekly_remain_count",
        resetsAt: ["weekly_end_time"],
        remainsTime: "weekly_remains_time",
      },
    ]) {
      const id = `${prefix}:${period.id}`;
      const measurement = minimaxMeasurement(model, period);
      if (measurement === "invalid") {
        untrustedWindowIds.push(id);
        continue;
      }
      if (!measurement) continue;
      const resetsAt = parseEpochOrIso(
        period.resetsAt
          .map((field) => model[field])
          .find((value) => value != null),
      );
      const resetText = remainsText(model[period.remainsTime]);
      windows.push({
        id,
        label: `${name} ${period.label}`,
        kind: period.kind,
        ...measurement,
        ...(resetsAt ? { resetsAt } : {}),
        ...(resetText ? { resetText } : {}),
      });
    }
  }

  return {
    ...(label ? { accountLabel: label } : {}),
    windows,
    untrustedWindowIds,
  };
}

type MinimaxPeriod = {
  id: string;
  label: string;
  kind: "session" | "weekly";
  remainingPercent: string;
  total: string;
  usage: string;
  remaining: string;
  resetsAt: readonly string[];
  remainsTime: string;
};

function minimaxMeasurement(
  model: Record<string, unknown>,
  period: MinimaxPeriod,
):
  | Pick<QuotaWindow, "percentUsed" | "percentRemaining">
  | "invalid"
  | undefined {
  const remainingPercent = numericValue(model[period.remainingPercent]);
  const total = numericValue(model[period.total]);
  const usage = numericValue(model[period.usage]);
  const remaining = numericValue(model[period.remaining]);
  if (
    total !== undefined &&
    total > 0 &&
    ((usage !== undefined && (usage < 0 || usage > total)) ||
      (remaining !== undefined && (remaining < 0 || remaining > total)) ||
      (usage !== undefined &&
        remaining !== undefined &&
        usage + remaining !== total))
  )
    return "invalid";

  if (remainingPercent !== undefined) {
    if (remainingPercent < 0 || remainingPercent > 100) return "invalid";
    return {
      percentUsed: 100 - remainingPercent,
      percentRemaining: remainingPercent,
    };
  }
  if (total === undefined && usage === undefined && remaining === undefined)
    return undefined;
  if (
    total === undefined ||
    total <= 0 ||
    (usage === undefined && remaining === undefined)
  )
    return "invalid";

  const percentUsed = ((usage ?? total - remaining!) / total) * 100;
  return { percentUsed, percentRemaining: 100 - percentUsed };
}

function remainsText(value: unknown): string | undefined {
  const milliseconds = numericValue(value);
  if (milliseconds === undefined || milliseconds < 0) return undefined;
  const totalMinutes = Math.floor(milliseconds / (60 * 1000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    ...(days > 0 ? [`${days}d`] : []),
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
  ];
  return `${parts.length > 0 ? parts.join(" ") : "0m"} remaining`;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function successMinimaxReport(
  probe: NormalizedMinimaxProbe,
  attempts: SourceAttempt[],
  dependencies: MinimaxDependencies,
): ProviderQuota {
  const base = successProvider({
    provider: "minimax",
    label: LABEL,
    source: "api",
    ...(probe.accountLabel ? { plan: probe.accountLabel } : {}),
    windows: probe.windows,
    refreshedAt: new Date(dependencies.now()).toISOString(),
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  return {
    ...base,
    state: {
      ...base.state,
      authStatus: "usable",
      ...(probe.untrustedWindowIds.length > 0
        ? { untrustedWindowIds: probe.untrustedWindowIds }
        : {}),
    },
  };
}

function failedMinimaxReport(
  attempts: SourceAttempt[],
  error: string,
  credentialMissing = false,
): ProviderQuota {
  const status = credentialMissing ? "auth_required" : statusFromError(error);
  const report = failedProvider({
    provider: "minimax",
    label: LABEL,
    status,
    error,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  if (status === "auth_required") return report;
  return withUsageFetchFailure(report);
}

function inspectAuthWithDependencies(
  dependencies: MinimaxDependencies,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = [];
  const envKey = dependencies.envApiKey();
  sources.push({
    source: ENV_MINIMAX_API_KEY,
    status: envKey ? "available" : "missing",
  });
  for (const source of dependencies.credentialSources) {
    const inspection = inspectMinimaxCredentialSource(source);
    sources.push({
      source: source.name,
      path: inspection.path,
      status: inspection.status,
      ...(inspection.status === "invalid" || inspection.status === "error"
        ? { error: inspection.error }
        : {}),
    });
  }
  return Promise.resolve({ provider: "minimax", sources });
}

function credentialError(
  resolution: Exclude<MinimaxCredentialResolution, { status: "available" }>,
): string {
  switch (resolution.status) {
    case "missing":
      return "minimax_credential_unavailable";
    case "invalid":
      return `minimax_credential_invalid: ${resolution.error}`;
    case "error":
      return `credential_resolution_failed: ${resolution.error}`;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "minimax_quota_failed";
}

function statusFromError(error: string) {
  if (
    error === "keychain_prompt_required" ||
    error === "credentials_expired" ||
    error === "provider_auth_rejected" ||
    error.startsWith("minimax_credential_invalid") ||
    /sign-in|required|reauth|access token expired/i.test(error)
  )
    return "auth_required";
  if (/rate.?limit/i.test(error)) return "rate_limited";
  return "error";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return keys
    .map((key) => {
      const raw = value[key];
      return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    })
    .find((entry): entry is string => entry !== undefined);
}
