import { readFileSync } from "node:fs";
import { cpaEnvFilePath } from "../lib/reuse-context.js";
import type { ProviderId } from "../types.js";

// CLIProxyAPI settings only. The cache consults them, so this module stays
// free of the provider adapters and their process and network imports.

export type CpaConfig = { baseUrl: string; key: string };
export type CpaConfigError = { error: string };

function envFileValues(path: string): Record<string, string> {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match =
        /^\s*(CPA_BASE_URL|CPA_MANAGEMENT_KEY)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
    }
    return values;
  } catch {
    return {};
  }
}

export function readCpaConfig(
  environment: Record<string, string | undefined> = process.env,
): CpaConfig | CpaConfigError | undefined {
  const file = envFileValues(cpaEnvFilePath(environment));
  const baseUrl = (environment.CPA_BASE_URL ?? file.CPA_BASE_URL ?? "").trim();
  const key = (
    environment.CPA_MANAGEMENT_KEY ??
    file.CPA_MANAGEMENT_KEY ??
    ""
  ).trim();
  if (!baseUrl || !key) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: "cpa_base_url_invalid" };
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  )
    return { error: "cpa_base_url_requires_https" };
  return { baseUrl: url.toString().replace(/\/$/, ""), key };
}

/** Whether `provider` is read from a configured (or misconfigured) CPA pool. */
export function cpaPoolConfigured(
  provider: ProviderId,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return (
    (provider === "claude" || provider === "codex") &&
    readCpaConfig(environment) !== undefined
  );
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}
