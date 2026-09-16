import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { execFileText } from "../lib/process.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { clampPercent, parseEpochOrIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

export const KIRO_CLI_SOURCE = "kiro-cli";
export const KIRO_IDE_SOURCE = "kiro-ide";
export const PI_KIRO_SOURCE = "pi:kiro";
export const KIRO_CLI_DB_ENV = "KIRO_CLI_DB";
export const KIRO_USAGE_URL =
  "https://management.{region}.kiro.dev/Get-Usage-Limits";
export const KIRO_PROFILES_URL =
  "https://management.{region}.kiro.dev/List-Available-Profiles";

const LABEL = "Kiro";
const KIRO_CLI_TIMEOUT_MS = 5_000;
const KIRO_REQUEST_TIMEOUT_MS = 15_000;
const KIRO_CLI_TOKEN_KEYS = [
  "kirocli:social:token",
  "kirocli:odic:token",
  "codewhisperer:odic:token",
  "kirocli:external-idp:token",
] as const;
const KIRO_API_REGIONS: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "eu-north-1": "eu-central-1",
  "ap-southeast-1": "eu-central-1",
  "ap-northeast-1": "eu-central-1",
};

type KiroCredential = {
  accessToken: string;
  region: string;
  profileArn?: string;
  expiresAt?: string;
  path: string;
};
type CredentialResolution =
  | { status: "available" | "expired"; credential: KiroCredential }
  | { status: "missing" | "invalid" | "error"; path: string; error?: string };
type CredentialSource = {
  resolve(): Promise<CredentialResolution>;
  inspect(): Promise<CredentialResolution>;
};
type NamedCredentialSource = { name: string; source: CredentialSource };
type Dependencies = {
  credentialSources: NamedCredentialSource[];
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedKiroPayload = {
  plan?: string;
  account?: { email?: string; accountId?: string };
  overageStatus?: string;
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

export const kiroAdapter = createKiroAdapter();

export function createKiroAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credentialSources: defaultKiroCredentialSources(),
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: KIRO_REQUEST_TIMEOUT_MS,
    ...overrides,
  };
  return {
    id: "kiro",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export function defaultKiroCredentialSources(): NamedCredentialSource[] {
  return [
    { name: PI_KIRO_SOURCE, source: createPiKiroCredentialSource() },
    { name: KIRO_CLI_SOURCE, source: createKiroCliCredentialSource() },
    { name: KIRO_IDE_SOURCE, source: createKiroIdeCredentialSource() },
  ];
}

export function kiroCliDbPath(): string {
  const configured = process.env[KIRO_CLI_DB_ENV]?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "kiro-cli",
      "data.sqlite3",
    );
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "kiro-cli",
      "data.sqlite3",
    );
  }
  return join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
}

export function kiroIdeTokenPath(): string {
  return join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");
}

export function createPiKiroCredentialSource(
  filePath: () => string = resolvePiAuthFilePath,
): CredentialSource {
  return {
    async resolve() {
      const path = filePath();
      return extractPiKiroCredential(readJsonFileResult(path), path);
    },
    async inspect() {
      return this.resolve();
    },
  };
}

export function extractPiKiroCredential(
  raw: ReturnType<typeof readJsonFileResult>,
  path: string,
): CredentialResolution {
  if (raw.status === "missing") return { status: "missing", path };
  if (raw.status === "invalid") {
    return { status: "invalid", path, error: raw.error };
  }
  const classified = classifyPiAuthEntry(raw.value, "kiro");
  if (classified.status === "missing") return { status: "missing", path };
  if (classified.status === "invalid") {
    return { status: "invalid", path, error: "invalid_credential" };
  }
  const entry = classified.entry;
  const type = stringValue(entry.type)?.toLowerCase();
  const accessToken =
    type === "api_key"
      ? usableLiteralSecret(entry.key)
      : type === "oauth"
        ? usableLiteralSecret(entry.access)
        : undefined;
  if (!accessToken)
    return { status: "invalid", path, error: "invalid_credential" };
  return credentialFromFields(
    accessToken,
    {
      region: entry.region,
      profileArn: entry.profileArn ?? entry.profile_arn,
      expiresAt: piExpiry(entry.expires),
    },
    path,
  );
}

