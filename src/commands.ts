import { createHash } from "node:crypto";
import { basename } from "node:path";
import { annotateQuotaAdvice } from "./advice.js";
import { parseFlags } from "./args.js";
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
    flags.claudeConfigDirs,
  );
  const redacted = redactedResponse(response, flags.full);

  if (response.providers.every(isFailed)) {
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
    flags.claudeConfigDirs,
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
  claudeConfigDirs?: string[],
): Promise<QuotaAxiResponse> {
  const requests = providerRequests(providers, options, claudeConfigDirs);
  const results = await Promise.all(
    requests.map(async (request) => {
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
    }),
  );
  return annotateQuotaAdvice({
    generatedAt: nowIso(),
    providers: results,
  });
}

async function inspectAuth(
  providers: ProviderId[],
  options: ProviderOptions,
  claudeConfigDirs?: string[],
): Promise<AuthProviderReport[]> {
  const requests = providerRequests(providers, options, claudeConfigDirs);
  return Promise.all(
    requests.map(async (request) => {
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
    }),
  );
}

function providerRequests(
  providers: ProviderId[],
  options: ProviderOptions,
  claudeConfigDirs?: string[],
): ProviderRequest[] {
  const seats =
    claudeConfigDirs && claudeConfigDirs.length > 1
      ? claudeSeatLabels(claudeConfigDirs)
      : undefined;
  return providers.flatMap((provider) => {
    if (provider !== "claude" || !claudeConfigDirs) {
      return [{ provider, options }];
    }
    return claudeConfigDirs.map((claudeConfigDir, index) => ({
      provider,
      options: { ...options, claudeConfigDir },
      ...(seats ? { seat: seats[index] } : {}),
    }));
  });
}

function claudeSeatLabels(directories: string[]): string[] {
  const basenames = directories.map((directory) =>
    (basename(directory) || "root").replace(/\p{Cc}/gu, "_"),
  );
  const counts = new Map<string, number>();
  for (const name of basenames) counts.set(name, (counts.get(name) ?? 0) + 1);
  return basenames.map((name, index) =>
    counts.get(name) === 1
      ? name
      : `${name}-${createHash("sha256")
          .update(directories[index])
          .digest("hex")
          .slice(0, 6)}`,
  );
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
