import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { providerFetch } from "../lib/http.js";
import { clampPercent, nowIso } from "../lib/time.js";
import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderId,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
} from "../types.js";
import { failedProvider, successProvider, withRemaining } from "./common.js";
import { normalizeClaudeApiUsage, normalizeClaudeProfile } from "./claude.js";
import { normalizeCodexUsage } from "./codex.js";

const ENV_FILE = join(homedir(), ".config", "cpa-management.env");
const API_TIMEOUT_MS = 15_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CODEX_USAGE_URLS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
];

type CpaConfig = { baseUrl: string; key: string };
type AuthFile = {
  auth_index?: unknown;
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  status?: unknown;
  status_message?: unknown;
  disabled?: unknown;
  unavailable?: unknown;
  email?: unknown;
  account?: unknown;
};
type CpaResponse = { status_code?: unknown; body?: unknown };

function envFileValues(): Record<string, string> {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const match =
        /^\s*(CPA_BASE_URL|CPA_MANAGEMENT_KEY)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
    }
    return values;
  } catch {
    return {};
  }
}

export function readCpaConfig(): CpaConfig | undefined {
  const file = envFileValues();
  const explicitBaseUrl = process.env.CPA_BASE_URL;
  const explicitKey = process.env.CPA_MANAGEMENT_KEY;
  const runningTests =
    process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
  const allowFile =
    (!runningTests &&
      process.env.NODE_ENV !== "test" &&
      process.env.VITEST !== "true") ||
    explicitBaseUrl !== undefined ||
    explicitKey !== undefined;
  const baseUrl = (
    explicitBaseUrl ??
    (allowFile ? file.CPA_BASE_URL : undefined) ??
    ""
  ).trim();
  const key = (
    explicitKey ??
    (allowFile ? file.CPA_MANAGEMENT_KEY : undefined) ??
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
  const name = (text(file.provider) ?? "").toLowerCase();
  if (provider === "claude") return name === "claude" || name === "anthropic";
  return name === "codex" || name === "openai" || name === "chatgpt";
}

function fileIdentity(file: AuthFile): ProviderQuota["account"] {
  const email = text(file.email) ?? text(file.id) ?? text(file.name);
  const account = text(file.account);
  return {
    ...(email ? { email } : {}),
    ...(account ? { organization: account } : {}),
    identityStatus: email ? "verified" : "unverified",
  };
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
  if (
    file.unavailable === true ||
    file.disabled === true ||
    text(file.status) === "error"
  ) {
    return failed(
      provider,
      key,
      text(file.status_message)
        ? "cpa_account_status_error"
        : "cpa_account_unavailable",
      "error",
      account,
    );
  }
  if (!authIndex)
    return failed(
      provider,
      key,
      "cpa_auth_index_missing",
      "unavailable",
      account,
    );
  try {
    if (provider === "claude") {
      const usage = await upstreamCall(config, authIndex, CLAUDE_USAGE_URL, {
        authorization: "Bearer $TOKEN$",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.202",
        accept: "application/json",
      });
      if (usage.status === 401 || usage.status === 403)
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
      const profile = await upstreamCall(
        config,
        authIndex,
        CLAUDE_PROFILE_URL,
        {
          authorization: "Bearer $TOKEN$",
          "User-Agent": "claude-code/2.1.202",
          accept: "application/json",
        },
      );
      const profileAccount = normalizeClaudeProfile(profile.body);
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

function poolReport(
  provider: ProviderId,
  rows: ProviderQuota[],
  files: AuthFile[],
): ProviderQuota {
  const successful = rows.filter((row) => row.state.status === "fresh");
  const windows: QuotaWindow[] = [];
  const ids = [
    ...new Set(
      successful.flatMap((row) => row.windows.map((window) => window.id)),
    ),
  ];
  for (const id of ids) {
    const candidates = successful.flatMap((row) =>
      row.windows.filter((window) => window.id === id),
    );
    const measured = candidates.filter(
      (window) => window.percentRemaining !== undefined,
    );
    if (measured.length === 0) continue;
    const remaining =
      measured.reduce((sum, window) => sum + window.percentRemaining!, 0) /
      measured.length;
    const first = measured[0]!;
    windows.push(
      withRemaining({
        id,
        label: `${first.label} pool`,
        kind: first.kind,
        percentUsed: clampPercent(100 - remaining),
        resetsAt: first.resetsAt,
        resetText: first.resetText,
        windowSeconds: first.windowSeconds,
      }),
    );
  }
  const failedRows = rows.filter((row) => row.state.status !== "fresh");
  const report = successProvider({
    provider,
    label: provider === "claude" ? "Claude" : "Codex",
    source: "cpa",
    plan: successful.find((row) => row.plan)?.plan,
    account: { organization: "CLIProxyAPI pool", identityStatus: "verified" },
    windows,
    refreshedAt:
      successful
        .map((row) => row.state.refreshedAt ?? "")
        .sort()
        .at(-1) ?? nowIso(),
    sourcesTried: ["cpa"],
  });
  // Keep native lane identities so existing consumers bind the pooled row.
  report.accountKey = provider === "codex" ? "codex-home" : "default";
  report.accountKeys = files
    .map((file) => text(file.auth_index))
    .filter((index): index is string => !!index)
    .map(accountKey);
  if (successful.length === 0) {
    report.state.status = "error";
    report.state.error = "cpa_no_account_quota";
  }
  if (failedRows.length > 0) {
    report.state.degradedSources = failedRows.map((row) => ({
      source: row.accountKey ?? "cpa-account",
      error: row.state.error,
    }));
  }
  return report;
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
      if (!config) return undefined;
      let files: AuthFile[];
      try {
        files = (await listAuthFiles(config)).filter((file) =>
          providerMatches(file, provider),
        );
      } catch {
        return [
          {
            accountKey: provider === "codex" ? "codex-home" : "default",
            fetchQuota: async () =>
              failed(provider, "cpa-pool", "cpa_auth_files_unavailable"),
            inspectAuth: async () => ({
              provider,
              accountKey: provider === "codex" ? "codex-home" : "default",
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
      const cache = new Map<string, Promise<ProviderQuota>>();
      const read = (file: AuthFile, key: string) => {
        const index = text(file.auth_index) ?? key;
        const existing = cache.get(index);
        if (existing) return existing;
        const request = readAccount(config, provider, file, key);
        cache.set(index, request);
        return request;
      };
      const accounts: ProviderAccount[] = files.map((file, position) => {
        const key = accountKey(text(file.auth_index) ?? `${position}`);
        return {
          accountKey: key,
          fetchQuota: async () => read(file, key),
          inspectAuth: async () => ({
            provider,
            accountKey: key,
            sources: [
              {
                source: "cpa",
                status:
                  file.disabled === true || file.unavailable === true
                    ? "error"
                    : "available",
                ...(text(file.status_message)
                  ? { error: text(file.status_message) }
                  : {}),
              },
            ],
          }),
        };
      });
      accounts.push({
        accountKey: provider === "codex" ? "codex-home" : "default",
        fetchQuota: async () =>
          poolReport(
            provider,
            await Promise.all(
              files.map((file, position) =>
                read(file, accountKey(text(file.auth_index) ?? `${position}`)),
              ),
            ),
            files,
          ),
        inspectAuth: async () => ({
          provider,
          accountKey: provider === "codex" ? "codex-home" : "default",
          sources: [{ source: "cpa", status: "available" }],
        }),
      });
      return accounts.length > 1 ? accounts : undefined;
    },
  };
}

export function isCpaAccount(provider: ProviderQuota): boolean {
  return provider.source === "cpa" && (provider.accountKeys?.length ?? 0) <= 1;
}
