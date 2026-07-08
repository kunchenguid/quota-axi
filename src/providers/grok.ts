import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { findCommandPath } from "../lib/process.js";
import {
  clampPercent,
  nowIso,
  percentRemaining,
  retryAfterToIso,
} from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const API_TIMEOUT_MS = 15_000;

type GrokCredentials = {
  key: string;
  email?: string;
  teamId?: string;
  expiresAt?: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: GrokCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid" | "expired"; source: AuthSourceReport };

export const grokAdapter: ProviderAdapter = {
  id: "grok",
  label: "Grok",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;
  let retryAfter: string | undefined;

  const credentialState = readCredentialState();
  if (credentialState.status === "available") {
    attempts.push({ source: "api", status: "failed" });
    try {
      const quota = await fetchGrokBilling(credentialState.credentials);
      attempts[attempts.length - 1] = { source: "api", status: "success" };
      return successProvider({
        provider: "grok",
        label: "Grok",
        source: "api",
        plan: quota.plan,
        account: quota.account,
        windows: quota.windows,
        credits: quota.credits,
        refreshedAt: quota.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      finalError = errorMessage(error);
      attempts[attempts.length - 1] = {
        source: "api",
        status: "failed",
        error: finalError,
      };
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
    }
  } else {
    attempts.push({
      source: "auth-json",
      status: "skipped",
      error: `credentials_${credentialState.status}`,
    });
    finalError = "Grok sign-in required";
  }

  const cached = readCachedProvider("grok");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "grok",
    label: "Grok",
    status: retryAfter ? "rate_limited" : statusFromError(finalError),
    error: finalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const credentialState = readCredentialState();
  return { provider: "grok", sources: [credentialState.source] };
}

export function normalizeGrokBilling(
  raw: unknown,
  credentials?: Pick<GrokCredentials, "email" | "teamId">,
):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  const config = objectValue(objectValue(raw)?.config);
  if (!config) return undefined;
  const currentPeriod = objectValue(config.currentPeriod);
  const resetsAt =
    parseIso(config.billingPeriodEnd) ?? parseIso(currentPeriod?.end);
  const windows: QuotaWindow[] = [];
  const creditUsagePercent = numberValue(config.creditUsagePercent);
  if (creditUsagePercent !== undefined) {
    windows.push(
      withRemaining({
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: clampPercent(creditUsagePercent),
        resetsAt,
      }),
    );
  }
  const onDemandCap = numberValue(objectValue(config.onDemandCap)?.val);
  const onDemandUsed = numberValue(objectValue(config.onDemandUsed)?.val);
  if (onDemandCap !== undefined && onDemandCap > 0) {
    windows.push({
      id: "on_demand",
      label: "on-demand credits",
      kind: "credits",
      percentUsed:
        onDemandUsed === undefined
          ? undefined
          : clampPercent((onDemandUsed / onDemandCap) * 100),
      percentRemaining:
        onDemandUsed === undefined
          ? undefined
          : percentRemaining(clampPercent((onDemandUsed / onDemandCap) * 100)),
      resetsAt,
    });
  }
  for (const entry of arrayValue(config.productUsage)) {
    const product = objectValue(entry);
    const productName = stringValue(product?.product);
    const usagePercent = numberValue(product?.usagePercent);
    if (!productName || usagePercent === undefined) continue;
    windows.push(
      withRemaining({
        id: `product:${slugify(productName)}`,
        label: productName,
        kind: "credits",
        percentUsed: clampPercent(usagePercent),
        resetsAt,
      }),
    );
  }
  if (windows.length === 0) return undefined;
  const prepaidBalance = numberValue(objectValue(config.prepaidBalance)?.val);
  return {
    plan:
      stringValue(config.subscription_tier) ??
      stringValue(config.subscriptionTier),
    account: {
      email: credentials?.email,
      organization: credentials?.teamId,
    },
    windows,
    credits:
      prepaidBalance === undefined
        ? undefined
        : { remaining: prepaidBalance, unit: "credits" },
    refreshedAt: nowIso(),
  };
}

async function fetchGrokBilling(credentials: GrokCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${credentials.key}`,
      accept: "application/json",
    };
    const clientVersion = await readGrokClientVersion();
    if (clientVersion) headers["x-grok-client-version"] = clientVersion;
    const response = await fetch(BILLING_URL, {
      headers,
      signal: controller.signal,
    });
    rejectUnusableUsageResponse(response);
    const quota = normalizeGrokBilling(await response.json(), credentials);
    if (!quota) throw new Error("Grok quota unavailable");
    return quota;
  } finally {
    clearTimeout(timer);
  }
}

async function readGrokClientVersion(): Promise<string | undefined> {
  const homeVersion = readGrokHomeClientVersion();
  if (homeVersion) return homeVersion;
  const executable = await findCommandPath("grok");
  if (!executable) return undefined;
  const realpath = realpathBestEffort(executable);
  return (
    extractGrokVersionFromPath(realpath) ?? readPackageVersionNear(realpath)
  );
}

function readGrokHomeClientVersion(): string | undefined {
  const versionJson = readJsonFileResult(join(grokHomeDir(), "version.json"));
  if (versionJson.status !== "success") return undefined;
  return versionFromJson(versionJson.value);
}

function versionFromJson(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return extractVersion(direct);
  const data = objectValue(value);
  if (!data) return undefined;
  for (const key of [
    "version",
    "clientVersion",
    "client_version",
    "currentVersion",
    "current_version",
  ]) {
    const version = extractVersion(stringValue(data[key]));
    if (version) return version;
  }
  for (const item of Object.values(data)) {
    const version = extractVersion(stringValue(item));
    if (version) return version;
  }
  return undefined;
}

function extractVersion(value: string | undefined): string | undefined {
  return value?.match(
    /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z])/,
  )?.[1];
}

function extractGrokVersionFromPath(file: string): string | undefined {
  for (const part of file.split(/[\\/]+/)) {
    if (/grok/i.test(part)) {
      const version = extractVersion(part);
      if (version) return version;
    }
  }
  return undefined;
}

function readPackageVersionNear(file: string): string | undefined {
  let directory = dirname(file);
  while (true) {
    const packageJson = readJsonFileResult(join(directory, "package.json"));
    if (packageJson.status === "success") {
      const pkg = objectValue(packageJson.value);
      const version = stringValue(pkg?.version);
      if (version && packageLooksLikeGrok(pkg)) return version;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function packageLooksLikeGrok(
  pkg: Record<string, unknown> | undefined,
): boolean {
  const name = stringValue(pkg?.name)?.toLowerCase();
  if (name?.includes("grok")) return true;
  const bin = objectValue(pkg?.bin);
  return stringValue(bin?.grok) !== undefined;
}

function realpathBestEffort(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function readCredentialState(authFile = grokAuthFile()): CredentialState {
  return extractCredentialState(readJsonFileResult(authFile), authFile);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: { source: "auth-json", path, status: "missing" },
    };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: {
        source: "auth-json",
        path,
        status: "invalid",
        error: raw.error,
      },
    };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };
  let expired = false;
  for (const value of Object.values(data)) {
    const item = objectValue(value);
    const key = stringValue(item?.key);
    if (!key) continue;
    const expiresAt =
      stringValue(item?.expires_at) ?? stringValue(item?.expiresAt);
    if (isExpired(expiresAt)) {
      expired = true;
      continue;
    }
    return {
      status: "available",
      credentials: {
        key,
        email: stringValue(item?.email),
        teamId: stringValue(item?.team_id) ?? stringValue(item?.teamId),
        expiresAt,
      },
      source: { source: "auth-json", path, status: "available" },
    };
  }
  if (expired) {
    return {
      status: "expired",
      source: { source: "auth-json", path, status: "expired" },
    };
  }
  return {
    status: "invalid",
    source: { source: "auth-json", path, status: "invalid" },
  };
}

function grokAuthFile(): string {
  return process.env.GROK_AUTH_JSON
    ? process.env.GROK_AUTH_JSON
    : join(grokHomeDir(), "auth.json");
}

function grokHomeDir(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error("Grok sign-in required");
  }
  if (response.status === 429) {
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  }
  if (!response.ok)
    throw new Error(`Grok quota unavailable (${response.status})`);
}

function isExpired(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed <= Date.now();
}

function parseIso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Grok quota request timed out";
  return error instanceof Error ? error.message : "Grok quota unavailable";
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Grok quota endpoint rate limited");
  }
}
