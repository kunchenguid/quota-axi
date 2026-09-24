import { AxiError } from "axi-sdk-js";
import { MODEL_CATALOG_PROVIDER_IDS } from "./models.js";
import { parseProviders } from "./providers/index.js";
import {
  PROVIDER_IDS,
  type IntelligenceBucket,
  type ModelSortKey,
  type ProviderId,
} from "./types.js";

export type QuotaFlags = {
  providers: ProviderId[];
  /**
   * True when `--provider` named the providers. Named providers are never
   * folded out of the human report or omitted from default TOON.
   */
  explicitProviders: boolean;
  json: boolean;
  full: boolean;
  tui: boolean;
  allowKeychainPrompt: boolean;
  /** Permit one bounded Claude inference to recover env-token quota headers. */
  allowClaudeInference: boolean;
  /**
   * Opt out of delegated credential refresh: never run a vendor CLI's own
   * non-interactive refresh command, even when a stored access token is
   * expired. Defaults to false, so the quota path recovers on its own.
   */
  noCredentialRefresh: boolean;
  /** Restrict quota discovery to the selected provider's profile file. */
  profileOnly: boolean;
  /** Live `--tui` refresh interval; the caller applies the default. */
  refreshSeconds?: number;
  /** Render one `--tui` frame and exit instead of staying live. */
  once: boolean;
  /** Start `--tui` with providers that are not set up drawn as full cards. */
  all: boolean;
  /**
   * Oldest successful reading a read may reuse instead of asking the vendor;
   * `0` always asks. Absent, the caller falls back to {@link MAX_AGE_ENV}.
   */
  maxAgeSeconds?: number;
};

/** Refresh bounds: fast enough to feel live, slow enough to stay polite. */
export const MIN_REFRESH_SECONDS = 30;
export const MAX_REFRESH_SECONDS = 86_400;

/**
 * Fresh reuse is opt-in: with neither `--max-age` nor this variable every
 * read asks the vendor. A host whose consumer polls per decision (a
 * dispatcher, a test run) sets it once to absorb bursts that would otherwise
 * trip a vendor's usage-endpoint rate limit; the flag wins over it.
 */
export const MAX_AGE_ENV = "QUOTA_AXI_MAX_AGE";
export const MAX_MAX_AGE_SECONDS = 3_600;

export type ModelsFlags = QuotaFlags & {
  intelligence?: IntelligenceBucket;
  sort?: ModelSortKey;
};

/**
 * Parse the flags shared by the `quota` and `auth` commands. Command routing is
 * owned by {@link runAxiCli}; this only interprets the flags that follow.
 * `--full` is accepted by both commands but only consumed by `quota`.
 */
export function parseFlags(args: string[]): QuotaFlags {
  const flags = parseCommonFlags(args);
  if (flags.intelligence !== undefined || flags.sort !== undefined) {
    throw new AxiError(
      "--intelligence and --sort are only supported by the models command",
      "VALIDATION_ERROR",
      ["Run `quota-axi models --help` for supported models flags"],
    );
  }
  return flags;
}

/** Parse flags accepted by the `models` evidence-join command. */
export function parseModelsFlags(args: string[]): ModelsFlags {
  const flags = parseCommonFlags(args, MODEL_CATALOG_PROVIDER_IDS);
  if (flags.allowClaudeInference) {
    throw new AxiError(
      "--allow-claude-inference is only supported by the quota command",
      "VALIDATION_ERROR",
      ["Run `quota-axi --provider claude --allow-claude-inference`"],
    );
  }
  if (flags.profileOnly) {
    throw new AxiError(
      "--profile-only is only supported by the quota command",
      "VALIDATION_ERROR",
      [
        "Set CLAUDE_CONFIG_DIR and run `quota-axi --provider claude --profile-only --full --json`",
      ],
    );
  }
  if (flags.tui) {
    throw new AxiError(
      "--tui is only supported by the quota command",
      "VALIDATION_ERROR",
      ["Run `quota-axi --tui` for the human quota report"],
    );
  }
  const unsupported = flags.providers.find(
    (provider) => !MODEL_CATALOG_PROVIDER_IDS.includes(provider),
  );
  if (unsupported) {
    throw new AxiError(
      `models does not support provider: ${unsupported}`,
      "VALIDATION_ERROR",
      [`Supported model providers: ${MODEL_CATALOG_PROVIDER_IDS.join(", ")}`],
    );
  }
  return flags;
}