export function createKiroCliCredentialSource(
  dbPath: () => string = kiroCliDbPath,
  exec: typeof execFileText = execFileText,
): CredentialSource {
  return {
    async resolve() {
      const path = dbPath();
      if (!existsSync(path)) return { status: "missing", path };
      try {
        return extractKiroSqliteCredential(
          await readKiroCliDatabase(path, exec),
          path,
        );
      } catch {
        return { status: "error", path, error: "credential_store_unreadable" };
      }
    },
    async inspect() {
      return this.resolve();
    },
  };
}

export function extractKiroSqliteCredential(
  output: string,
  path: string,
): CredentialResolution {
  let rows: unknown;
  try {
    rows = JSON.parse(output);
  } catch {
    return { status: "invalid", path, error: "credential_store_malformed" };
  }
  if (!Array.isArray(rows)) {
    return { status: "invalid", path, error: "credential_store_malformed" };
  }
  if (rows.length === 0) return { status: "missing", path };
  for (const row of rows) {
    const value = objectValue(row);
    const accessToken = usableLiteralSecret(value?.access_token);
    if (value && accessToken) {
      return credentialFromFields(accessToken, value, path);
    }
  }
  return { status: "invalid", path, error: "access_token_missing" };
}

export function createKiroIdeCredentialSource(
  filePath: () => string = kiroIdeTokenPath,
): CredentialSource {
  return {
    async resolve() {
      const path = filePath();
      return extractKiroIdeCredential(readJsonFileResult(path), path);
    },
    async inspect() {
      return this.resolve();
    },
  };
}

export function extractKiroIdeCredential(
  raw: ReturnType<typeof readJsonFileResult>,
  path: string,
): CredentialResolution {
  if (raw.status === "missing") return { status: "missing", path };
  if (raw.status === "invalid")
    return { status: "invalid", path, error: raw.error };
  const value = objectValue(raw.value);
  const accessToken = usableLiteralSecret(value?.accessToken);
  if (!value || !accessToken) {
    return { status: "invalid", path, error: "access_token_missing" };
  }
  return credentialFromFields(accessToken, value, path);
}

async function readKiroCliDatabase(
  path: string,
  exec: typeof execFileText,
): Promise<string> {
  const query = KIRO_CLI_SQL;
  if (exec !== execFileText)
    return exec(
      "sqlite3",
      ["-readonly", "-json", path, query],
      KIRO_CLI_TIMEOUT_MS,
    );
  try {
    const sqlite = await import("node:" + "sqlite");
    const database = new sqlite.DatabaseSync(path, { readOnly: true });
    try {
      return JSON.stringify(database.prepare(query).all());
    } finally {
      database.close();
    }
  } catch {
    return exec(
      "sqlite3",
      ["-readonly", "-json", path, query],
      KIRO_CLI_TIMEOUT_MS,
    );
  }
}

