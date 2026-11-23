import { homedir } from "node:os";
import { join } from "node:path";
import {
  opencodeDatabasePath,
  readOpenCodeDbCredential,
} from "../lib/opencode-db.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import {
  calendarMonthsBefore,
  parseEpochOrIso,
  clampPercent,
} from "../lib/time.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAccount,
  ProviderAdapter,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import {
  selectCredential,
  type AttemptOutcome,
  type CandidateResult,
  type CredentialCandidate as SelectionCandidate,
  type CredentialSelection,
} from "./credential-selection.js";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const OPENCODE_GO_CREDENTIAL_SOURCE = "opencode:auth.json";
export const OPENCODE_GO_DB_CREDENTIAL_SOURCE = "opencode:opencode.db";
export const PI_OPENCODE_GO_SOURCE = "pi:opencode-go";
/** Lane keys for the two opencode stores, after the `codex-home` pattern. */
export const OPENCODE_GO_DB_ACCOUNT_KEY = "opencode-db";
export const OPENCODE_GO_AUTH_ACCOUNT_KEY = "opencode-auth";

/**
 * Pi auth.json entry ids quota-axi reads for OpenCode Go: the built-in
 * `opencode-go` entry plus sibling keys such as `opencode-go-work`, the same
 * sibling shape #206 established for Codex.
 */
const PI_OPENCODE_GO_ENTRY_ID = /^opencode-go(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export function isPiOpenCodeGoEntryId(value: string): boolean {
  return PI_OPENCODE_GO_ENTRY_ID.test(value);
}

function piOpenCodeGoSourceName(entryId: string): string {
  return `pi:${entryId}`;
}

function entryIdFromPiSource(sourceName: string): string | undefined {
  return sourceName.startsWith("pi:") &&
    isPiOpenCodeGoEntryId(sourceName.slice("pi:".length))
    ? sourceName.slice("pi:".length)
    : undefined;
}

/** The lane key a credential source belongs to; unknown names open no lane. */
function laneKeyForSource(sourceName: string): string | undefined {
  const entryId = entryIdFromPiSource(sourceName);
  if (entryId) return entryId;
  if (sourceName === OPENCODE_GO_DB_CREDENTIAL_SOURCE)
    return OPENCODE_GO_DB_ACCOUNT_KEY;
  if (sourceName === OPENCODE_GO_CREDENTIAL_SOURCE)
    return OPENCODE_GO_AUTH_ACCOUNT_KEY;
  return undefined;
}
/**
 * Explicit opt-in that lets OpenCode Go read Pi's `opencode-go` entry ahead of
 * the opencode store. Unset or falsey keeps the long-standing default: the
 * opencode store is the only source, so an unscoped run never probes Pi.
 */
export const PI_OPENCODE_GO_AUTH_ENV = "QUOTA_AXI_OPENCODE_GO_PI_AUTH";

const PI_OPENCODE_GO_PROVIDER_ID = "opencode-go";
const OPENCODE_GO_INTEGRATION_ID = "opencode-go";

const LABEL = "OpenCode Go";
const RESPONSE_LIMIT_BYTES = 262_144;
const BODY_CLEANUP_TIMEOUT_MS = 100;
const DEADLINE_MS = 15_000;
/** Plan-declared rolling cap: $12 per rolling 5 hours. */
const FIVE_HOURS_SECONDS = 18_000;
/** Plan-declared weekly cap: $30 per week. */
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export type CredentialResolution =
  | { status: "available"; key: string; path: string }
  | { status: "missing" | "invalid" | "error" | "skipped"; path: string };

export type CredentialInspection =
  | { status: "available"; path: string }
  | { status: "missing" | "invalid" | "error" | "skipped"; path: string };

type MaybePromise<T> = T | Promise<T>;

export type OpenCodeGoCredentialSource = {
  resolve(): MaybePromise<CredentialResolution>;
  inspect(): MaybePromise<CredentialInspection>;
};

export type NamedOpenCodeGoCredentialSource = {
  name: string;
  source: OpenCodeGoCredentialSource;
};

type Dependencies = {
  credentialSources: NamedOpenCodeGoCredentialSource[];
  /** Pi auth.json entry ids OpenCode Go may read, built-in first. */
  piEntryIds: () => Promise<string[]>;
  /** The credential source one Pi entry id resolves through. */
  piEntrySource: (entryId: string) => OpenCodeGoCredentialSource;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedOpenCodeGoPayload = {
  plan?: string;
  windows: QuotaWindow[];
};

export function opencodeGoAuthFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "opencode", "auth.json");
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return join(localAppData, "opencode", "auth.json");
  }
  return join(join(homedir(), ".local", "share"), "opencode", "auth.json");
}

