import { providerFetch, readBoundedResponseBody } from "../lib/http.js";
import { retryAfterToIso } from "../lib/time.js";
import type { ProviderAdapter, ProviderQuota, QuotaWindow } from "../types.js";
import { failedProvider, successProvider } from "./common.js";
import {
  inspectEnvPiAuth,
  keyCredentialFailure,
  pushEnvCredential,
  type EnvPiCredentialResolution,
} from "./env-pi-credential.js";

export const OLLAMA_BALANCE_URL = "https://ollama.com/api/balance";
export const OLLAMA_ENV_SOURCE = "env:OLLAMA_API_KEY";
const LABEL = "Ollama Cloud";

type Dependencies = {
  credential: () => EnvPiCredentialResolution;
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
};

export function resolveOllamaCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EnvPiCredentialResolution {
  const credentials: EnvPiCredentialResolution[] = [];
  pushEnvCredential(
    credentials,
    environment,
    "OLLAMA_API_KEY",
    OLLAMA_ENV_SOURCE,
  );
  return credentials[0];
}

export function createOllamaAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: resolveOllamaCredential,
    fetch: providerFetch,
    now: () => Date.now(),
    deadlineMs: 15_000,
    ...overrides,
  };
  // Only simultaneous reads of the same offered key coalesce. No result or
  // credential survives completion, and different keys never share a reading.
  const pending = new Map<string, Promise<ProviderQuota>>();
  return {
    id: "ollama",
    label: LABEL,
    inspectAuth: async () =>
      inspectEnvPiAuth("ollama", [dependencies.credential()]),
    fetchQuota: async () => {
      const credential = dependencies.credential();
      if (credential.status !== "available") {
        const failure = keyCredentialFailure("ollama", credential);
        return failedProvider({
          provider: "ollama",
          label: LABEL,
          ...failure,
          sourcesTried: [OLLAMA_ENV_SOURCE],
          attempts: [
            {
              source: OLLAMA_ENV_SOURCE,
              status: credential.status === "missing" ? "skipped" : "failed",
              error: failure.error,
              ...(credential.status !== "missing"
                ? { credentialPresent: true }
                : {}),
            },
          ],
        });
      }
      const existing = pending.get(credential.key);
      if (existing) return existing;
      const reading = fetchBalance(dependencies, credential.key);
      pending.set(credential.key, reading);
      try {
        return await reading;
      } finally {
        pending.delete(credential.key);
      }
    },
  };
}

export const ollamaAdapter = createOllamaAdapter();

class BalanceError extends Error {
  constructor(
    code: string,
    readonly retryAfter?: string,
  ) {
    super(code);
  }
}

