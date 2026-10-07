import { readFileSync } from "node:fs";
import { providerFetch } from "../lib/http.js";
import { cpaEnvFilePath } from "../lib/reuse-context.js";
import { nowIso } from "../lib/time.js";
import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderId,
  ProviderQuota,
  ProviderStatus,
} from "../types.js";
import {
  cpaAccountContextId,
  readCachedCpaProvider,
  retireCachedSlot,
  stampCpaAccountContext,
} from "../cache.js";
import {
  failedProvider,
  staleUnlessSignOut,
  successProvider,
} from "./common.js";
import {
  API_URL as CLAUDE_USAGE_URL,
  CLAUDE_CODE_USER_AGENT,
  OAUTH_BETA,
  PROFILE_API_URL as CLAUDE_PROFILE_URL,
  normalizeClaudeApiUsage,
  normalizeClaudeProfile,
} from "./claude.js";
import { ENDPOINTS as CODEX_USAGE_URLS, normalizeCodexUsage } from "./codex.js";

const API_TIMEOUT_MS = 15_000;
const UNLISTED_LANE = "cpa";

type CpaConfig = { baseUrl: string; key: string };
type AuthFile = {
  auth_index?: unknown;
  provider?: unknown;
  status?: unknown;
  disabled?: unknown;
  unavailable?: unknown;
  email?: unknown;
};
type CpaResponse = { status_code?: unknown; body?: unknown };

function envFileValues(path: string): Record<string, string> {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match =
        /^\s*(CPA_BASE_URL|CPA_MANAGEMENT_KEY)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
    }
    return values;
  } catch {
    return {};
  }
}

export function readCpaConfig(
  environment: Record<string, string | undefined> = process.env,
): CpaConfig | undefined {
  const file = envFileValues(cpaEnvFilePath(environment));
  const baseUrl = (environment.CPA_BASE_URL ?? file.CPA_BASE_URL ?? "").trim();
  const key = (
    environment.CPA_MANAGEMENT_KEY ??
    file.CPA_MANAGEMENT_KEY ??
    ""
  ).trim();
  if (!baseUrl || !key) return undefined;
  try {
    const url = new URL(baseUrl);
    return { baseUrl: url.toString().replace(/\/$/, ""), key };
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function accountKey(index: string): string {
  const safe = index
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 80);
  return `cpa-${safe || "unknown"}`;
}

function providerMatches(file: AuthFile, provider: ProviderId): boolean {
  return text(file.provider)?.toLowerCase() === provider;
}

function fileIdentity(file: AuthFile): ProviderQuota["account"] {
  const email = text(file.email);
  return { ...(email ? { email } : {}), identityStatus: "unverified" };
}

function fileStatusError(file: AuthFile): string | undefined {
  if (text(file.status) === "error") return "cpa_account_status_error";
  if (file.unavailable === true || file.disabled === true)
    return "cpa_account_unavailable";
  return undefined;
}

async function cpaRequest(
  config: CpaConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await providerFetch(
      `${config.baseUrl}/v0/management${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${config.key}`,
          accept: "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`cpa_http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function listAuthFiles(config: CpaConfig): Promise<AuthFile[]> {
  const raw = await cpaRequest(config, "/auth-files");
  const files =
    raw && typeof raw === "object"
      ? (raw as { files?: unknown }).files
      : undefined;
  return Array.isArray(files)
    ? files.filter(
        (file): file is AuthFile => !!file && typeof file === "object",
      )
    : [];
}

async function upstreamCall(
  config: CpaConfig,
  authIndex: string,
  url: string,
  header: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const raw = await cpaRequest(config, "/api-call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      auth_index: authIndex,
      method: "GET",
      url,
      header,
    }),
  });
  const response = (raw ?? {}) as CpaResponse;
  const status =
    typeof response.status_code === "number" ? response.status_code : 0;
  let body: unknown = response.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // Preserve the fact that the upstream body was not JSON without retaining it.
      body = undefined;
    }
  }
  return { status, body };
}

function failed(
  provider: ProviderId,
  key: string,
  error: string,
  status: ProviderStatus = "error",
  account?: ProviderQuota["account"],
): ProviderQuota {
  const report = failedProvider({
    provider,
    label: provider === "claude" ? "Claude" : "Codex",
    status,
    error,
    source: "cpa",
    sourcesTried: ["cpa"],
  });
  return { ...report, accountKey: key, ...(account ? { account } : {}) };
}

async function readAccount(
  config: CpaConfig,
  provider: ProviderId,
  file: AuthFile,
  key: string,
): Promise<ProviderQuota> {
  const authIndex = text(file.auth_index);
  const account = fileIdentity(file);
  const statusError = fileStatusError(file);
  if (statusError) return failed(provider, key, statusError, "error", account);
  if (!authIndex)
    return failed(
      provider,
      key,
      "cpa_auth_index_missing",
      "unavailable",
      account,
    );
  const report = await readUpstream(config, provider, authIndex, account, key);
  const contextId = cpaAccountContextId(config.baseUrl, authIndex);
  if (report.state.status === "fresh") {
    stampCpaAccountContext(report, contextId);
    return report;
  }
  const stale = staleUnlessSignOut(
    readCachedCpaProvider(provider, contextId),
    report.state.error ?? report.state.status,
    ["cpa"],
    [],
    {
      definitive: report.state.status === "auth_required",
      retire: () => retireCachedSlot(provider, key),
    },
  );
  return stale ? { ...stale, accountKey: key, account } : report;
}

