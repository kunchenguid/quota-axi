import { AxiError } from "axi-sdk-js";
import { annotateQuotaAdvice } from "./advice.js";
import { parseFlags, parseModelsFlags, type QuotaFlags } from "./args.js";
import { writeCachedProviders } from "./cache.js";
import { withQuotaSemantics } from "./interpretation.js";
import { createModelsResponse, MODEL_CATALOG_PROVIDER_IDS } from "./models.js";
import { nowIso } from "./lib/time.js";
import {
  fetchAccountQuotas,
  inspectAccountAuth,
} from "./providers/accounts.js";
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

  if (flags.tui) return quotaTuiReport(flags, options);

  const response = await loadQuota(flags.providers, options, false);
  return flags.json
    ? JSON.stringify(quotaJsonReport(response, flags.full), null, 2)
    : renderQuotaToon(
        redactedResponse(response, flags.full),
        binPath,
        flags.full,
      );
}

/**
 * Render the human report. On an interactive terminal it stays live until the
 * operator quits and then echoes the final frame onto the normal screen;
 * everywhere else (pipes, CI, `--once`) it renders a single frame.
 */
async function quotaTuiReport(
  flags: QuotaFlags,
  options: ProviderOptions,
): Promise<string> {
  const terminal = (): { columns?: number; colorDepth: TuiColorDepth } => ({
    ...(process.stdout.columns === undefined
      ? {}
      : { columns: process.stdout.columns }),
    colorDepth: detectTuiColorDepth(process.env, process.stdout.isTTY === true),
  });
  const frame = (response: QuotaAxiResponse): string =>
    renderQuotaTui(redactedResponse(response, flags.full), {
      ...terminal(),
      full: flags.full,
    });

  if (flags.once || !isInteractiveTerminal()) {
    return frame(await loadQuota(flags.providers, options, false));
  }

  const refreshSeconds = flags.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
  const hint = `Press q to quit · refreshing every ${formatInterval(refreshSeconds)}`;
  const last = await runLiveTui<QuotaAxiResponse>({
    load: () => loadQuota(flags.providers, options, true),
    render: frame,
    status: (scroll) => renderTuiHintLine(scrollHint(scroll, hint), terminal()),
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
 * is profile-only, which never touches cached quota. A live report re-evaluates
 * the exit code every cycle so quitting reflects the last frame.
 */
async function loadQuota(
  providers: ProviderId[],
  options: ProviderOptions,
  live: boolean,
): Promise<QuotaAxiResponse> {
  const response = await fetchQuota(providers, options);
  const allFailed = response.providers.every(isFailed);
  if (allFailed) process.exitCode = 1;
  else if (live) process.exitCode = undefined;
  if (options.credentialMode !== "profile-only") {
    writeCachedProvidersBestEffort(response.providers);
  }
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
  const quota = await fetchQuota(flags.providers, options);
  writeCachedProvidersBestEffort(quota.providers);
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

export async function fetchQuota(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<QuotaAxiResponse> {
  const fetched = (
    await Promise.all(
      providers.map((provider) =>
        fetchAccountQuotas(PROVIDERS[provider], options),
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
  return annotateQuotaAdvice({
    generatedAt,
    providers: results,
  });
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

function writeCachedProvidersBestEffort(providers: ProviderQuota[]): void {
  try {
    writeCachedProviders(providers);
  } catch {
    return;
  }
}
