import { dirname, isAbsolute, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { readBoundedFile, readJsonFileResult } from "../lib/fs.js";
import { providerFetch, readBoundedResponseBody } from "../lib/http.js";
import { userConfigFilePath } from "../lib/user-config.js";
import { isAccountKey } from "../types.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type { ProviderId, ProviderQuota, QuotaWindow } from "../types.js";
import { servableStaleWindows } from "./common.js";

const CONFIG_ENV = "QUOTA_AXI_MAGPIE_CONFIG";
const wireProviders = {
  claude: "claude",
  codex: "codex",
  agy: "agy-cli",
} as const;
type Provider = keyof typeof wireProviders;
type Binding = {
  provider: Provider;
  accountKey: string;
  magpieAccountId: string;
  label?: string;
};
type Config = {
  endpoint: URL;
  tokenFile: string;
  accounts: Binding[];
  maxReadingAgeSeconds: number;
};
type Row = Record<string, unknown>;

function record(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configError(field: string): never {
  throw new AxiError(`Invalid ${CONFIG_ENV}: ${field}`, "VALIDATION_ERROR", [
    `Check the Magpie configuration file named by ${CONFIG_ENV}`,
  ]);
}

export function magpieConfigFor(providers: ProviderId[]): Config | undefined {
  const explicitPath = process.env[CONFIG_ENV]?.trim();
  if (
    explicitPath === "" ||
    !providers.some((provider) => Object.hasOwn(wireProviders, provider))
  )
    return;
  const path =
    explicitPath ?? join(dirname(userConfigFilePath()), "magpie.json");
  if (!isAbsolute(path)) configError("configuration path must be absolute");
  const result = readJsonFileResult(path);
  if (explicitPath === undefined && result.status === "missing") return;
  const data = result.status === "success" ? result.value : undefined;
  if (!record(data)) configError("expected a readable JSON object");
  if (typeof data.endpoint !== "string" || !URL.canParse(data.endpoint))
    configError("endpoint");
  const endpoint = new URL(data.endpoint);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && isLoopback(endpoint))
    )
  )
    configError(
      "endpoint must use HTTPS or loopback HTTP, without URL credentials, query or fragment",
    );
  if (typeof data.tokenFile !== "string" || !isAbsolute(data.tokenFile))
    configError("tokenFile must be an absolute path");
  const maxReadingAgeSeconds = data.maxReadingAgeSeconds ?? 300;
  if (
    typeof maxReadingAgeSeconds !== "number" ||
    !Number.isSafeInteger(maxReadingAgeSeconds) ||
    maxReadingAgeSeconds <= 0
  )
    configError("maxReadingAgeSeconds must be a positive integer");
  if (!Array.isArray(data.accounts) || !data.accounts.length)
    configError("accounts must be a nonempty array");
  const keys = new Set<string>();
  const pins = new Set<string>();
  const accounts: Binding[] = data.accounts.map((binding: unknown) => {
    if (
      !record(binding) ||
      (binding.provider !== "claude" &&
        binding.provider !== "codex" &&
        binding.provider !== "agy")
    )
      configError("unsupported account provider");
    if (
      !isAccountKey(binding.accountKey) ||
      !/^magpie-.+/.test(binding.accountKey)
    )
      configError(
        "accountKey must start with magpie- followed by a local account identifier",
      );
    if (
      typeof binding.magpieAccountId !== "string" ||
      !binding.magpieAccountId.startsWith(
        wireProviders[binding.provider] + "/",
      ) ||
      !/^[^/]+\/[a-zA-Z0-9._-]+$/.test(binding.magpieAccountId)
    )
      configError("magpieAccountId must be a provider/account pin");
    const key = binding.accountKey;
    if (keys.has(key) || pins.has(binding.magpieAccountId))
      configError("duplicate account binding");
    pins.add(binding.magpieAccountId);
    keys.add(key);
    if (
      binding.label !== undefined &&
      (typeof binding.label !== "string" ||
        !binding.label.trim() ||
        /[\p{C}]/u.test(binding.label))
    )
      configError("label");
    return {
      provider: binding.provider,
      accountKey: binding.accountKey,
      magpieAccountId: binding.magpieAccountId,
      ...(typeof binding.label === "string" ? { label: binding.label } : {}),
    };
  });
  return {
    endpoint,
    tokenFile: data.tokenFile,
    accounts: accounts.filter((binding) =>
      providers.includes(binding.provider),
    ),
    maxReadingAgeSeconds,
  };
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