function credentialFromFields(
  accessToken: string,
  value: Record<string, unknown>,
  path: string,
): CredentialResolution {
  const region = normalizeRegion(value.region) ?? "us-east-1";
  const expiresAt = parseEpochOrIso(value.expiresAt ?? value.expires_at);
  const profileArn = stringValue(value.profileArn ?? value.profile_arn);
  const credential: KiroCredential = {
    accessToken,
    region,
    path,
    ...(profileArn ? { profileArn } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
  return {
    status:
      expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()
        ? "expired"
        : "available",
    credential,
  };
}

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let lastFailure: Failure = {
    code: "kiro_sign_in_required",
    status: "auth_required",
    staleEligible: false,
    definitiveAuth: true,
  };
  for (const { name, source } of dependencies.credentialSources) {
    const resolution = await source.resolve();
    if (resolution.status === "missing") {
      attempts.push({
        source: name,
        status: "skipped",
        error: "credentials_missing",
      });
      continue;
    }
    if (resolution.status === "invalid" || resolution.status === "error") {
      const failure: Failure = {
        code: resolution.error ?? "credential_invalid",
        status: resolution.status === "invalid" ? "auth_required" : "error",
        staleEligible: resolution.status === "error",
        definitiveAuth: resolution.status === "invalid",
      };
      attempts.push({
        source: name,
        status: "failed",
        error: failure.code,
        credentialPresent: true,
      });
      lastFailure = failure;
      if (!failure.definitiveAuth) continue;
      continue;
    }
    if (!("credential" in resolution)) continue;
    attempts.push({ source: name, status: "failed" });
    try {
      const payload = await requestKiroUsage(
        resolution.credential,
        dependencies,
      );
      if (!objectValue(payload)) {
        throw new KiroError("malformed_payload", false, false);
      }
      const normalized = normalizeKiroUsage(payload);
      if (normalized.windows.length === 0) {
        throw new KiroError("quota_missing", false, false);
      }
      attempts[attempts.length - 1] = { source: name, status: "success" };
      const report = successProvider({
        provider: "kiro",
        label: LABEL,
        source: "api",
        ...(normalized.plan ? { plan: normalized.plan } : {}),
        ...(normalized.account ? { account: normalized.account } : {}),
        ...(normalized.overageStatus
          ? { overageStatus: normalized.overageStatus }
          : {}),
        windows: normalized.windows,
        refreshedAt: new Date(dependencies.now()).toISOString(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
      if (normalized.untrustedWindowIds.length > 0) {
        report.state.untrustedWindowIds = normalized.untrustedWindowIds;
      }
      return report;
    } catch (error) {
      const failure = classifyKiroFailure(error);
      attempts[attempts.length - 1] = {
        source: name,
        status: "failed",
        error: failure.code,
      };
      lastFailure = failure;
      if (!failure.definitiveAuth && failure.code !== "quota_missing") break;
    }
  }
  return failedProvider({
    provider: "kiro",
    label: LABEL,
    status: lastFailure.status,
    error: lastFailure.code,
    source: "api",
    retryAfter: lastFailure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = [];
  for (const { name, source } of dependencies.credentialSources) {
    const resolution = await source.inspect();
    sources.push({
      source: name,
      path:
        "credential" in resolution
          ? resolution.credential.path
          : resolution.path,
      status:
        resolution.status === "available" ? "available" : resolution.status,
      ...(resolution.status === "invalid" || resolution.status === "error"
        ? { error: resolution.error }
        : {}),
    });
  }
  return { provider: "kiro", sources };
}

type Failure = {
  code: string;
  status: "auth_required" | "rate_limited" | "error";
  staleEligible: boolean;
  definitiveAuth: boolean;
  retryAfter?: string;
};

async function requestKiroUsage(
  credential: KiroCredential,
  dependencies: Dependencies,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.deadlineMs);
  try {
    const profileArn =
      credential.profileArn ??
      stringValue(process.env.KIRO_PROFILE_ARN) ??
      (await requestKiroProfile(credential, dependencies, controller.signal));
    const url = new URL(
      KIRO_USAGE_URL.replace("{region}", apiRegion(credential.region)),
    );
    url.searchParams.set("origin", "KIRO_CLI");
    url.searchParams.set("resourceType", "CREDIT");
    url.searchParams.set("isEmailRequired", "false");
    url.searchParams.set("profileArn", profileArn);
    const response = await dependencies.fetch(url, {
      method: "GET",
      headers: kiroHeaders(credential.accessToken),
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new KiroError("provider_auth_rejected", true, false);
    }
    if (response.status === 429) {
      throw new KiroError(
        "provider_rate_limited",
        false,
        true,
        retryAfterToIso(response.headers.get("retry-after")),
        true,
      );
    }
    if (!response.ok) {
      throw new KiroError(
        `provider_request_rejected_${response.status}`,
        false,
        true,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new KiroError("malformed_json", false, true);
    }
  } catch (error) {
    if (error instanceof KiroError) throw error;
    if (controller.signal.aborted)
      throw new KiroError("provider_timeout", false, true);
    throw new KiroError("network_unavailable", false, true);
  } finally {
    clearTimeout(timer);
  }
}

async function requestKiroProfile(
  credential: KiroCredential,
  dependencies: Dependencies,
  signal: AbortSignal,
): Promise<string> {
  const response = await dependencies.fetch(
    new URL(
      KIRO_PROFILES_URL.replace("{region}", apiRegion(credential.region)),
    ),
    {
      method: "POST",
      headers: {
        ...kiroHeaders(credential.accessToken),
        "Content-Type": "application/json",
      },
      body: "{}",
      credentials: "omit",
      redirect: "manual",
      signal,
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new KiroError("provider_auth_rejected", true, false);
  }
  if (response.status === 429) {
    throw new KiroError(
      "provider_rate_limited",
      false,
      true,
      retryAfterToIso(response.headers.get("retry-after")),
      true,
    );
  }
  if (!response.ok)
    throw new KiroError(
      `provider_request_rejected_${response.status}`,
      false,
      true,
    );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new KiroError("malformed_json", false, true);
  }
  const profiles = objectValue(payload)?.profiles;
  if (!Array.isArray(profiles))
    throw new KiroError("profile_unavailable", false, true);
  const profileArn = profiles
    .map((profile) => stringValue(objectValue(profile)?.arn))
    .find(Boolean);
  if (!profileArn) throw new KiroError("profile_unavailable", false, true);
  return profileArn;
}

function kiroHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "quota-axi",
  };
  if (accessToken.startsWith("ksk_")) headers.tokentype = "API_KEY";
  return headers;
}

export function normalizeKiroUsage(raw: unknown): NormalizedKiroPayload {
  const root = objectValue(raw);
  if (!root) return { windows: [], untrustedWindowIds: ["payload"] };
  const untrustedWindowIds: string[] = [];
  const breakdowns =
    Array.isArray(root.usageBreakdownList) && root.usageBreakdownList.length > 0
      ? root.usageBreakdownList
      : root.usageBreakdown !== undefined
        ? [root.usageBreakdown]
        : [];
  const windows =
    breakdowns.length > 0
      ? breakdowns.map((value, index) => {
          const window = normalizeBreakdown(value, index, root);
          if (!window) untrustedWindowIds.push(`usage:${index}`);
          return window ?? unknownWindow(`usage:${index}`, root);
        })
      : normalizeLimitList(root.limits, root, untrustedWindowIds);
  const subscription = objectValue(root.subscriptionInfo);
  const userInfo = objectValue(root.userInfo);
  const accountId = stringValue(userInfo?.userId);
  const email = stringValue(userInfo?.email);
  return {
    ...(stringValue(subscription?.subscriptionTitle)
      ? { plan: stringValue(subscription?.subscriptionTitle) }
      : {}),
    ...(email || accountId
      ? {
          account: {
            ...(email ? { email } : {}),
            ...(accountId ? { accountId } : {}),
          },
        }
      : {}),
    ...(stringValue(objectValue(root.overageConfiguration)?.overageStatus)
      ? {
          overageStatus: stringValue(
            objectValue(root.overageConfiguration)?.overageStatus,
          ),
        }
      : {}),
    windows: uniqueWindowIds(windows),
    untrustedWindowIds,
  };
}

function normalizeBreakdown(
  value: unknown,
  index: number,
  root: Record<string, unknown>,
): QuotaWindow | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const resourceType = stringValue(record.resourceType);
  const label =
    stringValue(record.displayName) ??
    stringValue(record.displayNamePlural) ??
    resourceType ??
    `usage:${index}`;
  const id = resourceType ?? label;
  return usageWindow(
    id,
    label,
    resourceType?.toUpperCase() === "CREDIT" ? "credits" : "unknown",
    numberValue(record.currentUsageWithPrecision ?? record.currentUsage),
    numberValue(record.usageLimitWithPrecision ?? record.usageLimit),
    stringValue(record.unit),
    numberValue(record.currentOveragesWithPrecision ?? record.currentOverages),
    numberValue(record.overageCharges),
    stringValue(record.currency),
    numberValue(record.overageRate),
    numberValue(record.overageCapWithPrecision ?? record.overageCap),
    parseEpochOrIso(record.nextDateReset ?? root.nextDateReset),
    numberValue(root.daysUntilReset),
  );
}

function normalizeLimitList(
  value: unknown,
  root: Record<string, unknown>,
  untrustedWindowIds: string[],
): QuotaWindow[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const record = objectValue(raw);
    const id = stringValue(record?.type) ?? `limit:${index}`;
    if (!record) {
      untrustedWindowIds.push(id);
      return unknownWindow(id, root);
    }
    const window = usageWindow(
      id,
      stringValue(record.type) ?? id,
      stringValue(record.type)?.toUpperCase() === "CREDIT"
        ? "credits"
        : "unknown",
      numberValue(record.currentUsage),
      numberValue(record.totalUsageLimit),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      parseEpochOrIso(root.nextDateReset),
      numberValue(root.daysUntilReset),
    );
    const percent = validPercent(record.percentUsed);
    if (percent !== undefined) {
      window.percentUsed = percent;
      window.percentRemaining = clampPercent(100 - percent);
    }
    return window;
  });
}

function usageWindow(
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  usage: number | undefined,
  limit: number | undefined,
  unit: string | undefined,
  overage: number | undefined,
  overageCharges: number | undefined,
  currency: string | undefined,
  overageRate: number | undefined,
  overageCap: number | undefined,
  resetsAt: string | undefined,
  daysUntilReset: number | undefined,
): QuotaWindow {
  const result: QuotaWindow = { id, label, kind };
  if (usage !== undefined) result.usage = usage;
  if (limit !== undefined) result.limit = limit;
  if (unit) result.unit = unit;
  if (overage !== undefined) result.overage = overage;
  if (overageCharges !== undefined) result.overageCharges = overageCharges;
  if (currency) result.currency = currency;
  if (overageRate !== undefined) result.overageRate = overageRate;
  if (overageCap !== undefined) result.overageCap = overageCap;
  if (resetsAt) result.resetsAt = resetsAt;
  if (!resetsAt && daysUntilReset !== undefined)
    result.resetText = `${daysUntilReset}d`;
  if (usage !== undefined && limit !== undefined && limit > 0) {
    result.percentUsed = clampPercent((usage / limit) * 100);
    result.percentRemaining = clampPercent(100 - (usage / limit) * 100);
  }
  return result;
}

function unknownWindow(id: string, root: Record<string, unknown>): QuotaWindow {
  const resetsAt = parseEpochOrIso(root.nextDateReset);
  return {
    id,
    label: id,
    kind: "unknown",
    ...(resetsAt ? { resetsAt } : {}),
    ...(!resetsAt && numberValue(root.daysUntilReset) !== undefined
      ? { resetText: `${numberValue(root.daysUntilReset)}d` }
      : {}),
  };
}

function classifyKiroFailure(error: unknown): Failure {
  if (error instanceof KiroError) {
    return {
      code: error.code,
      status: error.auth
        ? "auth_required"
        : error.rateLimited
          ? "rate_limited"
          : "error",
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      staleEligible: error.staleEligible,
      definitiveAuth: error.auth,
    };
  }
  return {
    code: "provider_request_failed",
    status: "error",
    staleEligible: true,
    definitiveAuth: false,
  };
}

function apiRegion(region: string): string {
  return KIRO_API_REGIONS[region] ?? region;
}

function piExpiry(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return parseEpochOrIso(value);
}

function normalizeRegion(value: unknown): string | undefined {
  const region = stringValue(value)?.toLowerCase();
  return region && /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)
    ? region
    : undefined;
}

function validPercent(value: unknown): number | undefined {
  const percent = numberValue(value);
  return percent !== undefined && percent >= 0 && percent <= 100
    ? clampPercent(percent)
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function uniqueWindowIds(windows: QuotaWindow[]): QuotaWindow[] {
  const counts = new Map<string, number>();
  return windows.map((window) => {
    const count = (counts.get(window.id) ?? 0) + 1;
    counts.set(window.id, count);
    return count === 1 ? window : { ...window, id: `${window.id}:${count}` };
  });
}

class KiroError extends Error {
  readonly code: string;

  constructor(
    message: string,
    readonly auth: boolean,
    readonly staleEligible: boolean,
    readonly retryAfter?: string,
    readonly rateLimited = false,
  ) {
    super(message);
    this.code = message;
  }
}

const KIRO_CLI_SQL = `SELECT
  json_extract(value, '$.access_token') AS access_token,
  json_extract(value, '$.region') AS region,
  COALESCE(json_extract(value, '$.profile_arn'), json_extract(value, '$.profileArn')) AS profile_arn,
  COALESCE(json_extract(value, '$.expires_at'), json_extract(value, '$.expiresAt')) AS expires_at
FROM auth_kv
WHERE key IN (${KIRO_CLI_TOKEN_KEYS.map((key) => `'${key}'`).join(", ")})
  AND json_valid(value)
ORDER BY CASE key
  WHEN 'kirocli:social:token' THEN 1
  WHEN 'kirocli:odic:token' THEN 2
  WHEN 'codewhisperer:odic:token' THEN 3
  ELSE 4
END;`;
