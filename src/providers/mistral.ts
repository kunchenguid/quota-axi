import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { readJsonFileResult } from "../lib/fs.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames } from "./common.js";
import {
  extractPiKeyCredential,
  inspectEnvPiAuth,
  keyCredentialFailure,
  preferCredentialFailure,
  pushEnvCredential,
  pushPiReadCredential,
  type EnvPiCredentialResolution,
  type KeyCredentialFailure,
} from "./env-pi-credential.js";

export const MISTRAL_ENV_SOURCE = "env:MISTRAL_API_KEY";
export const MISTRAL_PI_SOURCE = "pi:mistral";
export const MISTRAL_POLYTOKEN_SOURCE = "polytoken:mistral";

const LABEL = "Mistral";

type MistralDependencies = {
  credential: () => EnvPiCredentialResolution[];
  now: () => number;
};

export function resolvePolytokenConfigPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory: () => string = homedir,
): string {
  const configured = environment.XDG_CONFIG_HOME?.trim();
  const base =
    configured && configured.length > 0
      ? configured
      : join(homeDirectory(), ".config");
  return join(base, "polytoken", "config.yaml");
}

export function resolveMistralCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  piPath = resolvePiAuthFilePath(environment),
  polytokenPath = resolvePolytokenConfigPath(environment),
): EnvPiCredentialResolution[] {
  const credentials: EnvPiCredentialResolution[] = [];
  pushEnvCredential(
    credentials,
    environment,
    "MISTRAL_API_KEY",
    MISTRAL_ENV_SOURCE,
  );
  pushPiReadCredential(
    credentials,
    readJsonFileResult(piPath),
    MISTRAL_PI_SOURCE,
    piPath,
    (value) =>
      extractPiKeyCredential(value, "mistral", MISTRAL_PI_SOURCE, piPath),
  );
  credentials.push(readPolytokenMistralCredential(polytokenPath));
  return credentials;
}

/**
 * Polytoken stores one static key per catalog provider in its YAML config.
 * The document also holds other providers' keys, so only the
 * `providers.mistral.auth` entry is extracted and retained; the parsed
 * document is discarded and the key is never logged, rendered, or cached.
 * Only a `static_key` entry with a usable literal key is a credential.
 */
export function readPolytokenMistralCredential(
  path: string,
): EnvPiCredentialResolution {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    return code === "ENOENT"
      ? { status: "missing", source: MISTRAL_POLYTOKEN_SOURCE, path }
      : { status: "error", source: MISTRAL_POLYTOKEN_SOURCE, path };
  }
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch {
    return { status: "invalid", source: MISTRAL_POLYTOKEN_SOURCE, path };
  }
  const providers = record(record(parsed)?.providers);
  if (!providers || !("mistral" in providers)) {
    return { status: "missing", source: MISTRAL_POLYTOKEN_SOURCE, path };
  }
  const auth = record(record(providers.mistral)?.auth);
  const key =
    auth?.type === "static_key" ? usableLiteralSecret(auth.key) : undefined;
  return key
    ? { status: "available", key, source: MISTRAL_POLYTOKEN_SOURCE, path }
    : { status: "invalid", source: MISTRAL_POLYTOKEN_SOURCE, path };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function createMistralAdapter(
  overrides: Partial<MistralDependencies> = {},
): ProviderAdapter {
  const dependencies: MistralDependencies = {
    credential: () => resolveMistralCredentials(),
    now: Date.now,
    ...overrides,
  };
  return {
    id: "mistral",
    label: LABEL,
    fetchQuota: () => fetchQuotaWithDependencies(dependencies),
    inspectAuth: () => inspectAuthWithDependencies(dependencies),
  };
}

export const mistralAdapter = createMistralAdapter();

async function fetchQuotaWithDependencies(
  dependencies: MistralDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let failure: KeyCredentialFailure | undefined;

  for (const resolution of dependencies.credential()) {
    if (resolution.status === "available") {
      attempts.push({ source: resolution.source, status: "success" });

      // Mistral exposes no read-only usage, billing, or balance endpoint
      // for a standard API key (the Admin API is Enterprise-only and needs
      // a separate admin key), so a usable key is model authentication,
      // not a quota read. Do not probe an inference endpoint merely to
      // harvest its rate-limit headers and manufacture a quota reading.
      return {
        provider: "mistral",
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

    const local = keyCredentialFailure("mistral", resolution);
    attempts.push({
      source: resolution.source,
      status: resolution.status === "missing" ? "skipped" : "failed",
      error: local.error,
      ...(resolution.status === "invalid" || resolution.status === "error"
        ? { credentialPresent: true }
        : {}),
    });
    failure = preferCredentialFailure(failure, local);
  }

  const final = failure ?? {
    status: "auth_required" as const,
    error: "mistral_credential_unavailable",
  };
  return failedProvider({
    provider: "mistral",
    label: LABEL,
    status: final.status,
    error: final.error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuthWithDependencies(
  dependencies: MistralDependencies,
): Promise<AuthProviderReport> {
  const report = inspectEnvPiAuth("mistral", dependencies.credential());
  return {
    ...report,
    sources: report.sources.map((source) =>
      source.status === "available" ||
      source.status === "invalid" ||
      source.status === "error"
        ? { ...source, credentialPresent: true }
        : source,
    ),
  };
}
