import { AxiError } from "axi-sdk-js";
import { annotateQuotaAdvice } from "./advice.js";
import {
  parseFlags,
  parseModelsFlags,
  readMaxAgeEnv,
  type QuotaFlags,
} from "./args.js";
import {
  fetchLockPathFor,
  isSnapshotFile,
  readReusableProviders,
  readSnapshotProviders,
  stampReadingInputs,
  writeCachedProviders,
} from "./cache.js";
import { takeFetchTurn } from "./lib/fetch-lock.js";
import { withInputTrace } from "./lib/input-trace.js";
import { withQuotaSemantics } from "./interpretation.js";
import { createModelsResponse, MODEL_CATALOG_PROVIDER_IDS } from "./models.js";
import { providerPresence } from "./lib/source-attempts.js";
import { readTuiShowPreference } from "./lib/user-config.js";
import { nowIso } from "./lib/time.js";
import {
  fetchAccountQuotas,
  inspectAccountAuth,
} from "./providers/accounts.js";
import { failedProvider } from "./providers/common.js";
import { PROVIDERS } from "./providers/index.js";
import {
  quotaJsonReport,
  redactedResponse,
  renderAuthToon,
  renderModelsToon,
  renderQuotaToon,
} from "./render.js";
import { formatInterval, runLiveTui, type LiveTuiIo } from "./tui-live.js";
import {
  detectTuiColorDepth,
  renderQuotaTui,
  renderTuiHintLine,
  type TuiColorDepth,
} from "./tui.js";
import { scrollHint } from "./tui-viewport.js";
import type {
  AuthProviderReport,
  ProviderId,
  ProviderOptions,
  ProviderQuota,
  QuotaAxiResponse,
} from "./types.js";

export type QuotaContext = {
  binPath: string;
};

const DEFAULT_REFRESH_SECONDS = 300;

export async function quotaCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
  validateProfileOnly(flags);
  validateClaudeInference(flags);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.profileOnly ? false : flags.allowKeychainPrompt,
    refreshCredentials: flags.profileOnly ? false : !flags.noCredentialRefresh,
    ...(flags.allowClaudeInference ? { allowClaudeInference: true } : {}),
    ...(flags.profileOnly ? { credentialMode: "profile-only" as const } : {}),
  };

  const maxAgeSeconds = flags.profileOnly ? 0 : readMaxAge(flags);

  if (flags.tui) return quotaTuiReport(flags, options, maxAgeSeconds);

  const response = await loadQuota(
    flags.providers,
    options,
    false,
    maxAgeSeconds,
  );
  // Presence reads source attempts, which redaction removes, so both the JSON
  // marker and the TOON omission are classified on the complete model first.
  // The same rule as the human report: an explicit --provider never folds,
  // and --full adds the omitted rows back instead of counting them.
  const laneAbsent = response.providers.map(
    (provider) =>
      providerPresence(provider, PROVIDERS[provider.provider]) === "absent",
  );
  if (flags.json) {
    return JSON.stringify(
      quotaJsonReport(response, flags.full, laneAbsent),
      null,
      2,
    );
  }
  return renderQuotaToon(
    redactedResponse(response, flags.full),
    binPath,
    flags.full,
    flags.full || flags.explicitProviders
      ? []
      : omittedAbsentProviderIds(response.providers, laneAbsent),
  );
}

/**
 * Provider ids whose every lane is absent, in first-seen order. One live or
 * uncertain lane keeps the provider's rows; schema 6 folds a provider only
 * when all of its lanes are absent.
 */
function omittedAbsentProviderIds(
  providers: ProviderQuota[],
  laneAbsent: readonly boolean[],
): ProviderId[] {
  const everyLaneAbsent = new Map<ProviderId, boolean>();
  providers.forEach((provider, index) => {
    const absent = laneAbsent[index] === true;
    everyLaneAbsent.set(
      provider.provider,
      (everyLaneAbsent.get(provider.provider) ?? true) && absent,
    );
  });
  return [...everyLaneAbsent.entries()]
    .filter(([, absent]) => absent)
    .map(([id]) => id);
}

/**
 * Render the human report. On an interactive terminal it stays live until the
 * operator quits and then echoes the final frame onto the normal screen;
 * everywhere else (pipes, CI, `--once`) it renders a single frame.
 */