async function fetchBalance(
  dependencies: Dependencies,
  key: string,
): Promise<ProviderQuota> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new BalanceError("provider_timeout"));
    }, dependencies.deadlineMs);
  });
  try {
    const payload = await Promise.race([
      requestBalance(dependencies, key, controller.signal),
      expired,
    ]);
    const normalized = normalizeOllamaPayload(payload, dependencies.now());
    const report = successProvider({
      provider: "ollama",
      label: LABEL,
      source: "api",
      windows: normalized.windows,
      credits: normalized.credits,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: [OLLAMA_ENV_SOURCE],
      attempts: [{ source: OLLAMA_ENV_SOURCE, status: "success" }],
    });
    report.state.authStatus = "usable";
    if (normalized.untrustedWindowIds.length)
      report.state.untrustedWindowIds = normalized.untrustedWindowIds;
    return report;
  } catch (error) {
    // Never expose a transport exception or a vendor error body, even if it
    // echoes the offered key. Only our closed set of errors leaves this file.
    const code =
      error instanceof BalanceError ? error.message : "network_unavailable";
    const report = failedProvider({
      provider: "ollama",
      label: LABEL,
      status:
        code === "provider_auth_rejected"
          ? "auth_required"
          : code === "provider_rate_limited"
            ? "rate_limited"
            : "error",
      error: code,
      retryAfter: error instanceof BalanceError ? error.retryAfter : undefined,
      sourcesTried: [OLLAMA_ENV_SOURCE],
      attempts: [{ source: OLLAMA_ENV_SOURCE, status: "failed", error: code }],
    });
    if (code === "provider_auth_rejected") report.state.authStatus = "unusable";
    return report;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestBalance(
  dependencies: Dependencies,
  key: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await dependencies.fetch(OLLAMA_BALANCE_URL, {
    method: "GET",
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    credentials: "omit",
    redirect: "manual",
    signal,
  });
  if (signal.aborted || !response.ok) {
    void response.body?.cancel().catch(() => undefined);
    if (signal.aborted) throw new BalanceError("provider_timeout");
    if (response.status === 401)
      throw new BalanceError("provider_auth_rejected");
    if (response.status === 403)
      throw new BalanceError("ollama_account_suspended");
    if (response.status === 429) {
      const retry = response.headers.get("retry-after")?.trim();
      throw new BalanceError(
        "provider_rate_limited",
        retry && /^\d+$/.test(retry)
          ? retryAfterToIso(retry, dependencies.now())
          : undefined,
      );
    }
    if (response.status === 503)
      throw new BalanceError("ollama_balance_unavailable");
    if (response.status >= 300 && response.status < 400)
      throw new BalanceError("provider_redirect_refused");
    throw new BalanceError("provider_http_error");
  }
  const bytes = await readBoundedResponseBody(
    response,
    signal,
    (code) => new BalanceError(code),
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BalanceError("invalid_json");
  }
}

export type NormalizedOllamaPayload = {
  windows: QuotaWindow[];
  credits: NonNullable<ProviderQuota["credits"]>;
  untrustedWindowIds: string[];
};

/** Strict documented shapes only; no plan, identity, or unknown quota is inferred. */
export function normalizeOllamaPayload(
  raw: unknown,
  now: number,
): NormalizedOllamaPayload {
  const root = object(raw);
  const included = object(root?.included);
  const purchased = object(root?.purchased);
  if (
    !root ||
    !included ||
    !purchased ||
    !keys(root, ["included", "purchased"]) ||
    !keys(purchased, ["balance_usd"]) ||
    !amount(purchased.balance_usd)
  )
    invalid();
  const result: NormalizedOllamaPayload = {
    windows: [],
    credits: { remaining: purchased.balance_usd as number, unit: "usd" },
    untrustedWindowIds: [],
  };
  const modern = ["balance_usd", "allowance_usd", "period"].some(
    (key) => key in included,
  );
  if (modern) {
    if (
      !keys(included, ["balance_usd", "allowance_usd", "period"]) ||
      !amount(included.balance_usd) ||
      !amount(included.allowance_usd) ||
      included.balance_usd > included.allowance_usd
    )
      invalid();
    const period = object(included.period);
    const startsAt = instant(period?.from);
    const resetsAt = instant(period?.until);
    if (
      !period ||
      !keys(period, ["from", "until"]) ||
      !startsAt ||
      !resetsAt ||
      Date.parse(startsAt) > now ||
      Date.parse(startsAt) >= Date.parse(resetsAt)
    )
      invalid();
    if (Date.parse(resetsAt) <= now) {
      result.untrustedWindowIds.push("included_month");
    } else {
      const window: QuotaWindow = {
        id: "included_month",
        label: "Included monthly credits",
        kind: "monthly",
        limitUsd: included.allowance_usd,
        spentUsd: included.allowance_usd - included.balance_usd,
        startsAt,
        resetsAt,
      };
      if (included.allowance_usd > 0) {
        window.percentRemaining =
          100 * (included.balance_usd / included.allowance_usd);
        window.percentUsed = 100 - window.percentRemaining;
      } else result.untrustedWindowIds.push(window.id);
      result.windows.push(window);
    }
  } else {
    if (
      !keys(included, ["session", "weekly"]) ||
      !("session" in included || "weekly" in included)
    )
      invalid();
    for (const id of ["session", "weekly"] as const) {
      const row = object(included[id]);
      if (included[id] === undefined) {
        result.untrustedWindowIds.push(id);
        continue;
      }
      if (
        !row ||
        !keys(row, ["remaining_percent", "resets_at"]) ||
        !amount(row.remaining_percent) ||
        row.remaining_percent > 100
      )
        invalid();
      const resetsAt = instant(row.resets_at);
      if (!resetsAt) invalid();
      if (Date.parse(resetsAt) <= now) {
        result.untrustedWindowIds.push(id);
        continue;
      }
      result.windows.push({
        id,
        label: id === "session" ? "Session" : "Weekly",
        kind: id,
        percentRemaining: row.remaining_percent,
        percentUsed: 100 - row.remaining_percent,
        resetsAt,
      });
    }
  }
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function instant(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(value)
  )
    return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const parsed = new Date(timestamp).toISOString();
  // Date.parse normalizes impossible dates (e.g. February 30); never silently
  // turn malformed vendor cycle evidence into a different calendar boundary.
  return parsed.slice(0, 19) === value.slice(0, 19) ? parsed : undefined;
}
function invalid(): never {
  throw new BalanceError("ollama_invalid_schema");
}
