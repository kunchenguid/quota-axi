export const ZAI_API_KEY_CREDENTIAL_SOURCE = "zai-api-key-env";

export type ZaiApiKeyCredentialResolution =
  | { status: "available"; apiKey: string }
  | { status: "missing" };

export type ZaiApiKeyCredentialInspection =
  ZaiApiKeyCredentialResolution["status"];

export type ZaiApiKeyCredentialSource = {
  resolve(): Promise<ZaiApiKeyCredentialResolution>;
  inspect(): Promise<ZaiApiKeyCredentialInspection>;
};

type CredentialSourceDependencies = {
  environment: () => Readonly<Record<string, string | undefined>>;
};

/**
 * The fallback credential source for the Z.ai Coding Plan provider: a
 * literal `ZAI_API_KEY` environment variable, read in place. There is no
 * file to open and nothing to refresh or write.
 */
export function createZaiApiKeyCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): ZaiApiKeyCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    // Read lazily so a recording environment installed after this factory
    // runs (test/reuse-context.test.ts) still observes the lookup.
    environment: () => process.env,
    ...overrides,
  };

  const resolve = async (): Promise<ZaiApiKeyCredentialResolution> =>
    resolveCredential(dependencies);

  return {
    resolve,
    inspect: async () => (await resolve()).status,
  };
}

function resolveCredential(
  dependencies: CredentialSourceDependencies,
): ZaiApiKeyCredentialResolution {
  const raw = dependencies.environment().ZAI_API_KEY;
  const apiKey = usableLiteralSecret(raw);
  return apiKey !== undefined
    ? { status: "available", apiKey }
    : { status: "missing" };
}

function usableLiteralSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return trimmed;
}
