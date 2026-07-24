import { execFileText } from "../lib/process.js";
import { nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../types.js";
import { failedProvider, statusFromError, successProvider } from "./common.js";

export const inferenceAdapter: ProviderAdapter = {
  id: "inference.net",
  label: "Inference.net",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  try {
    const raw = await execFileText(
      "inf",
      ["training", "list", "--json", "--limit", "100"],
      15_000,
    );
    const parsed = JSON.parse(raw) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : ((parsed as { items?: unknown[] }).items ?? []);
    return successProvider({
      provider: "inference.net",
      label: "Inference.net",
      source: "official-cli",
      plan: `training_jobs_observed:${items.length}`,
      windows: [],
      refreshedAt: nowIso(),
      sourcesTried: ["official-cli"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failedProvider({
      provider: "inference.net",
      label: "Inference.net",
      status: statusFromError(message),
      error: message,
      sourcesTried: ["official-cli"],
      source: "official-cli",
    });
  }
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return {
    provider: "inference.net",
    sources: [
      {
        source: "official-cli",
        status: "missing",
        error: "run `inf auth` or configure the inf CLI",
      },
    ],
  };
}
