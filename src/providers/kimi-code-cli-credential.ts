import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  kimiCredentialPath,
  resolveKimiCodeEnvironment,
} from "./kimi-code-config.js";

export const KIMI_CODE_CLI_CREDENTIAL_SOURCE = "kimi-code-cli";

const CREDENTIAL_FILE_LIMIT_BYTES = 64 * 1024;
const CONFIG_FILE_LIMIT_BYTES = 256 * 1024;
const MINIMUM_FRESHNESS_SECONDS = 60;

export type KimiCodeCliCredentialResolution =
  /** The base URL travels with the token: it is the one this slot logged in against. */
  | { status: "available"; accessToken: string; baseUrl: string }
  | {
      status: "expired";
      /**
       * The stored access token and the base URL it was issued for, present so
       * a bounded read-only liveness probe can test it despite the stored
       * expiry field. Probe use only; never log or render.
       */
      accessToken?: string;
      baseUrl?: string;
    }
  | {
      status:
        | "missing"
        | "invalid"
        | "error"
        | "unsupported_storage"
        | "unrecognized_region"
        | "invalid_config";
    };

export type KimiCodeCliCredentialInspection =
  KimiCodeCliCredentialResolution["status"];

export type KimiCodeCliCredentialSource = {
  resolve(): Promise<KimiCodeCliCredentialResolution>;
  inspect(): Promise<KimiCodeCliCredentialInspection>;
};

type CredentialSourceDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  now: () => number;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  /**
   * Separate from `readFile` because the two reads mean different things: this
   * one is non-secret configuration whose absence is normal, and a failure to
   * read it is a configuration problem rather than a credential I/O error.
   */
  readConfigFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export function createKimiCodeCliCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): KimiCodeCliCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    now: Date.now,
    readFile: readBoundedFile,
    readConfigFile: readBoundedFile,
    ...overrides,
  };

  const inspect = async (): Promise<KimiCodeCliCredentialInspection> =>
    (await resolveCredential(dependencies)).status;

  return {
    resolve: () => resolveCredential(dependencies),
    inspect,
  };
}

async function resolveCredential(
  dependencies: CredentialSourceDependencies,
): Promise<KimiCodeCliCredentialResolution> {
  const codeHome = kimiCodeHome(dependencies);
  const environment = resolveKimiCodeEnvironment(
    await readConfigText(codeHome, dependencies),
  );
  if (environment.status !== "resolved") return { status: environment.status };

  const path = kimiCredentialPath(codeHome, environment.credentialFileName);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, CREDENTIAL_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > CREDENTIAL_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const credential = objectValue(parsed);
  const accessToken =
    typeof credential?.access_token === "string"
      ? credential.access_token.trim()
      : "";
  const expiresAt = expirySeconds(credential?.expires_at);
  if (!accessToken || expiresAt === undefined) return { status: "invalid" };
  if (expiresAt <= dependencies.now() / 1_000 + MINIMUM_FRESHNESS_SECONDS) {
    return { status: "expired", accessToken, baseUrl: environment.baseUrl };
  }
  return { status: "available", accessToken, baseUrl: environment.baseUrl };
}

function kimiCodeHome(
  dependencies: Pick<
    CredentialSourceDependencies,
    "environment" | "homeDirectory"
  >,
): string {
  const configuredHome = nonempty(dependencies.environment.KIMI_CODE_HOME);
  return (
    configuredHome ??
    join(
      nonempty(dependencies.environment.HOME) ?? dependencies.homeDirectory(),
      ".kimi-code",
    )
  );
}

/**
 * An opaque, deterministic cache-provenance identifier for the Kimi Code
 * environment selected by the current process, so a cached snapshot is only
 * reused for the deployment and slot that produced it.
 *
 * It hashes the resolved environment rather than the configuration text. The
 * table this reader parses also holds Kimi Code's literal `api_key`, and a
 * digest of those bytes would put a credential-derived value in the cache file
 * and let a secret decide observable behaviour. Resolving first also keeps the
 * identifier stable across edits that select the same environment, so changing
 * an unrelated setting does not throw away usable stale quota.
 */
export function kimiCredentialContextId(): string {
  const codeHome = resolve(
    kimiCodeHome({
      environment: process.env,
      homeDirectory: homedir,
    }).normalize("NFC"),
  );
  const environment = resolveKimiCodeEnvironment(configTextSync(codeHome));
  const selection =
    environment.status === "resolved"
      ? `slot:${environment.credentialFileName}\nbase:${environment.baseUrl}`
      : `unresolved:${environment.status}`;
  return createHash("sha256")
    .update(`kimi-code-home:${codeHome}\n${selection}`)
    .digest("hex");
}

/** `readConfigText`'s rule, for the callers that cannot await it. */
function configTextSync(codeHome: string): string | undefined {
  let file: number;
  try {
    file = openSync(join(codeHome, "config.toml"), "r");
  } catch {
    return undefined;
  }
  try {
    const contents = new Uint8Array(CONFIG_FILE_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const read = readSync(
        file,
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
    }
    return offset > CONFIG_FILE_LIMIT_BYTES
      ? undefined
      : Buffer.from(contents.buffer, contents.byteOffset, offset).toString(
          "utf8",
        );
  } catch {
    return undefined;
  } finally {
    closeSync(file);
  }
}

/**
 * The configuration text, or nothing when this reader has none to offer.
 *
 * An absent file, one it cannot open, and one past the size cap all return
 * nothing on purpose. They are a single epistemic state - quota-axi does not
 * know what the configuration says - which is also the state a file reaches
 * when `scanConfig` stops partway, and states that share their evidence should
 * share their verdict. Giving them one is deliberate, not an oversight.
 *
 * That verdict is the unsuffixed `kimi-code` slot on the default deployment,
 * because Kimi Code writes that slot only for that deployment, so slot and host
 * match by construction and no token can reach the wrong region.
 *
 * KNOWN LIMIT, UNVERIFIED: the verdict also assumes Kimi Code removes that slot
 * when a user switches deployments. Confirming that needs a real installation
 * to switch, which was not available. If a stale `kimi-code.json` does survive a
 * move to a global login, a user whose `config.toml` later becomes unreadable
 * would get a fresh reading of the previous mainland account. The cost is a
 * wrong account's numbers, not a token sent to another region. The fallback is
 * kept because removing it would strand a signed-in mainland user whose
 * `config.toml` this reader cannot walk, and reporting an accurate number for
 * them is the obligation this weighs against.
 */
async function readConfigText(
  codeHome: string,
  dependencies: CredentialSourceDependencies,
): Promise<string | undefined> {
  let contents: Buffer;
  try {
    contents = await dependencies.readConfigFile(
      join(codeHome, "config.toml"),
      CONFIG_FILE_LIMIT_BYTES,
    );
  } catch {
    return undefined;
  }
  return contents.byteLength > CONFIG_FILE_LIMIT_BYTES
    ? undefined
    : contents.toString("utf8");
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const contents = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await file.read(
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return Buffer.from(contents.buffer, contents.byteOffset, offset);
  } finally {
    await file.close();
  }
}

function expirySeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
