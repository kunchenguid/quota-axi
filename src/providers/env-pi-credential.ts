import { readJsonFileResult } from "../lib/fs.js";
import { readBoundedResponseBody } from "../lib/http.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderId,
  ProviderStatus,
} from "../types.js";

/**
 * The credential shape shared by adapters whose whole credential surface is a
 * literal bearer key in an environment variable or a provider entry in Pi's
 * auth.json.
 */
export type EnvPiCredentialResolution =
  | { status: "available"; key: string; source: string; path?: string }
  | {
      status: "missing" | "invalid" | "error";
      source: string;
      path?: string;
    };

export type EnvPiCredentialSources = {
  envVar: string;
  envSource: string;
  piProviderId: string;
  piSource: string;
};

export function resolveEnvPiCredentials(
  sources: EnvPiCredentialSources,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path = resolvePiAuthFilePath(),
): EnvPiCredentialResolution[] {
  const credentials: EnvPiCredentialResolution[] = [];
  const envKey = usableLiteralSecret(environment[sources.envVar]);
  credentials.push(
    envKey
      ? { status: "available", key: envKey, source: sources.envSource }
      : { status: "missing", source: sources.envSource },
  );
  const result = readJsonFileResult(path);
  if (result.status === "missing") {
    credentials.push({ status: "missing", source: sources.piSource, path });
  } else if (result.status === "invalid") {
    credentials.push({
      status: result.error === "file_read_error" ? "error" : "invalid",
      source: sources.piSource,
      path,
    });
  } else {
    credentials.push(
      extractPiKeyCredential(
        result.value,
        sources.piProviderId,
        sources.piSource,
        path,
      ),
    );
  }
  return credentials;
}

export function extractPiKeyCredential(
  value: unknown,
  piProviderId: string,
  piSource: string,
  path: string,
): EnvPiCredentialResolution {
  const classified = classifyPiAuthEntry(value, piProviderId);
  if (classified.status !== "present")
    return { status: classified.status, source: piSource, path };
  const key = [
    classified.entry.key,
    classified.entry.apiKey,
    classified.entry.api_key,
    classified.entry.access,
    classified.entry.token,
  ]
    .map(usableLiteralSecret)
    .find((candidate): candidate is string => candidate !== undefined);
  if (key) return { status: "available", key, source: piSource, path };
  return { status: "invalid", source: piSource, path };
}

export function credentialCandidates(
  credential: () => EnvPiCredentialResolution | EnvPiCredentialResolution[],
): EnvPiCredentialResolution[] {
  const credentials = credential();
  return Array.isArray(credentials) ? credentials : [credentials];
}

export type KeyCredentialFailure = {
  status: ProviderStatus;
  error: string;
};

export function keyCredentialFailure(
  provider: ProviderId,
  resolution: Exclude<EnvPiCredentialResolution, { status: "available" }>,
): KeyCredentialFailure {
  return {
    status: resolution.status === "error" ? "error" : "auth_required",
    error:
      resolution.status === "missing"
        ? `${provider}_credential_unavailable`
        : resolution.status === "invalid"
          ? `${provider}_credential_invalid`
          : `${provider}_credential_resolution_failed`,
  };
}

/**
 * A credential-resolution error outranks an earlier absence diagnostic, and an
 * empirical endpoint rejection outranks both: only a real answer or a real
 * rejection should ever name the account's state.
 */
export function preferCredentialFailure(
  current: KeyCredentialFailure | undefined,
  next: KeyCredentialFailure,
): KeyCredentialFailure {
  if (
    !current ||
    (current.status === "auth_required" && next.status === "error")
  )
    return next;
  return current;
}

export function preferRemoteAuthFailure(
  current: KeyCredentialFailure | undefined,
  error: string,
): KeyCredentialFailure {
  if (current?.status === "error") return current;
  return { status: "auth_required", error };
}

export function inspectEnvPiAuth(
  provider: ProviderId,
  credentials: EnvPiCredentialResolution[],
): AuthProviderReport {
  const sources: AuthSourceReport[] = credentials.map((resolution) => ({
    source: resolution.source,
    path: resolution.path,
    status:
      resolution.status === "available"
        ? "available"
        : resolution.status === "missing"
          ? "missing"
          : resolution.status === "error"
            ? "error"
            : "invalid",
    ...(resolution.status === "error" || resolution.status === "invalid"
      ? { error: keyCredentialFailure(provider, resolution).error }
      : {}),
  }));
  return { provider, sources };
}

export function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function statusFromRequestError(error: string): ProviderStatus {
  if (error === "provider_auth_rejected") return "auth_required";
  if (error === "provider_rate_limited") return "rate_limited";
  return "error";
}

export class KeyEndpointError extends Error {
  readonly retryAfter?: string;

  constructor(code: string, retryAfter?: string) {
    super(code);
    this.retryAfter = retryAfter;
  }
}

export async function requestKeyEndpoint(
  url: string,
  key: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + key,
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403)
      throw new KeyEndpointError("provider_auth_rejected");
    if (response.status === 429)
      throw new KeyEndpointError(
        "provider_rate_limited",
        retryAfterToIso(response.headers.get("retry-after")),
      );
    if (!response.ok)
      throw new KeyEndpointError("provider_error:" + response.status);
    const body = await readBoundedResponseBody(
      response,
      controller.signal,
      (code) => new KeyEndpointError(code),
    );
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new KeyEndpointError("invalid_json");
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new KeyEndpointError("provider_timeout");
    if (error instanceof KeyEndpointError) throw error;
    throw new KeyEndpointError("network_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