export function extractOpenCodeGoCredential(
  value: unknown,
  path: string,
): CredentialResolution {
  const root = objectValue(value);
  if (!root) return { status: "missing", path };
  let hasEntry = false;
  for (const name of ["opencode-go", "opencode"]) {
    const entry = objectValue(root[name]);
    if (!entry) continue;
    hasEntry = true;
    const key = [
      entry.key,
      entry.apiKey,
      entry.api_key,
      entry.access,
      entry.token,
    ]
      .map(usableLiteralSecret)
      .find((candidate): candidate is string => candidate !== undefined);
    if (key) return { status: "available", key, path };
  }
  return { status: hasEntry ? "invalid" : "missing", path };
}

function extractPiOpenCodeGoEntryCredential(
  value: unknown,
  path: string,
  entryId: string,
): CredentialResolution {
  const classified = classifyPiAuthEntry(value, entryId);
  if (classified.status === "missing") return { status: "missing", path };
  const key =
    classified.status === "present" && classified.entry.type === "api_key"
      ? usableLiteralSecret(classified.entry.key)
      : undefined;
  return key ? { status: "available", key, path } : { status: "invalid", path };
}

function createJsonCredentialSource(
  filePath: () => string,
  extract: (value: unknown, path: string) => CredentialResolution,
): OpenCodeGoCredentialSource {
  function resolve(): CredentialResolution {
    const path = filePath();
    const result: JsonFileReadResult = readJsonFileResult(path);
    if (result.status === "missing") return { status: "missing", path };
    if (result.status === "invalid") {
      return {
        status: result.error === "file_read_error" ? "error" : "invalid",
        path,
      };
    }
    return extract(result.value, path);
  }
  return {
    resolve,
    inspect(): CredentialInspection {
      const resolution = resolve();
      return resolution.status === "available"
        ? { status: "available", path: resolution.path }
        : resolution;
    },
  };
}

export function createOpencodeGoAuthCredentialSource(
  filePath: () => string = opencodeGoAuthFilePath,
): OpenCodeGoCredentialSource {
  return createJsonCredentialSource(filePath, extractOpenCodeGoCredential);
}

/**
 * OpenCode 2.x keeps new and updated logins only in its SQLite `credential`
 * table. Read-only; see `src/lib/opencode-db.ts`.
 */
export function createOpencodeGoDbCredentialSource(
  filePath: () => string = () => opencodeDatabasePath(opencodeGoAuthFilePath()),
): OpenCodeGoCredentialSource {
  async function resolve(): Promise<CredentialResolution> {
    const path = filePath();
    const result = await readOpenCodeDbCredential(
      path,
      OPENCODE_GO_INTEGRATION_ID,
    );
    return result.status === "available"
      ? { status: "available", key: result.key, path }
      : { status: result.status, path };
  }
  return {
    resolve,
    async inspect(): Promise<CredentialInspection> {
      const resolution = await resolve();
      return resolution.status === "available"
        ? { status: "available", path: resolution.path }
        : resolution;
    },
  };
}

export function createPiOpenCodeGoCredentialSource(
  filePath: () => string = resolvePiAuthFilePath,
): OpenCodeGoCredentialSource {
  return createJsonCredentialSource(filePath, (value, path) =>
    extractPiOpenCodeGoEntryCredential(value, path, PI_OPENCODE_GO_PROVIDER_ID),
  );
}

