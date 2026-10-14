import { providerFetch } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderId,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
} from "../types.js";
import {
  cpaAccountContextId,
  readCachedCpaProvider,
  readReusableCpaProvider,
  retireCachedSlot,
  stampCpaAccountContext,
  stampSubscriptionScope,
} from "../cache.js";
import {
  isLoopbackHost,
  readCpaConfig,
  type CpaConfig,
  type CpaConfigError,
} from "./cpa-config.js";
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

type AuthFile = {
  auth_index?: unknown;
  provider?: unknown;
  disabled?: unknown;
  email?: unknown;
  id_token?: unknown;
};
type CpaResponse = { status_code?: unknown; body?: unknown };

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

function pinnedCodexAccountId(file: AuthFile): string | undefined {
  return file.id_token && typeof file.id_token === "object"
    ? text(
        (file.id_token as { chatgpt_account_id?: unknown }).chatgpt_account_id,
      )
    : undefined;
}

function fileStatusError(file: AuthFile): string | undefined {
  return file.disabled === true ? "cpa_account_disabled" : undefined;
}

async function cpaRequest(
  config: CpaConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = new URL(`${config.baseUrl}/v0/management${path}`);
  const send = isLoopbackHost(url.hostname) ? fetch : providerFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await send(url, {
      ...init,
      headers: {
        authorization: `Bearer ${config.key}`,
        accept: "application/json",
        ...(init.headers ?? {}),
      },
      // A redirect would leave the endpoint whose transport was checked.
      redirect: "manual",
      signal: controller.signal,
    });
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
  options: ProviderOptions,
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
  const pinnedAccountId = pinnedCodexAccountId(file);
  // The pinned workspace is part of the slot's identity, so a re-pinned auth
  // file never reuses or falls back to another workspace's reading.
  const contextId = cpaAccountContextId(
    config.baseUrl,
    authIndex,
    pinnedAccountId,
  );
  const reused = readReusableCpaProvider(
    provider,
    contextId,
    options.maxAgeSeconds ?? 0,
  );
  if (reused)
    return {
      ...reused,
      accountKey: key,
      accountKeys: [key],
      account,
    };
  const report = await readUpstream(
    config,
    provider,
    authIndex,
    account,
    key,
    pinnedAccountId,
  );
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
  pinnedAccountId: string | undefined,
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
      const normalized = succeeded(usage.status)
        ? normalizeClaudeApiUsage(usage.body)
        : undefined;
      if (!normalized)
        return failed(
          provider,
          key,
          "cpa_quota_unavailable",
          "unavailable",
          account,
        );
      const profile = await upstreamCall(
        config,
        authIndex,
        CLAUDE_PROFILE_URL,
        {
          authorization: "Bearer $TOKEN$",
          "User-Agent": CLAUDE_CODE_USER_AGENT,
          accept: "application/json",
        },
      ).then(
        (response) => (succeeded(response.status) ? response.body : undefined),
        () => undefined,
      );
      const profileAccount = normalizeClaudeProfile(profile);
      const organizationId = text(
        (profile as { organization?: { uuid?: unknown } } | undefined)
          ?.organization?.uuid,
      );
      const quota: ProviderQuota = {
        ...successProvider({
          provider,
          label: "Claude",
          source: "cpa",
          plan: normalized.plan,
          account: {
            ...account,
            ...Object.fromEntries(
              Object.entries(profileAccount ?? {}).filter(
                ([, value]) => value !== undefined,
              ),
            ),
          },
          windows: normalized.windows,
          refreshedAt: nowIso(),
          sourcesTried: ["cpa"],
        }),
        accountKey: key,
      };
      stampSubscriptionScope(quota, organizationId ?? null);
      return quota;
    }
    let normalized;
    let usageBody: unknown;
    let rejectedEverywhere = true;
    let requestError: string | undefined;
    for (const url of CODEX_USAGE_URLS) {
      let response;
      try {
        response = await upstreamCall(config, authIndex, url, {
          authorization: "Bearer $TOKEN$",
          accept: "application/json",
          ...(pinnedAccountId ? { "ChatGPT-Account-Id": pinnedAccountId } : {}),
        });
      } catch (error) {
        rejectedEverywhere = false;
        requestError = requestErrorCode(error);
        continue;
      }
      if (response.status === 401 || response.status === 403) continue;
      rejectedEverywhere = false;
      if (response.status === 429)
        return failed(
          provider,
          key,
          "cpa_rate_limited",
          "rate_limited",
          account,
        );
      if (!succeeded(response.status)) continue;
      usageBody = response.body;
      normalized = normalizeCodexUsage(usageBody);
      if (normalized) break;
    }
    if (!normalized) {
      if (requestError)
        return failed(provider, key, requestError, "error", account);
      return failed(
        provider,
        key,
        rejectedEverywhere ? "cpa_account_rejected" : "cpa_quota_unavailable",
        rejectedEverywhere ? "auth_required" : "unavailable",
        account,
      );
    }
    const vendorEmail = normalized.account?.email;
    const seat =
      text((usageBody as { user_id?: unknown }).user_id) ?? vendorEmail;
    const verifiedId =
      pinnedAccountId &&
      seat &&
      normalized.account?.accountId === pinnedAccountId
        ? pinnedAccountId
        : undefined;
    const quota: ProviderQuota = {
      ...successProvider({
        provider,
        label: "Codex",
        source: "cpa",
        plan: normalized.plan,
        // A workspace id names every seat of a Team or Business workspace, so
        // the row is verified only when the vendor answers with the workspace
        // this read pinned and names the seat; the file's email never does.
        account: {
          ...account,
          ...(vendorEmail ? { email: vendorEmail } : {}),
          ...(verifiedId
            ? { accountId: verifiedId, identityStatus: "verified" as const }
            : {}),
        },
        windows: normalized.windows,
        credits: normalized.credits,
        refreshedAt: normalized.refreshedAt,
        sourcesTried: ["cpa"],
      }),
      accountKey: key,
    };
    if (verifiedId && seat) stampSubscriptionScope(quota, seat);
    return quota;
  } catch (error) {
    return failed(provider, key, requestErrorCode(error), "error", account);
  }
}

