import { homedir } from "node:os";
import { join } from "node:path";

const PI_PROVIDER_ID = "kimi-coding";
const UNRESOLVED_CREDENTIAL = "\0";

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
        const apiKey = usableApiKey(resolved?.auth.apiKey);
        return apiKey !== undefined
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
        const resolved = await runtime.getAuth(PI_PROVIDER_ID);
        return usableApiKey(resolved?.auth.apiKey) === undefined
          ? "missing"
          : "available";
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
  const storedCredential = readStoredCredential(
    PI_PROVIDER_ID,
    join(piAgentDirectory(), "auth.json"),
  );
  if (storedCredential !== undefined) {
    await credentials.modify(PI_PROVIDER_ID, async () => storedCredential);
  }
  return ModelRuntime.create({
    credentials,
    allowModelNetwork: false,
    modelsPath: null,
  });
}

function usableApiKey(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value === UNRESOLVED_CREDENTIAL ||
    value.trim().length === 0 ||
    value.startsWith("!") ||
    value.includes("$") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
}

function piAgentDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === undefined || configured.length === 0) {
    return join(homedir(), ".pi", "agent");
  }
  if (configured === "~") return homedir();
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
}