export function createPiOpenCodeGoEntryCredentialSource(
  entryId: string,
  filePath: () => string = resolvePiAuthFilePath,
): OpenCodeGoCredentialSource {
  if (!isPiOpenCodeGoEntryId(entryId))
    return {
      resolve: () => ({ status: "missing", path: filePath() }),
      inspect: () => ({ status: "missing", path: filePath() }),
    };
  return createJsonCredentialSource(filePath, (value, path) =>
    extractPiOpenCodeGoEntryCredential(value, path, entryId),
  );
}

/**
 * Every Pi auth.json entry id quota-axi may read for OpenCode Go, built-in
 * first, then siblings in lexical order. Empty unless the opt-in environment
 * flag is set: an unscoped run never probes Pi, so it also discovers no Pi
 * lanes.
 */
export async function listPiOpenCodeGoEntryIds(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string[]> {
  if (!piOpenCodeGoAuthEnabled(environment)) return [];
  const result = readJsonFileResult(resolvePiAuthFilePath(environment));
  if (result.status !== "success") return [];
  return piOpenCodeGoEntryIdsFromAuth(result.value);
}

/** The OpenCode Go entry ids one parsed Pi auth.json carries. */
export function piOpenCodeGoEntryIdsFromAuth(value: unknown): string[] {
  const root = objectValue(value);
  if (!root) return [];
  const ids = Object.keys(root).filter(isPiOpenCodeGoEntryId);
  ids.sort((left, right) => {
    if (left === PI_OPENCODE_GO_PROVIDER_ID) return -1;
    if (right === PI_OPENCODE_GO_PROVIDER_ID) return 1;
    return left.localeCompare(right);
  });
  return ids;
}

/**
 * Pi's `opencode-go` entry is added first only when the opt-in environment
 * flag asks for it. OpenCode 2.x's database comes next because it is where a
 * current login is stored, then the legacy `auth.json` stays as the fallback
 * for 1.x installs. See
 * README "Security Posture > Provider credential sources" for the rationale.
 */
export function defaultOpenCodeGoCredentialSources(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NamedOpenCodeGoCredentialSource[] {
  const sources: NamedOpenCodeGoCredentialSource[] = [];
  if (piOpenCodeGoAuthEnabled(environment)) {
    sources.push({
      name: PI_OPENCODE_GO_SOURCE,
      source: createPiOpenCodeGoCredentialSource(),
    });
  }
  sources.push(
    {
      name: OPENCODE_GO_DB_CREDENTIAL_SOURCE,
      source: createOpencodeGoDbCredentialSource(),
    },
    {
      name: OPENCODE_GO_CREDENTIAL_SOURCE,
      source: createOpencodeGoAuthCredentialSource(),
    },
  );
  return sources;
}

function piOpenCodeGoAuthEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = environment[PI_OPENCODE_GO_AUTH_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export async function resolveOpenCodeGoCredential(
  path = opencodeGoAuthFilePath(),
): Promise<CredentialResolution> {
  return createOpencodeGoAuthCredentialSource(() => path).resolve();
}

export function createOpenCodeGoAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credentialSources: defaultOpenCodeGoCredentialSources(),
    piEntryIds: () => listPiOpenCodeGoEntryIds(),
    piEntrySource: (entryId) =>
      createPiOpenCodeGoEntryCredentialSource(entryId),
    fetch: globalThis.fetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "opencode-go",
    label: LABEL,
    discoverAccounts: () => discoverOpenCodeGoAccounts(dependencies),
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const opencodeGoAdapter = createOpenCodeGoAdapter();

type ResolvedCredentialSource = {
  name: string;
  resolution: CredentialResolution;
};

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const { resolved, selection } =
    await selectOpenCodeGoCredential(dependencies);
  const attempts = sourceAttempts(resolved, selection);

  if (selection.outcome === "quota" && selection.result) {
    const normalized = selection.result;
    return successProvider({
      provider: "opencode-go",
      label: LABEL,
      source: "api",
      ...(normalized.plan ? { plan: normalized.plan } : {}),
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  const failure = selectionFailureFor(selection, resolved);
  return failedProvider({
    provider: "opencode-go",
    label: LABEL,
    status: failure.status,
    error: failure.code,
    source: "api",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function resolveSafely(
  source: OpenCodeGoCredentialSource,
): Promise<CredentialResolution> {
  try {
    return await source.resolve();
  } catch {
    return { status: "error", path: "" };
  }
}

async function inspectSafely(
  source: OpenCodeGoCredentialSource,
): Promise<CredentialInspection> {
  try {
    return await source.inspect();
  } catch {
    return { status: "error", path: "" };
  }
}

/** One credential surface discovery found holding a usable literal key. */
type DiscoveredSurface = {
  laneKey: string;
  sourceName: string;
  source: OpenCodeGoCredentialSource;
  key: string;
};

/**
 * One reported account: its own credential first, then the sibling surfaces
 * folded into it because they hold the identical literal key. Keys stay in
 * memory only; they are never logged, rendered, cached, or sent anywhere but
 * the usage request's authorization header.
 */
type DiscoveredLane = {
  accountKey: string;
  key: string;
  surfaces: DiscoveredSurface[];
};

/**
 * The lanes to report, or `undefined` to keep the single selected account.
 *
 * Following the #206 Codex pattern, expansion is a default only when the host
 * actually holds more than one distinct OpenCode Go credential: every
 * configured surface resolves in its own priority order, Pi sibling entries
 * slot in beside the built-in entry when the opt-in flag is set, and surfaces
 * whose literal keys are byte-identical fold into the first lane as one
 * account. One surface or one folded account keeps the legacy single-winner
 * path byte-identical, so a host with a single key sees exactly what it saw
 * before.
 */
async function discoverOpenCodeGoAccounts(
  dependencies: Dependencies,
): Promise<ProviderAccount[] | undefined> {
  const surfaces = await discoverSurfaces(dependencies);
  const lanes: DiscoveredLane[] = [];
  const laneByCredential = new Map<string, DiscoveredLane>();
  for (const surface of surfaces) {
    const existing = laneByCredential.get(surface.key);
    if (existing) {
      existing.surfaces.push(surface);
      continue;
    }
    const lane: DiscoveredLane = {
      accountKey: surface.laneKey,
      key: surface.key,
      surfaces: [surface],
    };
    lanes.push(lane);
    laneByCredential.set(surface.key, lane);
  }
  // A sole credential keeps the single selected account, as Codex keeps its
  // single-winner path when only the built-in Pi entry is present.
  if (lanes.length < 2) return undefined;
  return lanes.map((lane) => ({
    accountKey: lane.accountKey,
    fetchQuota: async () => readLaneQuota(lane, dependencies),
    inspectAuth: async () => inspectLaneAuth(lane),
  }));
}

/**
 * Every surface holding a usable key, in report order: the configured
 * sources in their own priority order, with Pi sibling entries slotted
 * directly after the last Pi surface so all Pi lanes stay together ahead of
 * the opencode stores.
 */
async function discoverSurfaces(
  dependencies: Dependencies,
): Promise<DiscoveredSurface[]> {
  const configured: (DiscoveredSurface | undefined)[] = [];
  let lastPiBoundary = 0;
  for (const { name, source } of dependencies.credentialSources) {
    const laneKey = laneKeyForSource(name);
    const resolution = await resolveSafely(source);
    configured.push(
      laneKey && resolution.status === "available"
        ? {
            laneKey,
            sourceName: name,
            source,
            key: resolution.key,
          }
        : undefined,
    );
    if (entryIdFromPiSource(name)) lastPiBoundary = configured.length;
  }
  const covered = new Set(
    dependencies.credentialSources.map(({ name }) => name),
  );
  const surfaces: DiscoveredSurface[] = [];
  for (const entryId of await safePiEntryIds(dependencies)) {
    const sourceName = piOpenCodeGoSourceName(entryId);
    if (covered.has(sourceName)) continue;
    const source = dependencies.piEntrySource(entryId);
    const resolution = await resolveSafely(source);
    if (resolution.status !== "available") continue;
    configured.splice(lastPiBoundary++, 0, {
      laneKey: entryId,
      sourceName,
      source,
      key: resolution.key,
    });
  }
  for (const surface of configured) {
    if (surface) surfaces.push(surface);
  }
  return surfaces;
}

async function safePiEntryIds(dependencies: Dependencies): Promise<string[]> {
  try {
    return await dependencies.piEntryIds();
  } catch {
    return [];
  }
}

/**
 * One lane's own reading: the lane's credential alone asks the vendor, and a
 * sibling's success or failure never substitutes for it. The published row
 * names every credential key the lane covers, own key first, so consumers can
 * bind either route to it (#275).
 */
async function readLaneQuota(
  lane: DiscoveredLane,
  dependencies: Dependencies,
): Promise<ProviderQuota> {
  const accountKeys = lane.surfaces.map((surface) => surface.laneKey);
  try {
    const payload = await requestUsage(
      lane.key,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const normalized = normalizeOpenCodeGoPayload(payload);
    if (normalized.windows.length === 0)
      return laneFailureReport(lane, "quota_missing", "error", accountKeys);
    return {
      ...successProvider({
        provider: "opencode-go",
        label: LABEL,
        source: "api",
        ...(normalized.plan ? { plan: normalized.plan } : {}),
        windows: normalized.windows,
        refreshedAt: new Date(dependencies.now()).toISOString(),
        sourcesTried: [lane.surfaces[0]!.sourceName],
        attempts: [{ source: lane.surfaces[0]!.sourceName, status: "success" }],
      }),
      accountKeys,
    };
  } catch (error) {
    const code = errorCode(error);
    const status =
      code === "provider_auth_rejected"
        ? "auth_required"
        : code === "provider_rate_limited"
          ? "rate_limited"
          : "error";
    return laneFailureReport(lane, code, status, accountKeys);
  }
}

function laneFailureReport(
  lane: DiscoveredLane,
  code: string,
  status: ProviderStatus,
  accountKeys: string[],
): ProviderQuota {
  return {
    ...failedProvider({
      provider: "opencode-go",
      label: LABEL,
      status,
      error: code,
      source: "api",
      sourcesTried: [lane.surfaces[0]!.sourceName],
      attempts: [
        { source: lane.surfaces[0]!.sourceName, status: "failed", error: code },
      ],
    }),
    accountKeys,
  };
}

/** A lane's own stores, each reporting the credential state it holds now. */
async function inspectLaneAuth(
  lane: DiscoveredLane,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = await Promise.all(
    lane.surfaces.map(async ({ sourceName, source }) => ({
      source: sourceName,
      ...authSourceStatus(await inspectSafely(source)),
    })),
  );
  return { provider: "opencode-go", sources };
}

function authSourceStatus(inspection: CredentialInspection): {
  path?: string;
  status: AuthSourceReport["status"];
  error?: string;
  credentialPresent?: boolean;
} {
  return {
    path: inspection.path,
    status:
      inspection.status === "available"
        ? "available"
        : inspection.status === "missing"
          ? "missing"
          : inspection.status === "error"
            ? "error"
            : inspection.status === "skipped"
              ? "skipped"
              : "invalid",
    ...(inspection.status === "error"
      ? { error: "credential_resolution_failed" }
      : {}),
    ...(inspection.status === "skipped"
      ? { error: "sqlite3_unavailable", credentialPresent: true }
      : {}),
  };
}

async function selectOpenCodeGoCredential(dependencies: Dependencies): Promise<{
  resolved: ResolvedCredentialSource[];
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>;
}> {
  const resolved: ResolvedCredentialSource[] = [];
  const results: CandidateResult[] = [];

  for (const { name, source } of dependencies.credentialSources) {
    const resolution = await resolveSafely(source);
    resolved.push({ name, resolution });
    if (resolution.status !== "available") continue;

    const selection = await selectCredential(
      [
        {
          source: name,
          localState: "valid",
          credential: resolution.key,
        },
      ],
      (candidate) => attemptCandidate(candidate, dependencies),
    );
    results.push(...selection.results);
    if (
      selection.outcome === "quota" ||
      selection.outcome === "transient" ||
      selection.outcome === "live_no_quota"
    ) {
      return {
        resolved,
        selection: { ...selection, results },
      };
    }
  }

  return {
    resolved,
    selection: {
      outcome: results.length > 0 ? "all_rejected" : "no_candidates",
      refreshable: false,
      results,
    },
  };
}

async function attemptCandidate(
  candidate: SelectionCandidate<string>,
  dependencies: Dependencies,
): Promise<AttemptOutcome<NormalizedOpenCodeGoPayload>> {
  try {
    const payload = await requestUsage(
      candidate.credential,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const normalized = normalizeOpenCodeGoPayload(payload);
    if (normalized.windows.length === 0) {
      return { kind: "transient", error: "quota_missing" };
    }
    return { kind: "quota", result: normalized };
  } catch (error) {
    const code = errorCode(error);
    if (code === "provider_auth_rejected") {
      return { kind: "rejected", error: code };
    }
    return { kind: "transient", error: code };
  }
}

function sourceAttempts(
  resolved: readonly ResolvedCredentialSource[],
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
): SourceAttempt[] {
  return resolved.map(({ name, resolution }) => {
    if (resolution.status === "available") {
      return selectionAttemptRecord(
        name,
        selection.results.find((entry) => entry.source === name),
        selection,
      );
    }
    return {
      source: name,
      status: resolution.status === "error" ? "failed" : "skipped",
      error: credentialError(resolution),
      ...(resolution.status === "invalid" || resolution.status === "skipped"
        ? { credentialPresent: true }
        : {}),
    };
  });
}

function selectionAttemptRecord(
  sourceName: string,
  result: CandidateResult | undefined,
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
): SourceAttempt {
  if (
    result === undefined ||
    result.outcome === "not_tried" ||
    result.outcome === "live_no_quota"
  ) {
    return {
      source: sourceName,
      status: "skipped",
      ...(selection.transientError ? { error: selection.transientError } : {}),
    };
  }
  if (result.outcome === "quota") {
    return { source: sourceName, status: "success" };
  }
  return { source: sourceName, status: "failed", error: result.error };
}

type LocalFailure = { status: ProviderStatus; code: string };

function selectionFailureFor(
  selection: CredentialSelection<NormalizedOpenCodeGoPayload>,
  resolved: readonly ResolvedCredentialSource[],
): LocalFailure {
  switch (selection.outcome) {
    case "transient":
      return transientFailure(
        selection.transientError ?? "quota_request_failed",
      );
    case "all_rejected": {
      const indeterminate = indeterminateFailureFor(resolved);
      return (
        indeterminate ?? {
          status: "auth_required",
          code: "provider_auth_rejected",
        }
      );
    }
    case "live_no_quota":
      // Unreachable: every attempt yields windows or throws.
      return { status: "error", code: "quota_missing" };
    default:
      return (
        indeterminateFailureFor(resolved) ??
        localCredentialFailure({ status: "missing", path: "" })
      );
  }
}

function transientFailure(code: string): LocalFailure {
  return {
    status: code === "provider_rate_limited" ? "rate_limited" : "error",
    code,
  };
}

function indeterminateFailureFor(
  resolved: readonly ResolvedCredentialSource[],
): LocalFailure | undefined {
  const fallback = resolved.find(
    ({ name, resolution }) =>
      (name === OPENCODE_GO_CREDENTIAL_SOURCE ||
        name === OPENCODE_GO_DB_CREDENTIAL_SOURCE) &&
      (resolution.status === "invalid" ||
        resolution.status === "error" ||
        resolution.status === "skipped"),
  );
  const preferred = resolved.find(
    ({ name, resolution }) =>
      name === PI_OPENCODE_GO_SOURCE &&
      (resolution.status === "invalid" || resolution.status === "error"),
  );
  const failure = fallback ?? preferred;
  return failure ? localCredentialFailure(failure.resolution) : undefined;
}

function localCredentialFailure(
  resolution: CredentialResolution,
): LocalFailure {
  if (resolution.status === "missing") {
    return {
      status: "auth_required",
      code: "opencode_go_credential_unavailable",
    };
  }
  if (resolution.status === "error") {
    return { status: "error", code: "credential_resolution_failed" };
  }
  if (resolution.status === "skipped") {
    return { status: "error", code: "sqlite3_unavailable" };
  }
  return { status: "error", code: "opencode_go_credential_invalid" };
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = await Promise.all(
    dependencies.credentialSources.map(async ({ name, source }) => ({
      source: name,
      ...authSourceStatus(await inspectSafely(source)),
    })),
  );
  return { provider: "opencode-go", sources };
}

async function requestUsage(
  key: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let fetchPromise: Promise<Response> | undefined;
  try {
    fetchPromise = fetchImplementation(OPENCODE_GO_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    void fetchPromise.then(
      (response) => {
        if (timedOut) void cancelResponseBody(response);
      },
      () => undefined,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("provider_timeout"));
      }, deadlineMs);
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response.ok) {
      await cancelResponseBody(response);
    }
    if (response.status === 401 || response.status === 403)
      throw new Error("provider_auth_rejected");
    if (response.status === 429) throw new Error("provider_rate_limited");
    if (!response.ok) throw new Error("provider_request_rejected");
    const body = await readResponseBody(response, controller.signal);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new Error("malformed_json");
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("provider_timeout", { cause: error });
    if (
      error instanceof Error &&
      (error.message.startsWith("provider_") ||
        error.message === "response_too_large" ||
        error.message === "response_size_unverifiable" ||
        error.message === "malformed_json")
    )
      throw error;
    throw new Error("network_unavailable", { cause: error });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = Promise.resolve()
    .then(() => body.cancel())
    .catch(() => undefined);
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = response.headers?.get("content-length")?.trim();
  const parsedLength = declaredLength ? Number(declaredLength) : undefined;
  const usableLength =
    parsedLength !== undefined &&
    Number.isInteger(parsedLength) &&
    parsedLength >= 0;
  if (
    usableLength &&
    parsedLength !== undefined &&
    parsedLength > RESPONSE_LIMIT_BYTES
  ) {
    await cancelResponseBody(response);
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("response_size_unverifiable");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    while (true) {
      pendingRead = reader.read();
      const result = await raceWithAbort(pendingRead, signal);
      pendingRead = undefined;
      if (result.done) break;
      const chunk = result.value;
      if (length + chunk.byteLength > RESPONSE_LIMIT_BYTES) {
        throw new Error("response_too_large");
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } finally {
    if (pendingRead) {
      if (typeof reader.cancel === "function")
        await settlePendingRead(reader, pendingRead);
      else pendingRead.catch(() => undefined);
    } else {
      if (typeof reader.cancel === "function")
        void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function settlePendingRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pendingRead: Promise<ReadableStreamReadResult<Uint8Array>>,
): Promise<void> {
  // A pending read owns the stream lock. Cancellation is best effort here:
  // releasing it while the read is still pending throws in native streams and
  // can leave the response body in an inconsistent state. The settlement
  // handler below performs the release whenever the vendor body eventually
  // responds, even if that happens after this bounded cleanup returns.
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => undefined);
  let released = false;
  const releaseAfterReadSettles = (): void => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      return;
    }
  };
  const readSettled = pendingRead.then(
    releaseAfterReadSettles,
    releaseAfterReadSettles,
  );
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      readSettled,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error("provider_timeout");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("provider_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function normalizeOpenCodeGoPayload(
  raw: unknown,
  now = Date.now(),
): NormalizedOpenCodeGoPayload {
  const root = objectValue(raw);
  const nestedUsage = objectValue(root?.usage);
  const definitions = [
    [["rollingUsage", "rolling"], "five_hour", "session"],
    [["weeklyUsage", "weekly"], "weekly", "weekly"],
    [["monthlyUsage", "monthly"], "monthly", "monthly"],
  ] as const;
  const windows = definitions
    .map(([names, id, kind]) => {
      const record = names
        .map(
          (name) =>
            objectValue(nestedUsage?.[name]) ?? objectValue(root?.[name]),
        )
        .find(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== undefined,
        );
      return record ? normalizeWindow(record, id, kind, now) : undefined;
    })
    .filter((window): window is QuotaWindow => window !== undefined);
  const plan =
    firstString(root, ["planName", "plan_name", "plan"]) ?? "OpenCode Go";
  return { plan, windows };
}

function normalizeWindow(
  record: Record<string, unknown>,
  id: string,
  kind: QuotaWindow["kind"],
  now: number,
): QuotaWindow | undefined {
  const used = firstNumber(record, [
    "percent",
    "percentUsed",
    "usedPercent",
    "usagePercent",
  ]);
  const remaining = firstNumber(record, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const status = stringValue(record.status)?.toLowerCase();
  const percentRemaining =
    remaining !== undefined
      ? clampPercent(remaining)
      : used !== undefined
        ? clampPercent(100 - used)
        : status === "rate-limited"
          ? 0
          : undefined;
  if (percentRemaining === undefined) return undefined;
  const reset = firstValue(record, [
    "resetsAt",
    "resetAt",
    "reset_at",
    "nextResetTime",
  ]);
  const windowSeconds = firstNumber(record, [
    "windowSeconds",
    "window_seconds",
    "cycleSeconds",
    "cycle_seconds",
    "durationSeconds",
    "duration_seconds",
    "periodSeconds",
    "period_seconds",
  ]);
  const resetInSec = firstNumber(record, ["resetInSec", "reset_in_sec"]);
  const parsedReset =
    safeParseReset(reset) ??
    (resetInSec !== undefined && resetInSec >= 0
      ? isoFromTimestamp(now + resetInSec * 1_000)
      : undefined);
  // Only a payload-supplied 18,000 s rolling duration promotes the window to
  // the `five_hour` identity; plan-declared fallbacks below never do.
  const hasAuthoritativeDuration = windowSeconds === FIVE_HOURS_SECONDS;
  const hasPayloadDuration = windowSeconds !== undefined && windowSeconds > 0;
  // Plan-declared cycle lengths fill in only when the payload names none;
  // a payload duration always wins. The monthly cap is one calendar month
  // ending at the reported reset, so only its start is derived.
  const effectiveWindowSeconds = hasPayloadDuration
    ? windowSeconds
    : parsedReset === undefined
      ? undefined
      : id === "five_hour"
        ? FIVE_HOURS_SECONDS
        : id === "weekly"
          ? WEEK_SECONDS
          : undefined;
  const derivedStartsAt =
    id === "monthly" && !hasPayloadDuration && parsedReset !== undefined
      ? calendarMonthsBefore(parsedReset, 1)
      : undefined;
  const normalizedIdentity =
    id === "five_hour" && !hasAuthoritativeDuration
      ? { id: "rolling", label: "rolling", kind: "unknown" as const }
      : { id, label: id === "five_hour" ? "session" : id, kind };
  return {
    ...normalizedIdentity,
    percentUsed: clampPercent(100 - percentRemaining),
    percentRemaining,
    ...(effectiveWindowSeconds !== undefined
      ? { windowSeconds: effectiveWindowSeconds }
      : {}),
    ...(derivedStartsAt ? { startsAt: derivedStartsAt } : {}),
    ...(parsedReset ? { resetsAt: parsedReset } : {}),
  };
}

function safeParseReset(value: unknown): string | undefined {
  try {
    const parsed = parseEpochOrIso(value);
    return parsed && !Number.isNaN(Date.parse(parsed)) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isoFromTimestamp(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function credentialError(
  resolution: Exclude<CredentialResolution, { status: "available" }>,
): string {
  return resolution.status === "missing"
    ? "opencode_go_credential_unavailable"
    : resolution.status === "invalid"
      ? "opencode_go_credential_invalid"
      : resolution.status === "skipped"
        ? "sqlite3_unavailable"
        : "credential_resolution_failed";
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "quota_request_failed";
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
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  return value
    ? keys.map((key) => stringValue(value[key])).find(Boolean)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  return keys
    .map((key) => numberValue(value[key]))
    .find((item) => item !== undefined);
}

function firstValue(value: Record<string, unknown>, keys: string[]): unknown {
  return keys
    .map((key) => value[key])
    .find((item) => item !== undefined && item !== null);
}
