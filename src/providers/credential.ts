import { execFileText } from "../lib/process.js";

export type ProviderCredential = { value: string; source: "env" | "keychain" };

export async function readProviderCredential(
  name: string,
  allowKeychainPrompt: boolean,
): Promise<ProviderCredential | undefined> {
  const env = process.env[name]?.trim();
  if (env) return { value: env, source: "env" };
  if (process.platform !== "darwin" || !allowKeychainPrompt) return undefined;
  try {
    const value = (
      await execFileText(
        "security",
        ["find-generic-password", "-a", name, "-s", "bridge-secrets", "-w"],
        5_000,
      )
    ).trim();
    return value ? { value, source: "keychain" } : undefined;
  } catch {
    return undefined;
  }
}

export function credentialSource(
  name: string,
  credential: ProviderCredential | undefined,
  allowKeychainPrompt: boolean,
): {
  source: string;
  status: "available" | "missing" | "skipped";
  credentialPresent?: boolean;
  error?: string;
} {
  if (credential)
    return {
      source: credential.source,
      status: "available",
      credentialPresent: true,
    };
  if (process.platform === "darwin" && !allowKeychainPrompt)
    return {
      source: "keychain",
      status: "skipped",
      error: "keychain_prompt_required",
    };
  return {
    source: "env/keychain",
    status: "missing",
    credentialPresent: false,
  };
}