function parseCommonFlags(
  args: string[],
  defaultProviders?: readonly ProviderId[],
): ModelsFlags {
  const providerValues: string[] = [];
  let json = false;
  let full = false;
  let tui = false;
  let once = false;
  let all = false;
  let refreshSeconds: number | undefined;
  let maxAgeSeconds: number | undefined;
  let allowKeychainPrompt = false;
  let allowClaudeInference = false;
  let noCredentialRefresh = false;
  let profileOnly = false;
  let intelligence: IntelligenceBucket | undefined;
  let sort: ModelSortKey | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--tui") {
      tui = true;
      continue;
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--refresh") {
      refreshSeconds = parseRefreshValue(args[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith("--refresh=")) {
      refreshSeconds = parseRefreshValue(arg.slice("--refresh=".length));
      continue;
    }
    if (arg === "--max-age") {
      maxAgeSeconds = parseMaxAgeValue(args[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith("--max-age=")) {
      maxAgeSeconds = parseMaxAgeValue(arg.slice("--max-age=".length));
      continue;
    }
    if (arg === "--allow-keychain-prompt") {
      allowKeychainPrompt = true;
      continue;
    }
    if (arg === "--allow-claude-inference") {
      allowClaudeInference = true;
      continue;
    }
    if (arg === "--no-credential-refresh") {
      noCredentialRefresh = true;
      continue;
    }
    if (arg === "--profile-only") {
      profileOnly = true;
      continue;
    }
    if (arg === "--intelligence") {
      intelligence = parseIntelligenceValue(args[index + 1], "--intelligence");
      index++;
      continue;
    }
    if (arg.startsWith("--intelligence=")) {
      intelligence = parseIntelligenceValue(
        arg.slice("--intelligence=".length),
        "--intelligence",
      );
      continue;
    }
    if (arg === "--sort") {
      sort = parseSortValue(args[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith("--sort=")) {
      sort = parseSortValue(arg.slice("--sort=".length));
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value) {
        throw new AxiError(
          "--provider requires a comma-separated provider list",
          "VALIDATION_ERROR",
          ["Pass --provider=... if the value begins with --"],
        );
      }
      providerValues.push(value);
      index++;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      providerValues.push(arg.slice("--provider=".length));
      continue;
    }
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `quota-axi --help` for supported commands and flags",
    ]);
  }

  if (tui && json) {
    throw new AxiError(
      "--tui and --json are mutually exclusive output modes",
      "VALIDATION_ERROR",
      [
        "Run `quota-axi --tui` for the human report or `quota-axi --json` for machine output",
      ],
    );
  }
  const liveOnlyFlag =
    refreshSeconds !== undefined ? "--refresh" : once ? "--once" : undefined;
  if (liveOnlyFlag && !tui) {
    throw new AxiError(
      `${liveOnlyFlag} is only supported with --tui`,
      "VALIDATION_ERROR",
      ["Run `quota-axi --tui --refresh 5m` for the live human report"],
    );
  }
  if (all && !tui) {
    throw new AxiError(
      "--all is only supported with --tui",
      "VALIDATION_ERROR",
      ["Run `quota-axi --tui --all` to draw every provider as a full card"],
    );
  }

  return {
    providers: parseProviderScope(providerValues, defaultProviders),
    explicitProviders: providerValues.length > 0,
    json,
    full,
    tui,
    once,
    all,
    allowKeychainPrompt,
    allowClaudeInference,
    noCredentialRefresh,
    profileOnly,
    ...(refreshSeconds !== undefined ? { refreshSeconds } : {}),
    ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}),
    ...(intelligence ? { intelligence } : {}),
    ...(sort ? { sort } : {}),
  };
}