// Keep upstream bodies, URLs, account names and credential text out of errors.
class GatewayFailure extends Error {}

async function readList(
  endpoint: URL,
  resource: "accounts" | "quotas",
  token: string,
): Promise<Row[]> {
  const signal = AbortSignal.timeout(15_000);
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/$/, "") + "/magpie/" + resource;
  const response = await providerFetch(
    url,
    {
      headers: { Authorization: "Bearer " + token },
      redirect: "error",
      signal,
    },
    { direct: isLoopback(endpoint) },
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new GatewayFailure("magpie_http_" + response.status);
  }
  const bytes = await readBoundedResponseBody(
    response,
    signal,
    (code) => new GatewayFailure(code),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !record(parsed) ||
    parsed.object !== "list" ||
    !Array.isArray(parsed.data) ||
    !parsed.data.every(record)
  )
    throw new GatewayFailure("magpie_invalid_response");
  return parsed.data;
}

function failure(
  binding: Binding,
  error: string,
  status: ProviderQuota["state"]["status"] = "unavailable",
  refreshedAt?: string,
): ProviderQuota {
  return {
    provider: binding.provider,
    accountKey: binding.accountKey,
    label: binding.label ?? binding.accountKey,
    source: "magpie",
    windows: [],
    state: {
      status,
      stale: false,
      error,
      sourcesTried: ["magpie"],
      ...(refreshedAt ? { refreshedAt } : {}),
    },
  };
}

/** Resolve inventory pins anew on each call. Quotas carry user + provider, never the pin. */
export async function magpieReadings(
  config: Config,
): Promise<(binding: Binding, now: number) => ProviderQuota> {
  try {
    const bytes = await readBoundedFile(config.tokenFile, 8192).catch(
      (error: unknown) => {
        throw new GatewayFailure(
          record(error) && error.code === "ENOENT"
            ? "magpie_token_missing"
            : "magpie_token_unreadable",
        );
      },
    );
    const token =
      bytes && bytes.length <= 8192
        ? usableLiteralSecret(bytes.toString("utf8").trim())
        : undefined;
    if (!token) throw new GatewayFailure("magpie_token_invalid");
    const [inventory, quotas] = await Promise.all([
      readList(config.endpoint, "accounts", token),
      readList(config.endpoint, "quotas", token),
    ]);
    return (binding, now) => {
      const wire = wireProviders[binding.provider];
      const profiles = inventory.filter(
        (profile) => profile.provider === wire && profile.kind === "account",
      );
      const pins = profiles.filter(
        (profile) => profile.pin === binding.magpieAccountId,
      );
      const account = pins[0];
      if (
        pins.length !== 1 ||
        !account ||
        account.pin !== wire + "/" + account.id ||
        typeof account.user !== "string" ||
        !account.user.trim() ||
        account.on !== true
      )
        return failure(binding, "magpie_account_unavailable");
      const matches = quotas.filter(
        (quota) =>
          quota.provider === wire &&
          quota.kind === "subscription" &&
          !quota.from &&
          quota.user === account.user,
      );
      if (
        profiles.filter((profile) => profile.user === account.user).length !==
          1 ||
        matches.length > 1
      )
        return failure(binding, "magpie_ambiguous_account");
      if (!matches.length) return failure(binding, "magpie_quota_missing");
      return reading(binding, matches[0], now, config.maxReadingAgeSeconds);
    };
  } catch (error) {
    const code =
      error instanceof GatewayFailure ? error.message : "magpie_read_failed";
    return (binding) => failure(binding, code, "error");
  }
}

