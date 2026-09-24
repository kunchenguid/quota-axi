import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { collapseHome, readBoundedFile } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { listRunningCommandLines } from "../lib/running-processes.js";
import { usableLiteralSecret } from "../lib/secret.js";
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
  selectCredential,
  type AttemptOutcome,
  type CredentialCandidate,
  type CredentialSelection,
} from "./credential-selection.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

export const MUSE_API_URL = "https://api.meta.ai/v1/responses";
export const MUSE_API_KEY_SOURCE = "env:META_API_KEY";
export const MUSE_AUTH_FILE_SOURCE = "muse:auth.json";
export const MUSE_INFERENCE_OPT_IN_ERROR = "muse_inference_opt_in_required";
export const MUSE_INFERENCE_REMEDY_COMMAND =
  "quota-axi --provider muse-code --allow-muse-inference";

export const MUSE_SOURCE_ORDER = [
  MUSE_API_KEY_SOURCE,
  MUSE_AUTH_FILE_SOURCE,
] as const;

const DEFAULT_MODEL = "muse-spark-1.3";
const LABEL = "Muse Code";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 65_536;
const AUTH_FILE_LIMIT_BYTES = 65_536;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const AUTH_FILE_KEYS: Readonly<Record<string, true>> = {
  providers: true,
  meta: true,
  api_key: true,
};

const RESPONSE_KEYS: Readonly<Record<string, true>> = {
  subscription: true,
  window: true,
  weekly: true,
  used_percent: true,
  resets_at: true,
  window_duration_mins: true,
};

const JS_RUNTIMES: Readonly<Record<string, true>> = {
  bun: true,
  deno: true,
  node: true,
};

type MuseSourceName = (typeof MUSE_SOURCE_ORDER)[number];

type MuseLocalResolution =
  | { status: "resolved"; key: string; source: MuseSourceName; path?: string }
  | { status: "absent"; source: MuseSourceName; path?: string }
  | {
      status: "structurally_invalid" | "read_error";
      source: MuseSourceName;
      path?: string;
      error: string;
    };

type MuseCredentialSource = {
  name: MuseSourceName;
  location(): string | undefined;
  resolve(): Promise<MuseLocalResolution>;
};

type NamedMuseCredentialSource = {
  name: MuseSourceName;
  source: MuseCredentialSource;
};

type MuseDependencies = {
  sources: readonly NamedMuseCredentialSource[];
  fetch: typeof globalThis.fetch;
  listRunningCommandLines: typeof listRunningCommandLines;
  now: () => number;
  deadlineMs: number;
};

type ResolvedMuseSource = {
  name: MuseSourceName;
  resolution: MuseLocalResolution;
};

type MuseSubscription = {
  window?: Record<string, unknown>;
  weekly?: Record<string, unknown>;
};

type NormalizedMusePayload = {
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

type MuseFailureOptions = {
  retryAfter?: string;
  definitiveAuth?: boolean;
};

class MuseFailure extends Error {
  readonly code: string;
  readonly retryAfter?: string;
  readonly definitiveAuth: boolean;

  constructor(code: string, options: MuseFailureOptions = {}) {
    super(code);
    this.name = "MuseFailure";
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.definitiveAuth = options.definitiveAuth ?? false;
  }
}

export function museAuthFilePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = environment.MUSE_AUTH_PATH?.trim();
  if (override) return override;
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  return isAbsolute(xdg ?? "")
    ? join(xdg!, "muse", "auth.json")
    : join(homedir(), ".config", "muse", "auth.json");
}

export function createMuseApiKeySource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MuseCredentialSource {
  return {
    name: MUSE_API_KEY_SOURCE,
    location: () => "META_API_KEY",
    async resolve() {
      const raw = environment.META_API_KEY;
      if (raw === undefined || raw.trim().length === 0)
        return { status: "absent", source: MUSE_API_KEY_SOURCE };
      const key = literalMuseKey(raw);
      return key
        ? { status: "resolved", key, source: MUSE_API_KEY_SOURCE }
        : {
            status: "structurally_invalid",
            source: MUSE_API_KEY_SOURCE,
            error: "meta_api_key_invalid",
          };
    },
  };
}

