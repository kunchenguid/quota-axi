import type {
  AuthProviderReport,
  ProviderAccount,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../types.js";

/** Discovery belongs to the adapter; collection never interprets credentials. */
async function accountsFor(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<ProviderAccount[] | undefined> {
  if (options.credentialMode === "profile-only") return undefined;
  const accounts = await adapter.discoverAccounts?.();
  if (!accounts?.length) return undefined;
  const keys = new Set<string>();
  for (const account of accounts) {
    if (
      !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(account.accountKey) ||
      keys.has(account.accountKey)
    ) {
      throw new Error(`invalid or duplicate ${adapter.id} account key`);
    }
    keys.add(account.accountKey);
  }
  return accounts;
}

export async function fetchAccountQuotas(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<ProviderQuota[]> {
  const accounts = await accountsFor(adapter, options);
  if (!accounts) return [await adapter.fetchQuota(options)];
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
  const accounts = await accountsFor(adapter, options);
  if (!accounts) return [await adapter.inspectAuth(options)];
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
