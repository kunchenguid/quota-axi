import type {
  AuthProviderReport,
  ProviderAccount,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../types.js";

/** The account set could not be enumerated, so only one lane was read. */
const DISCOVERY_SOURCE = "account-discovery";
const DISCOVERY_ERROR = "account_discovery_failed";

type AccountDiscovery =
  | { accounts: ProviderAccount[] }
  | { accounts?: undefined; failed: boolean };

/** Discovery belongs to the adapter; collection never interprets credentials. */
async function accountsFor(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<AccountDiscovery> {
  if (options.credentialMode === "profile-only") return { failed: false };
  // A discovery fault belongs to one adapter: fall back to its single-account
  // reader rather than failing every other provider's read alongside it. The
  // fallback is announced, so a truncated account set is never silent.
  try {
    const accounts = await adapter.discoverAccounts?.();
    if (!accounts?.length) return { failed: false };
    const keys = new Set<string>();
    for (const account of accounts) {
      if (
        !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(account.accountKey) ||
        keys.has(account.accountKey)
      ) {
        return { failed: true };
      }
      keys.add(account.accountKey);
    }
    return { accounts };
  } catch {
    return { failed: true };
  }
}

function withDiscoveryFailure(report: ProviderQuota): ProviderQuota {
  return {
    ...report,
    state: {
      ...report.state,
      degradedSources: [
        ...(report.state.degradedSources ?? []),
        { source: DISCOVERY_SOURCE, error: DISCOVERY_ERROR },
      ],
    },
    attempts: [
      ...(report.attempts ?? []),
      { source: DISCOVERY_SOURCE, status: "failed", error: DISCOVERY_ERROR },
    ],
  };
}

export async function fetchAccountQuotas(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<ProviderQuota[]> {
  const discovery = await accountsFor(adapter, options);
  const accounts = discovery.accounts;
  if (!accounts) {
    const report = await adapter.fetchQuota(options);
    return [discovery.failed ? withDiscoveryFailure(report) : report];
  }
  // Keep each adapter's declaration order, including failed accounts. Readers
  // return their own structured failure; no account selects a sibling's token.
  const reports: ProviderQuota[] = [];
  for (const account of accounts) {
    let report: ProviderQuota;
    try {
      report = await account.fetchQuota(options);
    } catch {
      // Never serialize an unexpected error: it may contain a path or token.
      report = {
        provider: adapter.id,
        label: adapter.label,
        source: "unavailable",
        windows: [],
        state: {
          status: "error",
          stale: false,
          error: "account_read_failed",
          sourcesTried: [],
        },
      };
    }
    reports.push(
      accounts.length === 1
        ? report
        : {
            ...report,
            accountKey: account.accountKey,
            accountLocator: account.locator,
          },
    );
  }
  return reports;
}

export async function inspectAccountAuth(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<AuthProviderReport[]> {
  const discovery = await accountsFor(adapter, options);
  const accounts = discovery.accounts;
  if (!accounts) {
    const report = await adapter.inspectAuth(options);
    return [
      discovery.failed
        ? {
            ...report,
            sources: [
              ...report.sources,
              {
                source: DISCOVERY_SOURCE,
                status: "error",
                error: DISCOVERY_ERROR,
              },
            ],
          }
        : report,
    ];
  }
  const reports: AuthProviderReport[] = [];
  for (const account of accounts) {
    let report: AuthProviderReport;
    try {
      report = await account.inspectAuth(options);
    } catch {
      report = {
        provider: adapter.id,
        sources: [
          { source: "account", status: "error", error: "account_read_failed" },
        ],
      };
    }
    reports.push(
      accounts.length === 1
        ? report
        : {
            ...report,
            accountKey: account.accountKey,
          },
    );
  }
  return reports;
}

/** One spelling for the join columns in every flat output block. */
export function accountColumns(
  report: { provider: string; accountKey?: string },
  expanded: boolean,
): { accountKey?: string } {
  return expanded ? { accountKey: report.accountKey ?? "default" } : {};
}
