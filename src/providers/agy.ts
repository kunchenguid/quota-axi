import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../types.js";
import { failedProvider } from "./common.js";

export const agyAdapter: ProviderAdapter = {
  id: "agy",
  label: "Antigravity",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return failedProvider({
    provider: "agy",
    label: "Antigravity",
    status: "unavailable",
    error: "Antigravity/agy is not running",
    sourcesTried: ["loopback"],
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return {
    provider: "agy",
    sources: [{ source: "loopback", status: "missing" }],
  };
}
