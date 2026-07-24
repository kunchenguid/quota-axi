import { readCachedProvider } from "../cache.js";
import { nowIso } from "../lib/time.js";
import { execFileText } from "../lib/process.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
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

const DEFAULT_BASE_URL = "https://api.tokenrouter.com";
const API_TIMEOUT_MS = 15_000;
const KEY_ENV = "TOKENROUTER_MGMT_KEY";

type WalletResponse = {
  success?: boolean;
  data?: {
    topUpBalance?: number;
    voucherEfficientAmount?: number;
    toppedUpSpent?: number;
    voucherSpent?: number;
  };
};

export const tokenrouterAdapter: ProviderAdapter = {
  id: "tokenrouter",
  label: "TokenRouter",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const credential = await readCredential(options);
  const baseURL =
    process.env.QUOTA_AXI_TOKENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
  if (!credential) {
    attempts.push({
      source: "env",
      status: "skipped",
      error: "credential_missing",
    });
    if (process.platform === "darwin" && !options.allowKeychainPrompt) {
      attempts.push({
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      });
    }
    const cached = readCachedProvider("tokenrouter");
    if (cached)
      return staleFromCache(
        cached,
        "TokenRouter management key missing",
        sourceNames(attempts),
        attempts,
      );
    return failedProvider({
      provider: "tokenrouter",
      label: "TokenRouter",
      status: "auth_required",
      error: "TOKENROUTER_MGMT_KEY is not available",
      source: "unavailable",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  attempts.push({ source: "api", status: "failed" });
  try {
    const wallet = await fetchWallet(baseURL, credential.value);
    attempts[attempts.length - 1] = { source: "api", status: "success" };
    const topUpBalance = finite(wallet.data?.topUpBalance);
    const voucherBalance = finite(wallet.data?.voucherEfficientAmount);
    const topUpSpent = finite(wallet.data?.toppedUpSpent);
    const voucherSpent = finite(wallet.data?.voucherSpent);
    const balance = topUpBalance + voucherBalance;
    const spent = topUpSpent + voucherSpent;
    const total = balance + spent;
    return successProvider({
      provider: "tokenrouter",
      label: "TokenRouter",
      source: "api",
      windows:
        total > 0
          ? [
              withRemaining({
                id: "credit_pool",
                label: "credit pool",
                kind: "credits",
                percentUsed: (spent / total) * 100,
              }),
            ]
          : [],
      credits: { remaining: balance, unit: "usd" },
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[attempts.length - 1] = {
      source: "api",
      status: "failed",
      error: message,
    };
    const cached = readCachedProvider("tokenrouter");
    if (cached)
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    return failedProvider({
      provider: "tokenrouter",
      label: "TokenRouter",
      status: statusFromError(message),
      error: message,
      source: "api",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const available = Boolean(process.env[KEY_ENV]);
  const sources: AuthSourceReport[] = [
    {
      source: "env",
      status: available ? "available" : "missing",
      credentialPresent: available,
    },
  ];
  if (process.platform === "darwin") {
    const keychain = await readKeychainCredential(options.allowKeychainPrompt);
    sources.push({
      source: "keychain",
      status: keychain
        ? "available"
        : options.allowKeychainPrompt
          ? "missing"
          : "skipped",
      credentialPresent: Boolean(keychain),
      error:
        !options.allowKeychainPrompt && !keychain
          ? "keychain_prompt_required"
          : undefined,
    });
  }
  return { provider: "tokenrouter", sources };
}

type Credential = { value: string; source: "env" | "keychain" };

async function readCredential(
  options: ProviderOptions,
): Promise<Credential | undefined> {
  const env = process.env[KEY_ENV]?.trim();
  if (env) return { value: env, source: "env" };
  if (process.platform !== "darwin" || !options.allowKeychainPrompt)
    return undefined;
  const keychain = await readKeychainCredential(true);
  return keychain ? { value: keychain, source: "keychain" } : undefined;
}

async function readKeychainCredential(
  allowPrompt: boolean,
): Promise<string | undefined> {
  if (process.platform !== "darwin" || !allowPrompt) return undefined;
  try {
    const value = (
      await execFileText(
        "security",
        ["find-generic-password", "-a", KEY_ENV, "-s", "bridge-secrets", "-w"],
        5_000,
      )
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function fetchWallet(
  baseURL: string,
  key: string,
): Promise<WalletResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseURL}/api/management/self/wallet`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`TokenRouter wallet HTTP ${response.status}`);
    const payload = (await response.json()) as WalletResponse;
    if (payload.success !== true || !payload.data)
      throw new Error("TokenRouter wallet success=false");
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