function parseIntelligenceValue(
  value: string | undefined,
  flag: string,
): IntelligenceBucket {
  if (value === "high" || value === "medium" || value === "low") return value;
  throw new AxiError(
    `${flag} requires high, medium, or low`,
    "VALIDATION_ERROR",
    ["Run `quota-axi models --help` for supported models flags"],
  );
}

/** A whole-unit duration (`45s`, `5m`, `1h`) or bare seconds. */
function parseDurationSeconds(value: string | undefined): number | undefined {
  const match = /^(\d{1,7})(s|m|h)?$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const multiplier = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  return Number(match[1]) * multiplier;
}

/** Accept a whole-unit duration (`45s`, `5m`, `1h`) or bare seconds. */
function parseRefreshValue(value: string | undefined): number {
  const seconds = parseDurationSeconds(value);
  if (seconds === undefined) {
    throw new AxiError(
      "--refresh requires a duration such as 30s, 5m, or 1h",
      "VALIDATION_ERROR",
      ["Pass --refresh=... if the value begins with --"],
    );
  }
  if (seconds < MIN_REFRESH_SECONDS || seconds > MAX_REFRESH_SECONDS) {
    throw new AxiError(
      `--refresh must be between ${MIN_REFRESH_SECONDS}s and ${MAX_REFRESH_SECONDS / 3600}h`,
      "VALIDATION_ERROR",
      ["Provider quota windows do not move fast enough for tighter polling"],
    );
  }
  return seconds;
}

/**
 * The host-wide fresh-reuse bound from {@link MAX_AGE_ENV}, or `undefined`
 * when it is unset or blank. A value that does not parse fails the read
 * rather than silently turning reuse off.
 */
export function readMaxAgeEnv(
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const value = environment[MAX_AGE_ENV];
  if (value === undefined || value.trim() === "") return undefined;
  return parseMaxAgeValue(value, MAX_AGE_ENV);
}

/** Accept `0`, a whole-unit duration (`45s`, `2m`, `1h`), or bare seconds. */
function parseMaxAgeValue(
  value: string | undefined,
  name = "--max-age",
): number {
  const seconds = parseDurationSeconds(value);
  if (seconds === undefined) {
    throw new AxiError(
      `${name} requires a duration such as 0, 90s, or 2m`,
      "VALIDATION_ERROR",
      [
        name === "--max-age"
          ? "Pass --max-age 0 to always read the vendor"
          : `Unset ${name} to always read the vendor`,
      ],
    );
  }
  if (seconds > MAX_MAX_AGE_SECONDS) {
    throw new AxiError(
      `${name} must be at most ${MAX_MAX_AGE_SECONDS / 60}m`,
      "VALIDATION_ERROR",
      ["Reuse only absorbs bursts; it is not a long-lived cache"],
    );
  }
  return seconds;
}

function parseSortValue(value: string | undefined): ModelSortKey {
  if (value === "runway") return value;
  throw new AxiError(
    "--sort requires a supported comparator",
    "VALIDATION_ERROR",
    ["Supported sort keys: runway"],
  );
}

/**
 * Union every `--provider` value in first-seen order. `parseProviders`
 * already de-duplicates within one value; this de-duplicates across repeats,
 * so `--provider zai --provider codex` equals `--provider zai,codex`.
 */
function parseProviderScope(
  values: readonly string[],
  defaultProviders?: readonly ProviderId[],
): ProviderId[] {
  if (values.length === 0) {
    return defaultProviders ? [...defaultProviders] : parseProviders(undefined);
  }
  try {
    const seen = new Set<ProviderId>();
    const providers: ProviderId[] = [];
    for (const value of values) {
      if (!value.trim()) continue;
      for (const provider of parseProviders(value)) {
        if (seen.has(provider)) continue;
        seen.add(provider);
        providers.push(provider);
      }
    }
    return providers.length > 0
      ? providers
      : defaultProviders
        ? [...defaultProviders]
        : parseProviders(undefined);
  } catch (error) {
    throw new AxiError(
      error instanceof Error ? error.message : "unsupported provider",
      "VALIDATION_ERROR",
      [`Supported providers: ${PROVIDER_IDS.join(", ")}`],
    );
  }
}
