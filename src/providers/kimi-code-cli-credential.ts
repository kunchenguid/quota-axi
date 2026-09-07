import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { publishKimiReadingContextId } from "./kimi-cache-context.js";
import {
  type KimiCodeConfigSource,
  type KimiCodeEnvironment,
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
        /** The configuration exists but never named the slot to read. */
        | "environment_unconfirmed"
        | "invalid"
        | "error"
        | "unsupported_storage"
        | "unrecognized_region"
        | "invalid_config";
    };

export type KimiCodeCliCredentialInspection =
  KimiCodeCliCredentialResolution["status"];

/**
 * One reading of `config.toml`, shared by everything a single run derives from
 * it: which slot to open, which host that slot's token is good for, and which
 * cache identity the resulting numbers belong to.
 *
 * They travel together because a second read cannot be assumed to describe the
 * same environment. Kimi Code rewrites this file on login, so re-deriving the
 * cache identity after the quota request could observe the deployment the user
 * just switched to and stamp the previous one's numbers with it.
 */
export type KimiCodeSelection = {
  /** The Kimi Code home the environment was read from and is read against. */
  codeHome: string;
  environment: KimiCodeEnvironment;
  /**
   * Opaque, deterministic cache provenance for this environment, so a cached
   * snapshot is only reused for the deployment and slot that produced it, and
   * only by an environment this reader established rather than assumed.
   *
   * It hashes the resolved environment rather than the configuration text. The
   * table this reader parses also holds Kimi Code's literal `api_key`, and a
   * digest of those bytes would put a credential-derived value in the cache
   * file and let a secret decide observable behaviour. Resolving first also
   * keeps the identifier stable across edits that select the same environment,
   * so changing an unrelated setting does not throw away usable stale quota.
   */
  contextId: string;
};

export type KimiCodeCliCredentialSource = {
  /** Reads `config.toml` once; every consumer of that run shares this answer. */
  select(): Promise<KimiCodeSelection>;
  resolve(
    selection: KimiCodeSelection,
  ): Promise<KimiCodeCliCredentialResolution>;
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

  const select = async (): Promise<KimiCodeSelection> => {
    const codeHome = kimiCodeHome(dependencies);
    const environment = resolveKimiCodeEnvironment(
      await readConfigSource(codeHome, dependencies),
    );
    const selection: KimiCodeSelection = {
      codeHome,
      environment,
      contextId: contextIdFor(codeHome, environment),
    };
    publishKimiReadingContextId(selection.contextId);
    return selection;
  };

  const inspect = async (): Promise<KimiCodeCliCredentialInspection> =>
    (await resolveCredential(await select(), dependencies)).status;

  return {
    select,
    resolve: (selection) => resolveCredential(selection, dependencies),
    inspect,
  };
}

async function resolveCredential(
  selection: KimiCodeSelection,
  dependencies: CredentialSourceDependencies,
): Promise<KimiCodeCliCredentialResolution> {
  const { codeHome, environment } = selection;
  if (environment.status !== "resolved") return { status: environment.status };
  /**
   * A slot nobody named is not a slot to read. Whatever sits at a location this
   * reader merely guessed at describes that guess and not the user's account:
   * its absence is no sign-out, its expiry is no sign-out, and its contents are
   * no reading either - the credential of a deployment the user has since left
   * would be reported as the current one's quota. Both halves of that follow
   * from the same missing evidence, so both stop here rather than at the branch
   * that happens to be reached first.
   */
  if (!environment.confirmed) return { status: "environment_unconfirmed" };

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

/** See `KimiCodeSelection.contextId` for why this hashes the environment. */
function contextIdFor(
  codeHome: string,
  environment: KimiCodeEnvironment,
): string {
  const home = resolve(codeHome.normalize("NFC"));
  /**
   * An assumed environment is its own identity, never the confirmed one it
   * happens to name. The default slot and host are what a configuration this
   * reader could not walk falls back to, and they are also exactly what a
   * mainland login resolves to - so sharing an identifier would hand a global
   * user the mainland account's cached numbers as their own stale reading, the
   * substitution this scoping exists to prevent. Reading a guessed slot's
   * contents and reusing a snapshot filed under it are the same claim, and the
   * evidence for neither exists. Nothing is ever written under this identity
   * either: an unconfirmed environment stops before any credential is opened,
   * so it produces no reading of its own to file here.
   */
  const slot =
    environment.status === "resolved" && !environment.confirmed
      ? "assumed-slot"
      : "slot";
  const selection =
    environment.status === "resolved"
      ? `${slot}:${environment.credentialFileName}\nbase:${environment.baseUrl}`
      : `unresolved:${environment.status}`;
  return createHash("sha256")
    .update(`kimi-code-home:${home}\n${selection}`)
    .digest("hex");
}

/**
 * What this reader managed to obtain of `config.toml`.
 *
 * An absent file, one it cannot open, and one past the size cap all lead to the
 * same verdict on purpose. In each, quota-axi does not know what the
 * configuration says - the state a file also reaches when `scanConfig` stops
 * partway - and states that share their evidence should share their verdict.
 * Giving them one is deliberate, not an oversight.
 *
 * That verdict is the unsuffixed `kimi-code` slot on the default deployment,
 * because Kimi Code writes that slot only for that deployment, so slot and host
 * match by construction and no token can reach the wrong region.
 *
 * They are still reported apart, because the verdict and the confidence in it
 * are different questions. Nothing exists to describe an environment when the
 * file is absent, so the only slot Kimi Code could have written is the default
 * one, and a mainland-China user with no configuration keeps the reading they
 * have always had. A file that exists and cannot be taken in may name any slot,
 * so the same default is a guess rather than a reading, and nothing found at it
 * is reported either way - see the `confirmed` flag
 * `resolveKimiCodeEnvironment` returns and the check `resolveCredential` makes
 * on it.
 */
async function readConfigSource(
  codeHome: string,
  dependencies: CredentialSourceDependencies,
): Promise<KimiCodeConfigSource> {
  let contents: Buffer;
  try {
    contents = await dependencies.readConfigFile(
      join(codeHome, "config.toml"),
      CONFIG_FILE_LIMIT_BYTES,
    );
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "absent" }
      : { status: "unreadable" };
  }
  return contents.byteLength > CONFIG_FILE_LIMIT_BYTES
    ? { status: "unreadable" }
    : { status: "read", text: contents.toString("utf8") };
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
