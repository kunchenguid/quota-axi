import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames } from "./common.js";

export const MIMO_ENV_SOURCE = "env:MIMO_API_KEY";
const LABEL = "MiMo";

type MimoCredentialResolution =
  | { status: "available"; key: string; source: string }
  | { status: "missing" | "invalid"; source: string };

type MimoDependencies = {
  credential: () => MimoCredentialResolution;
  now: () => number;
};

export function resolveMimoCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MimoCredentialResolution {
  const key = usableLiteralSecret(environment.MIMO_API_KEY);
  return key
    ? { status: "available", key, source: MIMO_ENV_SOURCE }
    : { status: "missing", source: MIMO_ENV_SOURCE };
}

export function createMimoAdapter(
  overrides: Partial<MimoDependencies> = {},
): ProviderAdapter {
  const dependencies: MimoDependencies = {
    credential: () => resolveMimoCredential(),
    now: Date.now,
    ...overrides,
  };
  return {
    id: "mimo",
    label: LABEL,
    fetchQuota: () => fetchQuotaWithDependencies(dependencies),
    inspectAuth: () => inspectAuthWithDependencies(dependencies),
  };
}

export const mimoAdapter = createMimoAdapter();
export const createMiMoAdapter = createMimoAdapter;

async function fetchQuotaWithDependencies(
  dependencies: MimoDependencies,
): Promise<ProviderQuota> {
  const resolution = dependencies.credential();
  const attempts: SourceAttempt[] = [
    {
      source: resolution.source,
      status: resolution.status === "available" ? "success" : "skipped",
      ...(resolution.status !== "available"
        ? { error: "mimo_credential_unavailable" }
        : {}),
    },
  ];
  if (resolution.status !== "available") {
    return failedProvider({
      provider: "mimo",
      label: LABEL,
      status: "auth_required",
      error: "mimo_credential_unavailable",
      source: "unavailable",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  // MiMo's provider-owned Pi setup establishes API-key authentication, while
  // its quota display is dashboard/cookie based. Do not attach cookies or
  // probe an inference endpoint merely to manufacture a quota reading.
  return {
    provider: "mimo",
    label: LABEL,
    source: "api",
    windows: [],
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
    },
    attempts,
  };
}

async function inspectAuthWithDependencies(
  dependencies: MimoDependencies,
): Promise<AuthProviderReport> {
  const resolution = dependencies.credential();
  const source: AuthSourceReport = {
    source: resolution.source,
    status: resolution.status === "available" ? "available" : "missing",
    ...(resolution.status === "available" ? { credentialPresent: true } : {}),
  };
  return { provider: "mimo", sources: [source] };
}

export type { MimoCredentialResolution };
