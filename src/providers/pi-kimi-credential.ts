const PI_PROVIDER_ID = "kimi-coding";

export type KimiCredentialResolution =
  | { status: "available"; apiKey: string }
  | { status: "missing" }
  | { status: "unsupported" }
  | { status: "error" };

export type KimiCredentialInspection =
  | Exclude<KimiCredentialResolution["status"], "available">
  | "available";

export type KimiCredentialBroker = {
  resolve(): Promise<KimiCredentialResolution>;
  inspect(): Promise<KimiCredentialInspection>;
};

type PiModelRuntime = {
  listCredentials(): Promise<readonly { providerId: string; type: string }[]>;
  getAuth(providerId: string): Promise<
    | {
        auth: { apiKey?: string; headers?: unknown; baseUrl?: unknown };
        source?: unknown;
      }
    | undefined
  >;
  checkAuth(providerId: string): Promise<{ type: string } | undefined>;
};

type BrokerDependencies = {
  loadRuntime: () => Promise<PiModelRuntime>;
};

export function createPiKimiCredentialBroker(
  dependencies: BrokerDependencies = { loadRuntime: loadPiRuntime },
): KimiCredentialBroker {
  return {
    async resolve(): Promise<KimiCredentialResolution> {
      try {
        const runtime = await dependencies.loadRuntime();
        const storedType = await storedCredentialType(runtime);
        if (storedType !== undefined && storedType !== "api_key") {
          return { status: "unsupported" };
        }
        const resolved = await runtime.getAuth(PI_PROVIDER_ID);
        const apiKey = resolved?.auth.apiKey;
        return typeof apiKey === "string" && apiKey.trim().length > 0
          ? { status: "available", apiKey }
          : { status: "missing" };
      } catch {
        return { status: "error" };
      }
    },

    async inspect(): Promise<KimiCredentialInspection> {
      try {
        const runtime = await dependencies.loadRuntime();
        const storedType = await storedCredentialType(runtime);
        if (storedType !== undefined && storedType !== "api_key") {
          return "unsupported";
        }
        return (await runtime.checkAuth(PI_PROVIDER_ID))
          ? "available"
          : "missing";
      } catch {
        return "error";
      }
    },
  };
}

async function storedCredentialType(
  runtime: PiModelRuntime,
): Promise<string | undefined> {
  return (await runtime.listCredentials()).find(
    (credential) => credential.providerId === PI_PROVIDER_ID,
  )?.type;
}

async function loadPiRuntime(): Promise<PiModelRuntime> {
  const [{ ModelRuntime, readStoredCredential }, { InMemoryCredentialStore }] =
    await Promise.all([
      import("@earendil-works/pi-coding-agent"),
      import("@earendil-works/pi-ai"),
    ]);
  const credentials = new InMemoryCredentialStore();
  const storedCredential = readStoredCredential(PI_PROVIDER_ID);
  if (storedCredential !== undefined) {
    await credentials.modify(PI_PROVIDER_ID, async () => storedCredential);
  }
  return ModelRuntime.create({
    credentials,
    allowModelNetwork: false,
    modelsPath: null,
  });
}
