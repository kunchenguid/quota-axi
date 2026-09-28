import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  copilotCliKeychainAccessMarkerPath,
  ensurePrivateParent,
  readBoundedFile,
} from "../lib/fs.js";
import { execFileText } from "../lib/process.js";
import { readWindowsGenericPassword } from "../lib/windows-credential.js";
import type { AuthSourceReport, ProviderOptions } from "../types.js";
import { traceInput } from "../lib/input-trace.js";

export const COPILOT_CLI_SOURCE = "copilot-cli:keychain";
/**
 * The native source's skips that establish nothing about the account either
 * way: a configuration that names no account it can confirm, a platform
 * without a supported secure store, and a selected account whose secure-store
 * value is still waiting on consent. None of them proves Copilot absent.
 */
export const COPILOT_CLI_UNCONFIRMED_ACCOUNT = "selected_account_unconfirmed";
export const COPILOT_CLI_SECURE_STORE_UNSUPPORTED = "secure_store_unsupported";
export const COPILOT_CLI_KEYCHAIN_PROMPT_REQUIRED = "keychain_prompt_required";
const SERVICE = "copilot-cli";
const FILE_LIMIT = 1024 * 1024;
const TOKEN_LIMIT = 16 * 1024;

function copilotCliConfigPath(home: string): string {
  return join(home, "config.json");
}

function secureStoreSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

type Identity = { host: string; login: string; account: string };
export type CopilotCliCredentialResolution =
  | {
      status: "resolved";
      token: string;
      report: AuthSourceReport;
      silent: false;
    }
  | {
      status: "absent" | "structurally_invalid" | "unsupported" | "read_error";
      report: AuthSourceReport;
      silent: boolean;
    };

type Dependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDirectory: () => string;
  readFile: typeof readBoundedFile;
  run: typeof execFileText;
  readWindows: typeof readWindowsGenericPassword;
  hasGrant: (path: string, account: string) => boolean;
  recordGrant: (path: string, account: string) => void;
};

type CopilotCliSelection =
  | {
      kind: "identity";
      identity: Identity;
      path: string;
      home: string;
      defaultHome: string;
    }
  | {
      kind: "blocked";
      resolution: CopilotCliCredentialResolution;
      silent: boolean;
    };

function dependencies(overrides: Partial<Dependencies>): Dependencies {
  return {
    environment: process.env,
    platform: process.platform,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    run: execFileText,
    readWindows: readWindowsGenericPassword,
    hasGrant: (path, account) => {
      const marker = copilotCliKeychainAccessMarkerPath(path, SERVICE, account);
      traceInput(marker);
      return existsSync(marker);
    },
    recordGrant,
    ...overrides,
  };
}

function unresolved(
  path: string,
  status: Exclude<CopilotCliCredentialResolution["status"], "resolved">,
  error?: string,
  silent = false,
): CopilotCliCredentialResolution {
  return {
    status,
    silent,
    report: {
      source: COPILOT_CLI_SOURCE,
      path,
      status:
        status === "absent"
          ? "missing"
          : status === "unsupported"
            ? "skipped"
            : status === "read_error"
              ? "error"
              : "invalid",
      ...(error ? { error } : {}),
      ...(status === "absent" || silent ? {} : { credentialPresent: true }),
    },
  };
}

/**
 * The local selection phase, and the single owner of whether the native source
 * could have named an account at all. A platform with no secure store, a
 * missing config, and a config that selects no account are all structural
 * silence: they can neither speak for the provider nor stand for a different
 * selection than a legacy snapshot's.
 */
async function selectIdentity(
  deps: Dependencies,
): Promise<CopilotCliSelection> {
  const defaultHome = join(deps.homeDirectory(), ".copilot");
  const home = deps.environment.COPILOT_HOME || defaultHome;
  const path = copilotCliConfigPath(home);
  const blocked = (
    status: Exclude<CopilotCliCredentialResolution["status"], "resolved">,
    error: string | undefined,
    structural: boolean,
  ): CopilotCliSelection => {
    const silent = structural || !secureStoreSupported(deps.platform);
    return {
      kind: "blocked",
      resolution: unresolved(path, status, error, silent),
      silent,
    };
  };
  let raw: Buffer;
  try {
    raw = await deps.readFile(path, FILE_LIMIT);
  } catch (error) {
    return code(error) === "ENOENT"
      ? blocked("absent", undefined, true)
      : blocked("read_error", "file_read_error", false);
  }
  if (raw.byteLength > FILE_LIMIT)
    return blocked("structurally_invalid", "config_too_large", false);
  let identity: Identity | undefined;
  try {
    identity = selectedIdentity(raw);
  } catch {
    return blocked("structurally_invalid", "credentials_invalid", false);
  }
  if (!identity)
    return blocked("unsupported", COPILOT_CLI_UNCONFIRMED_ACCOUNT, true);
  if (!secureStoreSupported(deps.platform))
    return blocked("unsupported", COPILOT_CLI_SECURE_STORE_UNSUPPORTED, true);
  return { kind: "identity", identity, path, home, defaultHome };
}

/**
 * Default-profile binding: macOS CLI 1.0.87-0 uses service copilot-cli and
 * account `${host}:${login}`. Windows CLI 1.0.86 uses a generic credential with
 * target `${account}.copilot-cli` and username `${account}`. See README for
 * the empirical validation boundary. Refuse unverified
 * selectors instead of guessing item names or trying another user's item.
 * `presenceOnly: "silence"` decides only whether the source could have
 * answered, without reading a secret value.
 */
