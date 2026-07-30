import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  SourceAttempt,
} from "../types.js";
import { failedProvider, successProvider } from "./common.js";

const ENV_SOURCE = "sub2api-env";
const CODEX_SOURCE = "codex-config";
const CONFIG_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type Sub2apiCredential = {
  baseUrl: URL;
  apiKey: string;
  source: typeof ENV_SOURCE | typeof CODEX_SOURCE;
  path?: string;
};

type CredentialResolution =
  | { status: "available"; credential: Sub2apiCredential }
  | {
      status: "missing" | "invalid" | "error";
      source: typeof ENV_SOURCE | typeof CODEX_SOURCE;
      path?: string;
      error: string;
    };

type Sub2apiDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  fetch: typeof globalThis.fetch;
  now: () => number;
  timeoutMs: number;
};

export type NormalizedSub2apiUsage = {
  isValid: boolean;
  remaining: number;
  unit: "usd" | "credits";
};

export function createSub2apiAdapter(
  overrides: Partial<Sub2apiDependencies> = {},
): ProviderAdapter {
  const dependencies: Sub2apiDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    fetch: globalThis.fetch,
    now: Date.now,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...overrides,
  };

  return {
    id: "sub2api",
    label: "sub2API",
    fetchQuota: (_options: ProviderOptions) => fetchQuota(dependencies),
    inspectAuth: (_options: ProviderOptions) => inspectAuth(dependencies),
  };
}

export const sub2apiAdapter = createSub2apiAdapter();

export function normalizeSub2apiUsage(
  raw: unknown,
): NormalizedSub2apiUsage | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const quota = objectValue(data.quota);
  const remaining =
    numberValue(data.remaining) ??
    numberValue(quota?.remaining) ??
    numberValue(data.balance);
  if (remaining === undefined) return undefined;

  const isValid =
    booleanValue(data.is_active) ?? booleanValue(data.isValid) ?? true;
  const rawUnit = stringValue(data.unit) ?? stringValue(quota?.unit) ?? "USD";
  return {
    isValid,
    remaining,
    unit: rawUnit.toLowerCase() === "usd" ? "usd" : "credits",
  };
}

async function fetchQuota(
  dependencies: Sub2apiDependencies,
): Promise<ProviderQuota> {
  const resolution = await resolveCredential(dependencies);
  if (resolution.status !== "available") {
    const attempt: SourceAttempt = {
      source: resolution.source,
      status: resolution.status === "error" ? "failed" : "skipped",
      error: resolution.error,
    };
    return failedProvider({
      provider: "sub2api",
      label: "sub2API",
      status: resolution.status === "error" ? "error" : "auth_required",
      error: "sub2API configuration or API key required",
      sourcesTried: [resolution.source],
      attempts: [attempt],
    });
  }

  const { credential } = resolution;
  const attempts: SourceAttempt[] = [
    { source: credential.source, status: "failed" },
  ];
  try {
    const usage = await requestUsage(credential, dependencies);
    if (!usage.isValid) {
      throw new Sub2apiFailure(
        "sub2api_account_inactive",
        "sub2API account is inactive",
        "auth_required",
      );
    }
    attempts[0] = { source: credential.source, status: "success" };
    return successProvider({
      provider: "sub2api",
      label: "sub2API",
      source: "api",
      windows: [],
      credits: { remaining: usage.remaining, unit: usage.unit },
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: [credential.source],
      attempts,
    });
  } catch (error) {
    const failure =
      error instanceof Sub2apiFailure
        ? error
        : new Sub2apiFailure(
            "sub2api_request_failed",
            "sub2API quota request failed",
            "error",
          );
    attempts[0] = {
      source: credential.source,
      status: "failed",
      error: failure.code,
    };
    return failedProvider({
      provider: "sub2api",
      label: "sub2API",
      status: failure.status,
      error: failure.message,
      retryAfter: failure.retryAfter,
      sourcesTried: [credential.source],
      attempts,
    });
  }
}

async function inspectAuth(
  dependencies: Sub2apiDependencies,
): Promise<AuthProviderReport> {
  const resolution = await resolveCredential(dependencies);
  const source: AuthSourceReport =
    resolution.status === "available"
      ? {
          source: resolution.credential.source,
          path: resolution.credential.path,
          status: "available",
          credentialPresent: true,
        }
      : {
          source: resolution.source,
          path: resolution.path,
          status:
            resolution.status === "missing"
              ? "missing"
              : resolution.status === "error"
                ? "error"
                : "invalid",
          error: resolution.error,
        };
  return { provider: "sub2api", sources: [source] };
}