async function quotaTuiReport(
  flags: QuotaFlags,
  options: ProviderOptions,
  maxAgeSeconds: number,
): Promise<string> {
  // A human display preference, so it is read only on this path: TOON and
  // JSON never see it.
  const show = readTuiShowPreference();
  const terminal = (): { columns?: number; colorDepth: TuiColorDepth } => ({
    ...(process.stdout.columns === undefined
      ? {}
      : { columns: process.stdout.columns }),
    colorDepth: detectTuiColorDepth(process.env, process.stdout.isTTY === true),
  });
  // A provider named with --provider is always drawn in full; otherwise the
  // providers that are not set up fold into one line until `a` or --all.
  let showNotSetUp = flags.all || flags.explicitProviders;
  let notSetUp = 0;
  const frame = (response: QuotaAxiResponse): string => {
    // Presence reads the source attempts, which redaction removes, so it is
    // derived from the complete model before the renderer sees the report.
    const presence = response.providers.map((provider) =>
      providerPresence(provider, PROVIDERS[provider.provider]),
    );
    notSetUp = presence.filter((entry) => entry === "absent").length;
    return renderQuotaTui(redactedResponse(response, flags.full), {
      ...terminal(),
      full: flags.full,
      presence,
      showNotSetUp,
      show,
    });
  };

  if (flags.once || !isInteractiveTerminal()) {
    return frame(
      await loadQuota(flags.providers, options, false, maxAgeSeconds),
    );
  }

  const refreshSeconds = flags.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
  const refreshing = `refreshing every ${formatInterval(refreshSeconds)}`;
  const keyHints = (): string[] =>
    flags.explicitProviders || notSetUp === 0
      ? []
      : [`a ${showNotSetUp ? "hide" : "show"} not set up`];
  // A scheduled frame never reuses the loop's own previous frame, which is a
  // full interval old, unless --max-age explicitly allows it; a newer reading
  // from another process still answers.
  const tickMaxAgeSeconds =
    flags.maxAgeSeconds === undefined
      ? Math.min(maxAgeSeconds, refreshSeconds - 1)
      : maxAgeSeconds;
  const last = await runLiveTui<QuotaAxiResponse>({
    // `r` is an operator asking for a new reading now, so it never reuses
    load: (trigger) =>
      loadQuota(
        flags.providers,
        options,
        true,
        trigger === "refresh"
          ? 0
          : trigger === "tick"
            ? tickMaxAgeSeconds
            : maxAgeSeconds,
      ),
    render: frame,
    status: (scroll) =>
      renderTuiHintLine(
        scrollHint(
          scroll,
          ["Press r to refresh", "q to quit", ...keyHints(), refreshing].join(
            " · ",
          ),
          keyHints(),
        ),
        terminal(),
      ),
    keys: flags.explicitProviders
      ? {}
      : {
          // Only while something is folded or expanded, so the state never
          // flips silently behind a hint that is not shown.
          a: () => {
            if (notSetUp > 0) showNotSetUp = !showNotSetUp;
          },
        },
    intervalMillis: refreshSeconds * 1000,
    io: processLiveTuiIo(),
  });
  return last === undefined ? "" : frame(last);
}

function isInteractiveTerminal(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

function processLiveTuiIo(): LiveTuiIo {
  return {
    stdout: process.stdout,
    stdin: process.stdin,
    rows: () => process.stdout.rows,
    columns: () => process.stdout.columns,
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    onResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => {
        process.stdout.off("resize", listener);
      };
    },
    onSignal: (listener) => {
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      for (const signal of signals) process.on(signal, listener);
      return () => {
        for (const signal of signals) process.off(signal, listener);
      };
    },
  };
}

/**
 * Fetch, apply the all-failed exit code, and refresh the cache unless the read
 * is profile-only, which never touches cached quota, or comes from a supplied
 * snapshot. A live report re-evaluates the exit code every cycle so quitting
 * reflects the last frame.
 */
async function loadQuota(
  providers: ProviderId[],
  options: ProviderOptions,
  live: boolean,
  maxAgeSeconds: number,
): Promise<QuotaAxiResponse> {
  const response = await fetchQuota(providers, options, maxAgeSeconds);
  const allFailed = response.providers.every(isFailed);
  if (allFailed) process.exitCode = 1;
  else if (live) process.exitCode = undefined;
  return response;
}

export async function modelsCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseModelsFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
    refreshCredentials: !flags.noCredentialRefresh,
  };
  const quota = await fetchQuota(flags.providers, options, readMaxAge(flags));
  const response = createModelsResponse(quota, {
    ...(flags.intelligence ? { intelligence: flags.intelligence } : {}),
    ...(flags.sort ? { sort: flags.sort } : {}),
  });

  const modelProviders = quota.providers.filter((provider) =>
    MODEL_CATALOG_PROVIDER_IDS.includes(provider.provider),
  );
  if (modelProviders.every(isFailed)) process.exitCode = 1;
  return flags.json
    ? JSON.stringify(response, null, 2)
    : renderModelsToon(response, binPath, flags.full);
}