function timestamp(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function reading(
  binding: Binding,
  row: Row,
  now: number,
  maxAge: number,
): ProviderQuota {
  const refreshedAt = timestamp(row.readAt);
  if (row.error)
    return failure(binding, "magpie_quota_error", "error", refreshedAt);
  if (!refreshedAt || Date.parse(refreshedAt) > now)
    return failure(binding, "magpie_observation_time_invalid");
  const windows = quotaWindows(binding.provider, row.windows);
  if (!windows?.length)
    return failure(
      binding,
      "magpie_windows_unavailable",
      "unavailable",
      refreshedAt,
    );
  const result: ProviderQuota = {
    provider: binding.provider,
    accountKey: binding.accountKey,
    label: binding.label ?? binding.accountKey,
    source: "magpie",
    windows,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt,
      sourcesTried: ["magpie"],
    },
  };
  const servable = servableStaleWindows(result, now);
  let reason: string | undefined;
  if (row.readError) reason = "magpie_read_error";
  else if (row.readDeferred || row.asOf || row.stale)
    reason = "magpie_cached_observation";
  else if (servable.length !== windows.length) reason = "magpie_window_expired";
  else if (now - Date.parse(refreshedAt) > maxAge * 1000)
    reason = "magpie_observation_too_old";
  if (reason) {
    result.windows = servable;
    result.state = {
      ...result.state,
      status: servable.length ? "stale" : "unavailable",
      stale: servable.length > 0,
      error: reason,
    };
  }
  return result;
}

type WindowDefinition = [
  id: string,
  kind: QuotaWindow["kind"],
  seconds: number,
];
const fiveHours = 5 * 60 * 60;
const week = 7 * 24 * 60 * 60;
const windowIds: Record<Provider, Record<string, WindowDefinition>> = {
  claude: {
    "5 hours": ["five_hour", "session", fiveHours],
    "7 days": ["seven_day", "weekly", week],
    "7 days · Fable": ["model:fable", "model", week],
  },
  codex: {
    "5 hours": ["five_hour", "session", fiveHours],
    "7 days": ["weekly", "weekly", week],
  },
  agy: {
    "Gemini · 5 hours": ["gemini_5h", "session", fiveHours],
    "Gemini · 7 days": ["gemini_weekly", "weekly", week],
    "Claude & GPT · 5 hours": ["claude_gpt_5h", "session", fiveHours],
    "Claude & GPT · 7 days": ["claude_gpt_weekly", "weekly", week],
  },
};

function percentage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function quotaWindows(
  provider: Provider,
  value: unknown,
): QuotaWindow[] | undefined {
  if (!Array.isArray(value)) return;
  const windows: QuotaWindow[] = [];
  for (const row of value) {
    if (!record(row)) return;
    if (provider === "codex" && row.lane === "images") continue;
    if (
      typeof row.name !== "string" ||
      !Object.hasOwn(windowIds[provider], row.name) ||
      row.text ||
      row.unlimited ||
      row.balance !== undefined ||
      row.lane
    )
      return;
    if (
      provider === "agy"
        ? row.pool !== row.name.split(" · ")[0]
        : Boolean(row.pool)
    )
      return;
    const [id, kind, windowSeconds] = windowIds[provider][row.name];
    if (
      windows.some((w) => w.id === id) ||
      !percentage(row.used) ||
      !percentage(row.remaining) ||
      Math.abs(row.used + row.remaining - 100) > 0.0001
    )
      return;
    const resetsAt = timestamp(row.resetsAt);
    if (row.resetsAt !== undefined && !resetsAt) return;
    windows.push({
      id,
      label: row.name,
      kind,
      windowSeconds,
      percentUsed: row.used,
      percentRemaining: row.remaining,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}