function succeeded(status: number): boolean {
  return status >= 200 && status < 300;
}

function requestErrorCode(error: unknown): string {
  return error instanceof Error && error.name === "AbortError"
    ? "cpa_timeout"
    : "cpa_request_failed";
}

export function createCpaAdapter(
  provider: ProviderId,
  fallback: ProviderAdapter,
  configReader: () => CpaConfig | CpaConfigError | undefined = readCpaConfig,
): ProviderAdapter {
  const unlisted = (error: string): ProviderAccount[] => [
    {
      accountKey: UNLISTED_LANE,
      fetchQuota: async () => failed(provider, UNLISTED_LANE, error),
      inspectAuth: async () => ({
        provider,
        accountKey: UNLISTED_LANE,
        sources: [{ source: "cpa", status: "error", error }],
      }),
    },
  ];
  return {
    ...fallback,
    discoverAccounts: async (): Promise<ProviderAccount[] | undefined> => {
      const config = configReader();
      if (!config) return fallback.discoverAccounts?.();
      if ("error" in config) return unlisted(config.error);
      let files: AuthFile[];
      try {
        files = (await listAuthFiles(config)).filter((file) =>
          providerMatches(file, provider),
        );
      } catch {
        return unlisted("cpa_auth_files_unavailable");
      }
      if (files.length === 0) return fallback.discoverAccounts?.();
      return files.map((file, position) => {
        const key = accountKey(text(file.auth_index) ?? `${position}`);
        const authError =
          fileStatusError(file) ??
          (text(file.auth_index) ? undefined : "cpa_auth_index_missing");
        return {
          accountKey: key,
          fetchQuota: async (options) =>
            readAccount(config, provider, file, key, options),
          inspectAuth: async () => ({
            provider,
            accountKey: key,
            sources: [
              authError
                ? { source: "cpa", status: "error", error: authError }
                : { source: "cpa", status: "available" },
            ],
          }),
        };
      });
    },
  };
}
