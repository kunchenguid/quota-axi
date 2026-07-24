import { nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../types.js";
import { successProvider } from "./common.js";

export const nvidiaAdapter: ProviderAdapter = {
  id: "nvidia",
  label: "NVIDIA NIM",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return successProvider({
    provider: "nvidia",
    label: "NVIDIA NIM",
    source: "local-diagnostic",
    plan: "free-tier-40-rpm",
    windows: [],
    refreshedAt: nowIso(),
    sourcesTried: ["local-diagnostic"],
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return {
    provider: "nvidia",
    sources: [
      {
        source: "local-diagnostic",
        status: "available",
        error:
          "40 RPM limit is configured locally; account usage is not queryable",
      },
    ],
  };
}