async function resolveCredential(
  dependencies: Sub2apiDependencies,
): Promise<CredentialResolution> {
  const envBaseUrl = nonempty(dependencies.environment.SUB2API_BASE_URL);
  const envApiKey = usableApiKey(dependencies.environment.SUB2API_API_KEY);
  if (envBaseUrl !== undefined || dependencies.environment.SUB2API_API_KEY) {
    if (!envBaseUrl || !envApiKey) {
      return {
        status: "invalid",
        source: ENV_SOURCE,
        error: "sub2api_environment_incomplete",
      };
    }
    const baseUrl = usableBaseUrl(envBaseUrl);
    return baseUrl
      ? {
          status: "available",
          credential: { baseUrl, apiKey: envApiKey, source: ENV_SOURCE },
        }
      : {
          status: "invalid",
          source: ENV_SOURCE,
          error: "sub2api_base_url_invalid",
        };
  }

  const codexHome = resolveCodexHome(dependencies);
  const configPath = join(codexHome, "config.toml");
  const config = await readToml(configPath, dependencies);
  if (config.status !== "success") {
    return {
      status: config.status,
      source: CODEX_SOURCE,
      path: configPath,
      error: config.error,
    };
  }
  if (stringValue(config.value.model_provider) !== "sub2api") {
    return {
      status: "missing",
      source: CODEX_SOURCE,
      path: configPath,
      error: "sub2api_not_active_codex_provider",
    };
  }
  const providerTable = objectValue(
    objectValue(config.value.model_providers)?.sub2api,
  );
  const baseUrl = usableBaseUrl(stringValue(providerTable?.base_url));
  if (!baseUrl) {
    return {
      status: "invalid",
      source: CODEX_SOURCE,
      path: configPath,
      error: "sub2api_base_url_invalid",
    };
  }

  const authPath = join(codexHome, "auth.json");
  const auth = await readJson(authPath, dependencies);
  if (auth.status !== "success") {
    return {
      status: auth.status,
      source: CODEX_SOURCE,
      path: authPath,
      error: auth.error,
    };
  }
  const apiKey = usableApiKey(auth.value.OPENAI_API_KEY);
  if (!apiKey) {
    return {
      status: "invalid",
      source: CODEX_SOURCE,
      path: authPath,
      error: "sub2api_api_key_invalid",
    };
  }
  return {
    status: "available",
    credential: {
      baseUrl,
      apiKey,
      source: CODEX_SOURCE,
      path: configPath,
    },
  };
}

async function requestUsage(
  credential: Sub2apiCredential,
  dependencies: Sub2apiDependencies,
): Promise<NormalizedSub2apiUsage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs);
  try {
    const response = await dependencies.fetch(usageUrl(credential.baseUrl), {
      method: "GET",
      headers: {
        authorization: `Bearer ${credential.apiKey}`,
        accept: "application/json",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      await cancelResponseBody(response);
      throw new Sub2apiFailure(
        "sub2api_credentials_rejected",
        "sub2API sign-in required",
        "auth_required",
      );
    }
    if (response.status === 429) {
      await cancelResponseBody(response);
      throw new Sub2apiFailure(
        "sub2api_rate_limited",
        "sub2API quota endpoint rate limited",
        "rate_limited",
        retryAfterToIso(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Sub2apiFailure(
        "sub2api_endpoint_failed",
        "sub2API quota endpoint failed",
        "error",
      );
    }
    const usage = normalizeSub2apiUsage(await readJsonBody(response));
    if (!usage) {
      throw new Sub2apiFailure(
        "sub2api_usage_invalid",
        "sub2API quota response is invalid",
        "error",
      );
    }
    return usage;
  } catch (error) {
    if (error instanceof Sub2apiFailure) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Sub2apiFailure(
        "sub2api_request_timeout",
        "sub2API quota request timed out",
        "error",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

function usageUrl(baseUrl: URL): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath.endsWith("/v1")
    ? `${basePath}/usage`
    : `${basePath}/v1/usage`;
  return url;
}

function usableBaseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
      return undefined;
    const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback)
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (/^\d+$/.test(declaredLength ?? "")) {
    if (BigInt(declaredLength!) > BigInt(RESPONSE_LIMIT_BYTES)) {
      await response.body?.cancel();
      throw new Sub2apiFailure(
        "sub2api_response_too_large",
        "sub2API quota response is too large",
        "error",
      );
    }
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new Sub2apiFailure(
          "sub2api_response_too_large",
          "sub2API quota response is too large",
          "error",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, length).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Sub2apiFailure(
      "sub2api_response_invalid_json",
      "sub2API quota response is invalid JSON",
      "error",
    );
  }
}

async function readToml(
  path: string,
  dependencies: Sub2apiDependencies,
): Promise<
  | { status: "success"; value: Record<string, unknown> }
  | { status: "missing" | "invalid" | "error"; error: string }
> {
  const contents = await readConfigFile(path, dependencies);
  if (contents.status !== "success") return contents;
  try {
    return {
      status: "success",
      value: parse(contents.value) as Record<string, unknown>,
    };
  } catch {
    return { status: "invalid", error: "codex_config_invalid_toml" };
  }
}

async function readJson(
  path: string,
  dependencies: Sub2apiDependencies,
): Promise<
  | { status: "success"; value: Record<string, unknown> }
  | { status: "missing" | "invalid" | "error"; error: string }
> {
  const contents = await readConfigFile(path, dependencies);
  if (contents.status !== "success") return contents;
  try {
    const parsed = objectValue(JSON.parse(contents.value) as unknown);
    return parsed
      ? { status: "success", value: parsed }
      : { status: "invalid", error: "codex_auth_invalid_json" };
  } catch {
    return { status: "invalid", error: "codex_auth_invalid_json" };
  }
}

async function readConfigFile(
  path: string,
  dependencies: Sub2apiDependencies,
): Promise<
  | { status: "success"; value: string }
  | { status: "missing" | "invalid" | "error"; error: string }
> {
  try {
    const contents = await dependencies.readFile(path, CONFIG_LIMIT_BYTES);
    if (contents.byteLength > CONFIG_LIMIT_BYTES) {
      return { status: "invalid", error: "codex_config_too_large" };
    }
    return { status: "success", value: contents.toString("utf8") };
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing", error: "codex_config_missing" }
      : { status: "error", error: "codex_config_read_failed" };
  }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return Buffer.from(buffer.buffer, buffer.byteOffset, offset);
  } finally {
    await file.close();
  }
}

function resolveCodexHome(dependencies: Sub2apiDependencies): string {
  const configured = nonempty(dependencies.environment.CODEX_HOME);
  if (!configured) return join(dependencies.homeDirectory(), ".codex");
  if (configured === "~") return dependencies.homeDirectory();
  if (configured.startsWith("~/")) {
    return join(dependencies.homeDirectory(), configured.slice(2));
  }
  return configured;
}

function usableApiKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

class Sub2apiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ProviderStatus,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}