async function readUpstream(
  config: CpaConfig,
  provider: ProviderId,
  authIndex: string,
  account: ProviderQuota["account"],
  key: string,
): Promise<ProviderQuota> {
  try {
    if (provider === "claude") {
      const usage = await upstreamCall(config, authIndex, CLAUDE_USAGE_URL, {
        authorization: "Bearer $TOKEN$",
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        accept: "application/json",
      });
      if (usage.status === 401)
        return failed(
          provider,
          key,
          "cpa_account_rejected",
          "auth_required",
          account,
        );
      if (usage.status === 429)
        return failed(
          provider,
          key,
          "cpa_rate_limited",
          "rate_limited",
          account,
        );
      const normalized = normalizeClaudeApiUsage(usage.body);
      if (!normalized)
        return failed(
          provider,
          key,
          "cpa_quota_unavailable",
          "unavailable",
          account,
        );
      const profileAccount = await upstreamCall(
        config,
        authIndex,
        CLAUDE_PROFILE_URL,
        {
          authorization: "Bearer $TOKEN$",
          "User-Agent": CLAUDE_CODE_USER_AGENT,
          accept: "application/json",
        },
      ).then(
        (profile) => normalizeClaudeProfile(profile.body),
        () => undefined,
      );
      return {
        ...successProvider({
          provider,
          label: "Claude",
          source: "cpa",
          plan: normalized.plan,
          account: { ...account, ...(profileAccount ?? {}) },
          windows: normalized.windows,
          refreshedAt: nowIso(),
          sourcesTried: ["cpa"],
        }),
        accountKey: key,
      };
    }
    let normalized;
    let lastStatus = 0;
    for (const url of CODEX_USAGE_URLS) {
      const response = await upstreamCall(config, authIndex, url, {
        authorization: "Bearer $TOKEN$",
        accept: "application/json",
      });
      lastStatus = response.status;
      if (response.status === 401 || response.status === 403) continue;
      if (response.status === 429)
        return failed(
          provider,
          key,
          "cpa_rate_limited",
          "rate_limited",
          account,
        );
      normalized = normalizeCodexUsage(response.body);
      if (normalized) break;
    }
    if (!normalized) {
      return failed(
        provider,
        key,
        lastStatus === 401 || lastStatus === 403
          ? "cpa_account_rejected"
          : "cpa_quota_unavailable",
        lastStatus === 401 || lastStatus === 403
          ? "auth_required"
          : "unavailable",
        account,
      );
    }
    return {
      ...successProvider({
        provider,
        label: "Codex",
        source: "cpa",
        plan: normalized.plan,
        account: { ...account, ...(normalized.account ?? {}) },
        windows: normalized.windows,
        credits: normalized.credits,
        refreshedAt: normalized.refreshedAt,
        sourcesTried: ["cpa"],
      }),
      accountKey: key,
    };
  } catch (error) {
    const code =
      error instanceof Error && error.name === "AbortError"
        ? "cpa_timeout"
        : "cpa_request_failed";
    return failed(provider, key, code, "error", account);
  }
}

export function createCpaAdapter(
  provider: ProviderId,
  fallback: ProviderAdapter,
  configReader: () => CpaConfig | undefined = readCpaConfig,
): ProviderAdapter {
  return {
    ...fallback,
    discoverAccounts: async (): Promise<ProviderAccount[] | undefined> => {
      const config = configReader();
      if (!config) return fallback.discoverAccounts?.();
      let files: AuthFile[];
      try {
        files = (await listAuthFiles(config)).filter((file) =>
          providerMatches(file, provider),
        );
      } catch {
        return [
          {
            accountKey: UNLISTED_LANE,
            fetchQuota: async () =>
              failed(provider, UNLISTED_LANE, "cpa_auth_files_unavailable"),
            inspectAuth: async () => ({
              provider,
              accountKey: UNLISTED_LANE,
              sources: [
                {
                  source: "cpa",
                  status: "error",
                  error: "cpa_auth_files_unavailable",
                },
              ],
            }),
          },
        ];
      }
      if (files.length === 0) return fallback.discoverAccounts?.();
      return files.map((file, position) => {
        const key = accountKey(text(file.auth_index) ?? `${position}`);
        const statusError = fileStatusError(file);
        return {
          accountKey: key,
          fetchQuota: async () => readAccount(config, provider, file, key),
          inspectAuth: async () => ({
            provider,
            accountKey: key,
            sources: [
              statusError
                ? { source: "cpa", status: "error", error: statusError }
                : { source: "cpa", status: "available" },
            ],
          }),
        };
      });
    },
  };
}