export function createMuseAuthFileSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (
    path: string,
    maxBytes: number,
  ) => Promise<Buffer> = readBoundedFile,
): MuseCredentialSource {
  const path = () => museAuthFilePath(environment);
  return {
    name: MUSE_AUTH_FILE_SOURCE,
    location: () => collapseHome(path()),
    async resolve() {
      const filePath = path();
      let fileMode: number;
      try {
        const info = statSync(filePath);
        if (!info.isFile())
          return {
            status: "structurally_invalid",
            source: MUSE_AUTH_FILE_SOURCE,
            path: filePath,
            error: "muse_auth_file_invalid",
          };
        fileMode = info.mode;
      } catch (error) {
        return systemErrorCode(error) === "ENOENT"
          ? { status: "absent", source: MUSE_AUTH_FILE_SOURCE, path: filePath }
          : {
              status: "read_error",
              source: MUSE_AUTH_FILE_SOURCE,
              path: filePath,
              error: "muse_auth_read_error",
            };
      }
      if (process.platform !== "win32" && (fileMode & 0o077) !== 0) {
        return {
          status: "structurally_invalid",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
          error: "muse_auth_file_permissions_unsafe",
        };
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(filePath, AUTH_FILE_LIMIT_BYTES);
      } catch (error) {
        return systemErrorCode(error) === "ENOENT"
          ? { status: "absent", source: MUSE_AUTH_FILE_SOURCE, path: filePath }
          : {
              status: "read_error",
              source: MUSE_AUTH_FILE_SOURCE,
              path: filePath,
              error: "muse_auth_read_error",
            };
      }
      if (bytes.byteLength > AUTH_FILE_LIMIT_BYTES) {
        return {
          status: "structurally_invalid",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
          error: "muse_auth_file_too_large",
        };
      }

      let root: unknown;
      try {
        root = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          museAuthFileReviver,
        );
      } catch {
        return {
          status: "structurally_invalid",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
          error: "muse_auth_file_invalid",
        };
      }
      const store = objectValue(root);
      if (!store)
        return {
          status: "structurally_invalid",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
          error: "muse_auth_file_invalid",
        };
      if (!Object.hasOwn(store, "providers"))
        return {
          status: "absent",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
        };
      const providers = objectValue(store.providers);
      if (!providers)
        return {
          status: "structurally_invalid",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
          error: "muse_auth_providers_invalid",
        };
      if (!Object.hasOwn(providers, "meta"))
        return {
          status: "absent",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
        };
      const meta = objectValue(providers.meta);
      if (!meta)
        return {
          status: "structurally_invalid",
          source: MUSE_AUTH_FILE_SOURCE,
          path: filePath,
          error: "muse_meta_entry_invalid",
        };
      const key = literalMuseKey(meta.api_key);
      return key
        ? {
            status: "resolved",
            key,
            source: MUSE_AUTH_FILE_SOURCE,
            path: filePath,
          }
        : {
            status: "structurally_invalid",
            source: MUSE_AUTH_FILE_SOURCE,
            path: filePath,
            error: "muse_api_key_invalid",
          };
    },
  };
}

