import { readJsonFileResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import {
  credentialCandidates,
  errorCode,
  inspectEnvPiAuth,
  KeyEndpointError,
  keyCredentialFailure,
  preferCredentialFailure,
  preferRemoteAuthFailure,
  pushEnvCredential,
  pushPiReadCredential,
  requestKeyEndpoint,
  statusFromRequestError,
  type EnvPiCredentialResolution,
  type KeyCredentialFailure,
} from "./env-pi-credential.js";
import { opencodeGoAuthFilePath } from "./opencode-go.js";

export const VENICE_RATE_LIMITS_URL =
  "https://api.venice.ai/api/v1/api_keys/rate_limits";
export const VENICE_BALANCE_URL =
  "https://api.venice.ai/api/v1/billing/balance";
const SOURCE = "opencode:auth.json";
const LABEL = "Venice";

type Dependencies = {
  credential: () => EnvPiCredentialResolution | EnvPiCredentialResolution[];
  adminKey: () => string | undefined;
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
export function resolveVeniceCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path = opencodeGoAuthFilePath(),
): EnvPiCredentialResolution[] {
  const candidates: EnvPiCredentialResolution[] = [];
  pushEnvCredential(
    candidates,
    environment,
    "VENICE_API_KEY",
    "env:VENICE_API_KEY",
  );
  pushPiReadCredential(
    candidates,
    readJsonFileResult(path),
    SOURCE,
    path,
    (value) => {
      const store = object(value);
      if (!store) return { status: "invalid", source: SOURCE, path };
      if (store.venice === undefined)
        return { status: "missing", source: SOURCE, path };
      const key = usableLiteralSecret(object(store.venice)?.key);
      return key
        ? { status: "available", key, source: SOURCE, path }
        : { status: "invalid", source: SOURCE, path };
    },
  );
  return candidates;
}

export function createVeniceAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const deps: Dependencies = {
    credential: () => resolveVeniceCredentials(),
    adminKey: () => usableLiteralSecret(process.env.VENICE_ADMIN_KEY),
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: 15_000,
    ...overrides,
  };
  return {
    id: "venice",
    label: LABEL,
    inspectAuth: async () =>
      inspectEnvPiAuth("venice", credentialCandidates(deps.credential)),
    fetchQuota: () => fetchQuota(deps),
  };
}
export const veniceAdapter = createVeniceAdapter();

async function fetchQuota(deps: Dependencies): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalFailure: KeyCredentialFailure | undefined;
  for (const resolution of credentialCandidates(deps.credential)) {
    if (resolution.status !== "available") {
      const failure = keyCredentialFailure("venice", resolution);
      attempts.push({
        source: resolution.source,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.error,
        ...(resolution.status !== "missing" ? { credentialPresent: true } : {}),
      });
      finalFailure = preferCredentialFailure(finalFailure, failure);
      continue;
    }
    try {
      const root = object(
        await requestKeyEndpoint(
          VENICE_RATE_LIMITS_URL,
          resolution.key,
          deps.fetch,
          deps.deadlineMs,
        ),
      );
      const data = object(root?.data);
      const balances = object(data?.balances);
      if (!balances) throw new Error("invalid_payload");
      const diem = amount(balances.DIEM);
      const usd = amount(balances.USD);
      const bundled = amount(balances.BUNDLED_CREDITS);
      if (diem === undefined && usd === undefined && bundled === undefined)
        throw new Error("invalid_balances");
      const windows: QuotaWindow[] = [];
      if (diem !== undefined) {
        const reset =
          typeof data?.nextEpochBegins === "string" &&
          Number.isFinite(Date.parse(data.nextEpochBegins))
            ? new Date(data.nextEpochBegins).toISOString()
            : undefined;
        const window: QuotaWindow = {
          id: "diem",
          label: "DIEM",
          kind: "credits",
          remainingCredits: diem,
          creditUnit: "DIEM",
          ...(reset ? { resetsAt: reset } : {}),
        };
        const admin = deps.adminKey();
        if (admin) {
          try {
            const billing = object(
              await requestKeyEndpoint(
                VENICE_BALANCE_URL,
                admin,
                deps.fetch,
                deps.deadlineMs,
              ),
            );
            const allocation = amount(billing?.diemEpochAllocation);
            if (
              allocation !== undefined &&
              allocation > 0 &&
              diem <= allocation
            ) {
              window.limitCredits = allocation;
              window.usedCredits = allocation - diem;
              window.percentUsed = (100 * (allocation - diem)) / allocation;
              window.percentRemaining = (100 * diem) / allocation;
            }
          } catch {
            /* Inference-key balances remain useful if optional admin access fails. */
          }
        }
        windows.push(window);
      }
      const wallets: { remaining: number; unit: "usd" | "diem" | "credits" }[] =
        [];
      if (usd !== undefined) wallets.push({ remaining: usd, unit: "usd" });
      if (diem !== undefined) wallets.push({ remaining: diem, unit: "diem" });
      if (bundled !== undefined)
        wallets.push({ remaining: bundled, unit: "credits" });
      const funded =
        wallets.find((wallet) => wallet.remaining > 0) ?? wallets[0];
      attempts.push({ source: resolution.source, status: "success" });
      return successProvider({
        provider: "venice",
        label: LABEL,
        source: "api",
        windows,
        ...(funded
          ? {
              credits: {
                ...funded,
                ...(wallets.length > 1 ? { balances: wallets } : {}),
              },
            }
          : {}),
        refreshedAt: new Date(deps.now()).toISOString(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      const code = errorCode(error);
      attempts.push({
        source: resolution.source,
        status: "failed",
        error: code,
      });
      if (code === "provider_auth_rejected") {
        finalFailure = preferRemoteAuthFailure(finalFailure, code);
        continue;
      }
      return failedProvider({
        provider: "venice",
        label: LABEL,
        status: statusFromRequestError(code),
        error: code,
        source: "unavailable",
        retryAfter:
          error instanceof KeyEndpointError ? error.retryAfter : undefined,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }
  }
  const failure = finalFailure ?? {
    status: "auth_required" as const,
    error: "venice_credential_unavailable",
  };
  return failedProvider({
    provider: "venice",
    label: LABEL,
    status: failure.status,
    error: failure.error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}