export async function authCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
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
  if (flags.maxAgeSeconds !== undefined) {
    throw new AxiError(
      "--max-age is only supported by the quota and models commands",
      "VALIDATION_ERROR",
      ["auth always reads the credential stores on disk"],
    );
  }
  // `auth` reports the credential state that is on disk right now, so it never
  // delegates a refresh even when the quota path would.
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
    refreshCredentials: false,
  };

  const reports = await inspectAuth(flags.providers, options);
  return flags.json
    ? JSON.stringify(
        {
          generatedAt: nowIso(),
          schemaVersion: reports.some((report) => report.accountKey) ? 2 : 1,
          auth: reports,
        },
        null,
        2,
      )
    : renderAuthToon(reports, binPath);
}

function validateClaudeInference(flags: QuotaFlags): void {
  if (!flags.allowClaudeInference) return;
  if (!flags.providers.includes("claude")) {
    throw new AxiError(
      "--allow-claude-inference requires the claude provider",
      "VALIDATION_ERROR",
      ["Run `quota-axi --provider claude --allow-claude-inference`"],
    );
  }
  if (flags.profileOnly) {
    throw new AxiError(
      "--allow-claude-inference cannot be combined with --profile-only",
      "VALIDATION_ERROR",
      ["Remove --profile-only to use the selected env credential"],
    );
  }
  if (flags.tui && !flags.once) {
    throw new AxiError(
      "--allow-claude-inference requires --once with --tui",
      "VALIDATION_ERROR",
      ["Recurring TUI refreshes would repeatedly spend inference quota"],
    );
  }
}

/**
 * Read every provider and refresh the cache, unless the read is profile-only,
 * which never touches cached quota, or comes from a supplied snapshot. A
 * snapshot answers for every provider; otherwise a provider whose last
 * successful reading is younger than `maxAgeSeconds` and was taken under this
 * process's credential selection is served from the cache, and every other
 * provider asks its vendor.
 */
export async function fetchQuota(
  providers: ProviderId[],
  options: ProviderOptions,
  maxAgeSeconds = 0,
): Promise<QuotaAxiResponse> {
  const snapshot = snapshotFile();
  // A mistyped fixture path would otherwise read as a fixture naming no provider
  if (snapshot && !isSnapshotFile(snapshot)) {
    throw new AxiError(
      `${SNAPSHOT_ENV} is not a readable quota snapshot: ${snapshot}`,
      "VALIDATION_ERROR",
      [`Point ${SNAPSHOT_ENV} at a quota-axi cache file, or unset it`],
    );
  }
  const writesCache = options.credentialMode !== "profile-only" && !snapshot;
  // Providers a lock holder already cached, so the report-wide write below
  // does not stamp them a second time
  const cached = new Set<ProviderId>();
  const fetched = (
    await Promise.all(
      providers.map((provider) =>
        snapshot
          ? snapshotReadings(provider, snapshot)
          : readProvider(
              provider,
              options,
              writesCache ? maxAgeSeconds : 0,
              () => cached.add(provider),
            ),
      ),
    )
  ).flat();
  // Stamp after every fetch returns: a vendor that computes a reset at
  // response time implies a cycle start no earlier than that instant, so a
  // stamp taken before the request would read an unopened window as
  // `future_cycle_start` by the request latency.
  const generatedAt = nowIso();
  const results = fetched.map((provider) =>
    withQuotaSemantics(provider, generatedAt),
  );
  if (writesCache) {
    writeCachedProvidersBestEffort(
      results.filter((provider) => !cached.has(provider.provider)),
      generatedAt,
    );
  }
  return annotateQuotaAdvice({
    generatedAt,
    providers: results,
  });
}

/**
 * One provider's readings when fresh reuse may answer. Processes that miss
 * the cache together take turns: the lock holder reads the vendor and caches
 * that provider's readings before releasing, so the others are answered by
 * the cache instead of each asking the vendor. `markCached` records that
 * this provider's readings are already in the cache.
 */
async function readProvider(
  provider: ProviderId,
  options: ProviderOptions,
  maxAgeSeconds: number,
  markCached: () => void,
): Promise<ProviderQuota[]> {
  if (!(maxAgeSeconds > 0)) return tracedReadings(provider, options);
  const reused = reusableReadings(provider, maxAgeSeconds);
  if (reused) return reused;
  const turn = await takeFetchTurn(fetchLockPathFor(provider), () =>
    reusableReadings(provider, maxAgeSeconds),
  );
  if (turn.kind === "answered") return turn.value;
  if (turn.kind === "unlocked") return tracedReadings(provider, options);
  try {
    const readings = await tracedReadings(provider, options);
    const readingAt = nowIso();
    writeCachedProvidersBestEffort(
      readings.map((reading) => withQuotaSemantics(reading, readingAt)),
      readingAt,
    );
    markCached();
    return readings;
  } finally {
    turn.lock.release();
  }
}