export function defaultMuseCredentialSources(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NamedMuseCredentialSource[] {
  return [
    {
      name: MUSE_API_KEY_SOURCE,
      source: createMuseApiKeySource(environment),
    },
    {
      name: MUSE_AUTH_FILE_SOURCE,
      source: createMuseAuthFileSource(environment),
    },
  ];
}

export function createMuseAdapter(
  overrides: Partial<MuseDependencies> = {},
): ProviderAdapter {
  const dependencies: MuseDependencies = {
    sources: defaultMuseCredentialSources(),
    fetch: providerFetch,
    listRunningCommandLines,
    now: Date.now,
    deadlineMs: REQUEST_TIMEOUT_MS,
    ...overrides,
  };

  return {
    id: "muse-code",
    label: LABEL,
    fetchQuota: (options) => fetchQuota(dependencies, options),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const museAdapter = createMuseAdapter();

async function inspectAuth(
  dependencies: MuseDependencies,
): Promise<AuthProviderReport> {
  const resolved = await resolveSources(dependencies.sources);
  return {
    provider: "muse-code",
    sources: resolved.map(({ name, resolution }) => ({
      source: name,
      ...(resolution.path ? { path: collapseHome(resolution.path) } : {}),
      status: authStatusForResolution(resolution),
      ...(resolution.status === "structurally_invalid" ||
      resolution.status === "read_error"
        ? {
            error: resolution.error,
            ...(resolution.status === "structurally_invalid"
              ? { credentialPresent: true }
              : {}),
          }
        : {}),
    })),
  };
}

async function fetchQuota(
  dependencies: MuseDependencies,
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const resolved = await resolveSources(dependencies.sources);
  const candidates = resolved.flatMap(({ name, resolution }) =>
    resolution.status === "resolved"
      ? [
          {
            source: name,
            localState: "valid" as const,
            credential: resolution.key,
          },
        ]
      : [],
  );
  if (candidates.length === 0) return localFailureReport(resolved);

  if (!options.allowMuseInference) {
    return failedMuseReport(
      "unavailable",
      MUSE_INFERENCE_OPT_IN_ERROR,
      attemptsForSources(resolved, undefined, MUSE_INFERENCE_OPT_IN_ERROR),
    );
  }

  const processBlocker = await museProcessBlocker(dependencies);
  if (processBlocker) {
    return failedMuseReport(
      "unavailable",
      processBlocker,
      attemptsForSources(resolved, undefined, processBlocker),
    );
  }

  const selection = await selectCredential(candidates, (candidate) =>
    attemptMuseCredential(candidate, dependencies),
  );
  const attempts = attemptsForSources(resolved, selection);
  if (selection.outcome === "quota" && selection.result) {
    const report = successProvider({
      provider: "muse-code",
      label: LABEL,
      source: "api",
      windows: selection.result.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    return {
      ...report,
      state: {
        ...report.state,
        authStatus: "usable",
        ...(selection.result.untrustedWindowIds.length > 0
          ? { untrustedWindowIds: selection.result.untrustedWindowIds }
          : {}),
      },
    };
  }

  if (selection.outcome === "transient") {
    const code = selection.transientError ?? "muse_request_failed";
    const status = code === "provider_rate_limited" ? "rate_limited" : "error";
    return failedMuseReport(
      status,
      code,
      attempts,
      selection.retryAfter,
      code === "muse_subscription_missing",
    );
  }

  const localError = resolved.find(
    ({ resolution }) =>
      resolution.status === "structurally_invalid" ||
      resolution.status === "read_error",
  );
  if (localError) {
    const resolution = localError.resolution;
    return failedMuseReport(
      "error",
      resolution.status === "structurally_invalid" ||
        resolution.status === "read_error"
        ? resolution.error
        : "muse_credential_invalid",
      attempts,
    );
  }

  return failedMuseReport("auth_required", "provider_auth_rejected", attempts);
}

async function resolveSources(
  sources: readonly NamedMuseCredentialSource[],
): Promise<ResolvedMuseSource[]> {
  const resolved: ResolvedMuseSource[] = [];
  for (const { name, source } of sources) {
    let resolution: MuseLocalResolution;
    try {
      resolution = await source.resolve();
    } catch {
      resolution = {
        status: "read_error",
        source: name,
        error: "credential_resolution_failed",
      };
    }
    resolved.push({ name, resolution });
  }
  return resolved;
}

function attemptsForSources(
  resolved: readonly ResolvedMuseSource[],
  selection?: CredentialSelection<NormalizedMusePayload>,
  skippedError?: string,
): SourceAttempt[] {
  return resolved.map(({ name, resolution }) => {
    if (resolution.status === "absent")
      return { source: name, status: "skipped" };
    if (resolution.status === "structurally_invalid")
      return {
        source: name,
        status: "failed",
        error: resolution.error,
        credentialPresent: true,
      };
    if (resolution.status === "read_error")
      return { source: name, status: "failed", error: resolution.error };

    const result = selection?.results.find(
      (candidate) => candidate.source === name,
    );
    if (!selection || result?.outcome === "not_tried" || !result) {
      return {
        source: name,
        status: "skipped",
        ...(skippedError ? { error: skippedError } : {}),
        credentialPresent: true,
        degraded: false,
      };
    }
    if (result.outcome === "quota") return { source: name, status: "success" };
    if (result.outcome === "live_no_quota")
      return { source: name, status: "skipped", credentialPresent: true };
    return {
      source: name,
      status: "failed",
      error: result.error ?? "muse_request_failed",
      credentialPresent: true,
    };
  });
}

async function museProcessBlocker(
  dependencies: MuseDependencies,
): Promise<string | undefined> {
  let processes;
  try {
    processes = await dependencies.listRunningCommandLines();
  } catch {
    return "muse_process_state_unavailable";
  }
  if (processes.status !== "listed") return "muse_process_state_unavailable";
  return processes.processes.some(
    ({ pid, commandLine }) =>
      pid !== process.pid && isMuseCliCommandLine(commandLine),
  )
    ? "muse_cli_running"
    : undefined;
}

function isMuseCliCommandLine(commandLine: string): boolean {
  const line = commandLine.trim();
  if (!line || line.includes(".app/Contents/") || line.includes("--type="))
    return false;
  const tokens = line.split(/\s+/u);
  const executable = executableBase(tokens[0] ?? "");
  if (executable === "muse") return true;
  if (JS_RUNTIMES[executable] !== true) return false;
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) continue;
    if (!token.includes("/") && !token.includes("\\") && !token.includes("."))
      continue;
    return executableBase(token) === "muse";
  }
  return false;
}

function executableBase(value: string): string {
  return basename(value)
    .replace(/\.exe$/iu, "")
    .toLowerCase();
}

async function attemptMuseCredential(
  candidate: CredentialCandidate<string>,
  dependencies: MuseDependencies,
): Promise<AttemptOutcome<NormalizedMusePayload>> {
  try {
    return {
      kind: "quota",
      result: await requestMuseQuota(candidate.credential, dependencies),
    };
  } catch (error) {
    if (error instanceof MuseFailure && error.definitiveAuth)
      return { kind: "rejected", error: error.code };
    const code =
      error instanceof MuseFailure ? error.code : "muse_request_failed";
    return {
      kind: "transient",
      error: code,
      ...(error instanceof MuseFailure && error.retryAfter
        ? { retryAfter: error.retryAfter }
        : {}),
    };
  }
}

async function requestMuseQuota(
  key: string,
  dependencies: MuseDependencies,
): Promise<NormalizedMusePayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.deadlineMs);
  try {
    let response: Response;
    try {
      response = await dependencies.fetch(MUSE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "User-Agent": `quota-axi/${VERSION}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          input: "ping",
          stream: true,
          max_output_tokens: 16,
        }),
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new MuseFailure(
        controller.signal.aborted ? "provider_timeout" : "network_unavailable",
      );
    }

    if (response.status === 401 || response.status === 403) {
      await cancelMuseResponse(response);
      throw new MuseFailure("provider_auth_rejected", {
        definitiveAuth: true,
      });
    }
    if (response.status === 408) {
      await cancelMuseResponse(response);
      throw new MuseFailure("provider_timeout");
    }
    if (response.status === 429) {
      await cancelMuseResponse(response);
      throw new MuseFailure("provider_rate_limited", {
        retryAfter: retryAfterToIso(
          response.headers.get("retry-after"),
          dependencies.now(),
        ),
      });
    }
    if (response.status >= 500) {
      await cancelMuseResponse(response);
      throw new MuseFailure("provider_unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelMuseResponse(response);
      throw new MuseFailure("redirect_rejected");
    }
    if (response.status !== 200) {
      await cancelMuseResponse(response);
      throw new MuseFailure("provider_request_rejected");
    }

    const subscription = await readMuseSubscriptionStream(
      response.body,
      controller.signal,
    );
    return normalizeMuseSubscription(subscription);
  } finally {
    clearTimeout(timeout);
  }
}

async function readMuseSubscriptionStream(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<MuseSubscription> {
  if (!body) throw new MuseFailure("muse_stream_missing");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const dataLines: string[] = [];
  let buffer = "";
  let receivedBytes = 0;
  let subscription: MuseSubscription | undefined;
  try {
    while (!subscription) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new MuseFailure(
          signal.aborted ? "provider_timeout" : "network_unavailable",
        );
      }
      if (result.done) {
        try {
          buffer += decoder.decode();
        } catch {
          throw new MuseFailure("response_invalid_utf8");
        }
        const lines = buffer.split(/\r?\n/u);
        for (const line of lines) {
          if (line === "") {
            subscription = parseMuseEvent(dataLines.join("\n"));
            dataLines.length = 0;
            if (subscription) break;
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /u, ""));
          }
        }
        if (!subscription && dataLines.length > 0)
          subscription = parseMuseEvent(dataLines.join("\n"));
        break;
      }

      receivedBytes += result.value.byteLength;
      if (receivedBytes > RESPONSE_LIMIT_BYTES)
        throw new MuseFailure("response_too_large");
      try {
        buffer += decoder.decode(result.value, { stream: true });
      } catch {
        throw new MuseFailure("response_invalid_utf8");
      }
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          subscription = parseMuseEvent(dataLines.join("\n"));
          dataLines.length = 0;
          if (subscription) break;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /u, ""));
          subscription = parseMuseEvent(dataLines.join("\n"));
          if (subscription) break;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Closing a completed or failed SSE stream does not change its result.
    }
    reader.releaseLock();
  }
  if (!subscription) throw new MuseFailure("muse_subscription_missing");
  return subscription;
}

function parseMuseEvent(data: string): MuseSubscription | undefined {
  const text = data.trim();
  if (!text || text === "[DONE]") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(text, museResponseReviver);
  } catch {
    return undefined;
  }
  const subscription = objectValue(objectValue(payload)?.subscription);
  if (!subscription) return undefined;
  const hasWindow =
    parseMusePercent(objectValue(subscription.window)?.used_percent) !==
    undefined;
  const hasWeekly =
    parseMusePercent(objectValue(subscription.weekly)?.used_percent) !==
    undefined;
  return hasWindow || hasWeekly
    ? {
        ...(objectValue(subscription.window)
          ? { window: objectValue(subscription.window) }
          : {}),
        ...(objectValue(subscription.weekly)
          ? { weekly: objectValue(subscription.weekly) }
          : {}),
      }
    : undefined;
}

function museResponseReviver(key: string, value: unknown): unknown {
  return key === "" || RESPONSE_KEYS[key] === true ? value : undefined;
}

function normalizeMuseSubscription(
  subscription: MuseSubscription,
): NormalizedMusePayload {
  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];
  const rolling = normalizeMuseWindow(subscription.window, "window");
  if (rolling) windows.push(rolling);
  else untrustedWindowIds.push("five_hour");
  const weekly = normalizeMuseWindow(subscription.weekly, "weekly");
  if (weekly) windows.push(weekly);
  else untrustedWindowIds.push("weekly");
  return { windows, untrustedWindowIds };
}

function normalizeMuseWindow(
  raw: Record<string, unknown> | undefined,
  source: "window" | "weekly",
): QuotaWindow | undefined {
  if (!raw) return undefined;
  const percent = parseMusePercent(raw.used_percent);
  if (percent === undefined) return undefined;
  const reportedMinutes = positiveNumber(raw.window_duration_mins);
  const windowSeconds =
    source === "weekly"
      ? reportedMinutes === undefined
        ? WEEK_SECONDS
        : reportedMinutes * 60
      : reportedMinutes === undefined
        ? undefined
        : reportedMinutes * 60;
  const resetsAt = parseMuseReset(raw.resets_at);
  const rollingIsFiveHours =
    source === "window" && windowSeconds === FIVE_HOURS_SECONDS;
  const id =
    source === "weekly"
      ? "weekly"
      : rollingIsFiveHours
        ? "five_hour"
        : "session";
  const label = source === "weekly" ? "week" : "session";
  const kind =
    source === "weekly" ? "weekly" : rollingIsFiveHours ? "session" : "unknown";
  const startsAt =
    resetsAt && windowSeconds !== undefined
      ? isoAt(Date.parse(resetsAt) - windowSeconds * 1000)
      : undefined;
  return {
    id,
    label,
    kind,
    percentUsed: percent,
    percentRemaining: 100 - percent,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(startsAt ? { startsAt } : {}),
  };
}

function parseMusePercent(value: unknown): number | undefined {
  const parsed = numericValue(value);
  return parsed === undefined ? undefined : clampPercent(parsed);
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = numericValue(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(text))
    return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMuseReset(value: unknown): string | undefined {
  const seconds = positiveNumber(value);
  if (seconds === undefined) return undefined;
  const milliseconds = seconds > 1_000_000_000_000 ? seconds : seconds * 1000;
  return isoAt(milliseconds);
}

function isoAt(milliseconds: number): string | undefined {
  try {
    return Number.isFinite(milliseconds)
      ? new Date(milliseconds).toISOString()
      : undefined;
  } catch {
    return undefined;
  }
}

async function cancelMuseResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status already identifies the failed request.
  }
}

function localFailureReport(
  resolved: readonly ResolvedMuseSource[],
): ProviderQuota {
  const attempts = attemptsForSources(resolved);
  const localFailure = resolved.find(
    ({ resolution }) =>
      resolution.status === "structurally_invalid" ||
      resolution.status === "read_error",
  );
  if (localFailure) {
    const resolution = localFailure.resolution;
    return failedMuseReport(
      "error",
      resolution.status === "structurally_invalid" ||
        resolution.status === "read_error"
        ? resolution.error
        : "muse_credential_invalid",
      attempts,
    );
  }
  return failedMuseReport(
    "auth_required",
    "muse_credential_unavailable",
    attempts,
  );
}

function failedMuseReport(
  status: ProviderStatus,
  error: string,
  attempts: SourceAttempt[],
  retryAfter?: string,
  authUsable = false,
): ProviderQuota {
  const report = failedProvider({
    provider: "muse-code",
    label: LABEL,
    status,
    error,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  if (authUsable) report.state.authStatus = "usable";
  if (status === "auth_required") report.state.authStatus = "unusable";
  return report;
}

function systemErrorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function literalMuseKey(value: unknown): string | undefined {
  const key = usableLiteralSecret(value);
  return key && !/\s/u.test(key) ? key : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}
function authStatusForResolution(
  resolution: MuseLocalResolution,
): AuthSourceReport["status"] {
  switch (resolution.status) {
    case "resolved":
      return "available";
    case "absent":
      return "missing";
    case "structurally_invalid":
      return "invalid";
    case "read_error":
      return "error";
  }
}

function museAuthFileReviver(key: string, value: unknown): unknown {
  return key === "" || AUTH_FILE_KEYS[key] === true ? value : undefined;
}
