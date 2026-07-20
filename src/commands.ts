import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  annotateQuotaAdvice,
  KEYCHAIN_ACCESS_REMEDY_COMMAND,
} from "./advice.js";
import { parseFlags, type ClaudeConfigSelection } from "./args.js";
import { writeCachedProviders } from "./cache.js";
import { nowIso } from "./lib/time.js";
import { failedProvider } from "./providers/common.js";
import { PROVIDERS } from "./providers/index.js";
import { redactedResponse, renderAuthToon, renderQuotaToon } from "./render.js";
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

type ProviderRequest = {
  provider: ProviderId;
  options: ProviderOptions;
  seat?: string;
};

export async function quotaCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
  };

  const response = await fetchQuota(
    flags.providers,
    options,
    flags.claudeConfigs,
  );
  const redacted = redactedResponse(response, flags.full);

  // Deterministic exit: complete failure (no usable row) exits 1; full and
  // partial availability both exit 0 because partial data is still usable. The
  // full-vs-partial distinction lives in `summary.availability`, not the code.
  if (response.summary.availability === "unavailable") {
    process.exitCode = 1;
  }
  writeCachedProvidersBestEffort(response.providers);

  return flags.json
    ? JSON.stringify(redacted, null, 2)
    : renderQuotaToon(redacted, binPath, flags.full);
}

export async function authCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
  };

  const reports = await inspectAuth(
    flags.providers,
    options,
    flags.claudeConfigs,
  );
  return flags.json
    ? JSON.stringify(
        { generatedAt: nowIso(), schemaVersion: 1, auth: reports },
        null,
        2,
      )
    : renderAuthToon(reports, binPath);
}

async function fetchQuota(
  providers: ProviderId[],
  options: ProviderOptions,
  claudeConfigs?: ClaudeConfigSelection[],
): Promise<QuotaAxiResponse> {
  const requests = providerRequests(providers, options, claudeConfigs);
  const results = await runProviderRequests(requests, async (request) => {
    let quota: ProviderQuota;
    try {
      quota = await PROVIDERS[request.provider].fetchQuota(request.options);
    } catch (error) {
      // Existing adapters return normalized failures. This guard keeps an
      // unexpected failure in one explicitly selected Claude seat isolated.
      if (!request.options.claudeConfigDir) throw error;
      quota = failedProvider({
        provider: "claude",
        label: "Claude",
        status: "error",
        error: "Claude quota unavailable",
        sourcesTried: [],
      });
    }
    return request.seat ? withQuotaSeat(quota, request.seat) : quota;
  });
  return annotateQuotaAdvice(
    {
      generatedAt: nowIso(),
      providers: results,
    },
    keychainRemedyCommand(claudeConfigs),
  );
}

async function inspectAuth(
  providers: ProviderId[],
  options: ProviderOptions,
  claudeConfigs?: ClaudeConfigSelection[],
): Promise<AuthProviderReport[]> {
  const requests = providerRequests(providers, options, claudeConfigs);
  return runProviderRequests(requests, async (request) => {
    let report: AuthProviderReport;
    try {
      report = await PROVIDERS[request.provider].inspectAuth(request.options);
    } catch (error) {
      if (!request.options.claudeConfigDir) throw error;
      report = {
        provider: "claude",
        sources: [
          {
            source: "oauth-file",
            status: "invalid",
            error: "inspection_failed",
          },
        ],
      };
    }
    return request.seat ? withAuthSeat(report, request.seat) : report;
  });
}

function providerRequests(
  providers: ProviderId[],
  options: ProviderOptions,
  claudeConfigs?: ClaudeConfigSelection[],
): ProviderRequest[] {
  const seats =
    claudeConfigs && claudeConfigs.length > 1
      ? claudeSeatLabels(claudeConfigs)
      : undefined;
  return providers.flatMap((provider) => {
    if (provider !== "claude" || !claudeConfigs) {
      return [{ provider, options }];
    }
    return claudeConfigs.map((config, index) => ({
      provider,
      options: {
        ...options,
        ...(config.directory ? { claudeConfigDir: config.directory } : {}),
        claudeKeychainIdentity: config.keychainIdentity,
      },
      ...(seats ? { seat: seats[index] } : {}),
    }));
  });
}

function claudeSeatLabels(configs: ClaudeConfigSelection[]): string[] {
  return configs.map((config) => {
    const identity = config.directory ?? config.keychainIdentity;
    const name = (basename(identity) || "root").replace(/\p{Cc}/gu, "_");
    const suffix = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 6);
    return `${name}-${suffix}`;
  });
}

function runProviderRequests<T>(
  requests: ProviderRequest[],
  run: (request: ProviderRequest) => Promise<T>,
): Promise<T[]> {
  let promptQueue = Promise.resolve();
  return Promise.all(
    requests.map((request) => {
      if (
        request.provider !== "claude" ||
        !request.options.allowKeychainPrompt
      ) {
        return run(request);
      }
      const result = promptQueue.then(() => run(request));
      promptQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
  );
}

function keychainRemedyCommand(
  configs: ClaudeConfigSelection[] | undefined,
): string {
  const identities = configs
    ?.map((config) => config.keychainIdentity)
    .filter(Boolean);
  if (!identities || identities.length === 0)
    return KEYCHAIN_ACCESS_REMEDY_COMMAND;
  const configFlags = identities
    .map((identity) => `--claude-config-dir=${quoteCommandArgument(identity)}`)
    .join(" ");
  return `${KEYCHAIN_ACCESS_REMEDY_COMMAND} --provider claude ${configFlags}`;
}

function quoteCommandArgument(value: string): string {
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function withQuotaSeat(quota: ProviderQuota, seat: string): ProviderQuota {
  return {
    ...quota,
    label: `${quota.label} (${seat})`,
    seat,
  };
}

function withAuthSeat(
  report: AuthProviderReport,
  seat: string,
): AuthProviderReport {
  return {
    provider: report.provider,
    seat,
    // The seat label replaces private config paths in normal multi-seat auth
    // output while retaining source availability and error state.
    sources: report.sources.map(({ path: _path, ...source }) => source),
  };
}

function writeCachedProvidersBestEffort(providers: ProviderQuota[]): void {
  try {
    writeCachedProviders(providers);
  } catch {
    return;
  }
}