/**
 * How old a reused reading may be: `--max-age`, else the host's
 * `QUOTA_AXI_MAX_AGE`, else `0`, so reuse is opt-in. `--full` is the audit
 * tier, and account identity and source attempts are never cached, so the
 * host variable does not reach it; only an explicit `--max-age` does.
 */
function readMaxAge(flags: QuotaFlags): number {
  if (flags.maxAgeSeconds !== undefined) return flags.maxAgeSeconds;
  return flags.full ? 0 : (readMaxAgeEnv() ?? 0);
}

/** Env var naming a quota snapshot file that answers instead of any vendor. */
export const SNAPSHOT_ENV = "QUOTA_AXI_SNAPSHOT";

function snapshotFile(): string | undefined {
  return process.env[SNAPSHOT_ENV]?.trim() || undefined;
}

/** Read the vendor, recording which local files the reading depended on. */
async function tracedReadings(
  provider: ProviderId,
  options: ProviderOptions,
): Promise<ProviderQuota[]> {
  const { value, inputs } = await withInputTrace(() =>
    fetchAccountQuotas(PROVIDERS[provider], options),
  );
  for (const reading of value) stampReadingInputs(reading, inputs);
  return value;
}

function reusableReadings(
  provider: ProviderId,
  maxAgeSeconds: number,
): ProviderQuota[] | undefined {
  try {
    return readReusableProviders(provider, maxAgeSeconds);
  } catch {
    return undefined;
  }
}

/**
 * A provider's readings from the supplied snapshot. It never falls through to
 * the vendor: a provider the file does not name, or one whose windows have
 * reached their reset, is reported unavailable so a fixture cannot silently
 * read live credentials.
 */
function snapshotReadings(provider: ProviderId, file: string): ProviderQuota[] {
  let readings: ProviderQuota[] | "expired" | undefined;
  try {
    readings = readSnapshotProviders(file, provider);
  } catch {
    readings = undefined;
  }
  if (Array.isArray(readings)) {
    return readings.map((reading) => ({
      ...reading,
      state: { ...reading.state, sourcesTried: ["snapshot"] },
    }));
  }
  return [
    failedProvider({
      provider,
      label: PROVIDERS[provider].label,
      status: "unavailable",
      error: readings === "expired" ? "snapshot_expired" : "not_in_snapshot",
      sourcesTried: ["snapshot"],
    }),
  ];
}

async function inspectAuth(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<AuthProviderReport[]> {
  const reports = (
    await Promise.all(
      providers.map((provider) =>
        inspectAccountAuth(PROVIDERS[provider], options),
      ),
    )
  ).flat();
  return reports.some((report) => report.accountKey)
    ? reports.map((report) => ({
        ...report,
        accountKey: report.accountKey ?? "default",
      }))
    : reports;
}

function isFailed(provider: ProviderQuota): boolean {
  return !["fresh", "stale"].includes(provider.state.status);
}

function validateProfileOnly(flags: QuotaFlags): void {
  if (!flags.profileOnly) return;
  if (flags.providers.length !== 1) {
    throw new AxiError(
      "--profile-only requires exactly one --provider selector",
      "VALIDATION_ERROR",
      ["Choose `--provider claude` or `--provider codex`"],
    );
  }
  const provider = flags.providers[0];
  if (provider !== "claude" && provider !== "codex") {
    throw new AxiError(
      `--profile-only does not support provider: ${provider}`,
      "VALIDATION_ERROR",
      ["Choose `--provider claude` or `--provider codex`"],
    );
  }
  if (snapshotFile()) {
    throw new AxiError(
      `--profile-only cannot be combined with ${SNAPSHOT_ENV}`,
      "VALIDATION_ERROR",
      [`Unset ${SNAPSHOT_ENV} to read the selected profile`],
    );
  }
  if (flags.allowKeychainPrompt) {
    throw new AxiError(
      "--profile-only cannot be combined with --allow-keychain-prompt",
      "VALIDATION_ERROR",
      ["Profile-only mode never reads Keychain credentials"],
    );
  }
  const selector = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  if (!process.env[selector]?.trim()) {
    throw new AxiError(
      `--profile-only with --provider ${provider} requires explicit ${selector}`,
      "VALIDATION_ERROR",
      [`Set ${selector} to the profile directory to read`],
    );
  }
}

function writeCachedProvidersBestEffort(
  providers: ProviderQuota[],
  readingAt: string,
): void {
  try {
    writeCachedProviders(providers, readingAt);
  } catch {
    return;
  }
}