export async function resolveCopilotCliCredential(
  options: ProviderOptions,
  presenceOnly: boolean | "silence" = false,
  overrides: Partial<Dependencies> = {},
): Promise<CopilotCliCredentialResolution> {
  const deps = dependencies(overrides);
  const selection = await selectIdentity(deps);
  if (selection.kind === "blocked") return selection.resolution;
  const { identity, path, home, defaultHome } = selection;
  const state = (
    status: Exclude<CopilotCliCredentialResolution["status"], "resolved">,
    error?: string,
  ): CopilotCliCredentialResolution =>
    unresolved(
      path,
      status,
      error,
      error === COPILOT_CLI_KEYCHAIN_PROMPT_REQUIRED,
    );
  if (resolve(home) !== resolve(defaultHome))
    return state("unsupported", "copilot_home_unsupported");
  // Presence only: never inspect an environment credential's value. A blank
  // value selects nothing, so it preserves the stored path.
  if (
    [
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "COPILOT_GH_HOST",
      "GH_HOST",
    ].some((name) => (deps.environment[name] ?? "").trim() !== "")
  ) {
    return state("unsupported", "environment_selection_unsupported");
  }
  if (identity.host !== "https://github.com")
    return state("unsupported", "selected_host_unsupported");
  const consented =
    options.allowKeychainPrompt || deps.hasGrant(path, identity.account);
  // Only whether this source could have answered is wanted: a consented read
  // would, so the secret is not fetched just to be discarded.
  if (presenceOnly === "silence" && consented)
    return state("unsupported", "value_read_deferred");
  const valueAllowed = presenceOnly === false && consented;
  let value: string;
  if (deps.platform === "win32") {
    // CredRead returns the secret along with metadata. Until consent is
    // established, inspect only the CLI's selected identity, never the vault.
    if (!valueAllowed)
      return state("unsupported", COPILOT_CLI_KEYCHAIN_PROMPT_REQUIRED);
    const result = await deps.readWindows(
      { target: `${identity.account}.${SERVICE}`, username: identity.account },
      { run: deps.run, systemRoot: deps.environment.SystemRoot },
    );
    if (result.status !== "resolved")
      return state(
        result.reason === "credential_format_unsupported"
          ? "structurally_invalid"
          : "read_error",
        result.reason,
      );
    value = result.value;
  } else {
    const args = [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      identity.account,
    ];
    try {
      value = await deps.run(
        "/usr/bin/security",
        valueAllowed ? [...args, "-w"] : args,
        valueAllowed ? 60_000 : 5_000,
        TOKEN_LIMIT,
      );
    } catch (error) {
      const failure = error as {
        killed?: boolean;
        signal?: unknown;
        code?: unknown;
      } | null;
      if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        return state("structurally_invalid", "credential_format_unsupported");
      if (failure?.killed || failure?.signal)
        return state("read_error", "keychain_prompt_timeout");
      if (code(error) === 44)
        return state("read_error", "keychain_item_unavailable");
      return state(
        "read_error",
        valueAllowed
          ? "keychain_access_denied"
          : "keychain_presence_check_failed",
      );
    }
  }
  if (!valueAllowed)
    return state("unsupported", COPILOT_CLI_KEYCHAIN_PROMPT_REQUIRED);
  const token = value.replace(/[\r\n]+$/, "");
  if (
    token.length > TOKEN_LIMIT ||
    !/^(?:gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(token)
  ) {
    return state("structurally_invalid", "credential_format_unsupported");
  }
  // A profile switch while the OS prompt was open invalidates this reading.
  try {
    const current = await deps.readFile(path, FILE_LIMIT);
    if (
      current.byteLength > FILE_LIMIT ||
      selectedIdentity(current)?.account !== identity.account
    ) {
      return state("unsupported", "selected_account_changed");
    }
  } catch {
    return state("read_error", COPILOT_CLI_UNCONFIRMED_ACCOUNT);
  }
  deps.recordGrant(path, identity.account);
  return {
    status: "resolved",
    token,
    silent: false,
    report: {
      source: COPILOT_CLI_SOURCE,
      path,
      status: "available",
      credentialPresent: true,
    },
  };
}

function selectedIdentity(raw: Buffer): Identity | undefined {
  // Only full-line comments are removed: an https:// host must remain intact.
  const data: unknown = JSON.parse(
    raw
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  );
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error();
  const selected = (data as Record<string, unknown>).lastLoggedInUser;
  if (!selected || typeof selected !== "object" || Array.isArray(selected))
    return undefined;
  const { host, login } = selected as Record<string, unknown>;
  if (
    typeof host !== "string" ||
    typeof login !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)
  )
    return undefined;
  // No canonicalization of the lookup key: only the observed host spelling is
  // supported, even when another spelling would normalize to github.com.
  return { host, login, account: `${host}:${login}` };
}

function code(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

function recordGrant(path: string, account: string): void {
  try {
    const file = copilotCliKeychainAccessMarkerPath(path, SERVICE, account);
    if (existsSync(file)) return;
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "granted\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    /* A marker failure cannot change the successful credential read. */
  }
}
