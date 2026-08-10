import { AxiError } from "axi-sdk-js";
import { annotateQuotaAdvice } from "./advice.js";
import { parseFlags, parseModelsFlags, type QuotaFlags } from "./args.js";
import { writeCachedProviders } from "./cache.js";
import {
  CREDENTIAL_OVERRIDE_CAPABILITY,
  resolveCredentialOverrides,
} from "./credential-override.js";
import { withQuotaSemantics } from "./interpretation.js";
import { createModelsResponse, MODEL_CATALOG_PROVIDER_IDS } from "./models.js";
import { nowIso } from "./lib/time.js";
import { PROVIDERS } from "./providers/index.js";
import {
  redactedResponse,
  renderAuthToon,
  renderModelsToon,
  renderQuotaToon,
} from "./render.js";
import { formatInterval, runLiveTui, type LiveTuiIo } from "./tui-live.js";
import { detectTuiColorDepth, renderQuotaTui } from "./tui.js";
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
  const options = providerOptionsWithOverrides(flags);

  if (flags.tui) return quotaTuiReport(flags, options);

  const response = await loadQuota(flags.providers, options, false);
  const redacted = redactedResponse(response, flags.full);
  return flags.json
    ? JSON.stringify(redacted, null, 2)
    : renderQuotaToon(redacted, binPath, flags.full);
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
  const frame = (response: QuotaAxiResponse, footerHint?: string): string =>
    renderQuotaTui(redactedResponse(response, flags.full), {
      columns: process.stdout.columns,
      colorDepth: detectTuiColorDepth(
        process.env,
        process.stdout.isTTY === true,
      ),
      full: flags.full,
      ...(footerHint === undefined ? {} : { footerHint }),
    });

  if (flags.once || !isInteractiveTerminal()) {
    return frame(await loadQuota(flags.providers, options, false));
  }

  const refreshSeconds = flags.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
  const hint = `Press q to quit · refreshing every ${formatInterval(refreshSeconds)}`;
  const last = await runLiveTui<QuotaAxiResponse>({
    load: () => loadQuota(flags.providers, options, true),
    render: (response) => frame(response, hint),
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
 * Fetch, apply the all-failed exit code, and refresh the cache. A live report
 * re-evaluates the exit code every cycle so quitting reflects the last frame.
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
  writeCachedProvidersBestEffort(response.providers);
  return response;
}

export async function modelsCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseModelsFlags(args);
  const options = providerOptionsWithOverrides(flags);
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
  if (flags.tui) {
    throw new AxiError(
      "--tui is only supported by the quota command",
      "VALIDATION_ERROR",
      ["Run `quota-axi --tui` for the human quota report"],
    );
  }
  const options = providerOptionsWithOverrides(flags);

  const reports = await inspectAuth(flags.providers, options);
  return flags.json
    ? JSON.stringify(
        {
          generatedAt: nowIso(),
          schemaVersion: 1,
          capabilities: { credentialOverride: CREDENTIAL_OVERRIDE_CAPABILITY },
          auth: reports,
        },
        null,
        2,
      )
    : renderAuthToon(reports, binPath);
}

/**
 * Build provider options for one invocation, absorbing the optional
 * credential-override envelope (docs/credential-override.md). When no
 * envelope is present the options are byte-for-byte the legacy shape.
 */
function providerOptionsWithOverrides(flags: {
  allowKeychainPrompt: boolean;
}): ProviderOptions {
  const credentialOverrides = resolveCredentialOverrides();
  if (!credentialOverrides) {
    return { allowKeychainPrompt: flags.allowKeychainPrompt };
  }
  return {
    allowKeychainPrompt: flags.allowKeychainPrompt,
    credentialOverrides,
  };
}

export async function fetchQuota(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<QuotaAxiResponse> {
  const generatedAt = nowIso();
  const results = (
    await Promise.all(
      providers.map((provider) => PROVIDERS[provider].fetchQuota(options)),
    )
  ).map((provider) => withQuotaSemantics(provider, generatedAt));
  return annotateQuotaAdvice({
    generatedAt,
    providers: results,
  });
}

async function inspectAuth(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<AuthProviderReport[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const report = await PROVIDERS[provider].inspectAuth(options);
      const override = options.credentialOverrides?.[provider];
      if (!override) return report;
      // An override is a per-flight credential, not a local source; report its
      // presence without exposing it or probing it remotely.
      return {
        provider,
        sources: [
          ...report.sources,
          { source: "override", status: "available", credentialPresent: true },
        ],
      };
    }),
  );
}

function isFailed(provider: ProviderQuota): boolean {
  return !["fresh", "stale"].includes(provider.state.status);
}

function writeCachedProvidersBestEffort(providers: ProviderQuota[]): void {
  try {
    writeCachedProviders(providers);
  } catch {
    return;
  }
}
