import type {
  AuthProviderReport,
  ProviderAccount,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../types.js";

/**
 * Discovery belongs to the adapter; collection never interprets credentials.
 *
 * A key is user-editable configuration, so a malformed or repeated one - which
 * would land in cache slots and output join columns - only costs the expansion:
 * discovery is abandoned for the adapter's single selected account rather than
 * failing a read every other provider would have answered.
 */
async function accountsFor(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<ProviderAccount[] | undefined> {
  if (options.credentialMode === "profile-only") return undefined;
  let accounts: ProviderAccount[] | undefined;
  try {
    accounts = await adapter.discoverAccounts?.();
  } catch {
    return undefined;
  }
  if (!accounts?.length) return undefined;
  const keys = new Set(accounts.map((account) => account.accountKey));
  const usable =
    keys.size === accounts.length &&
    accounts.every((account) =>
      /^[a-z0-9][a-z0-9:_-]{0,95}$/.test(account.accountKey),
    );
  return usable ? accounts : undefined;
}

export async function fetchAccountQuotas(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<ProviderQuota[]> {
  const accounts = await accountsFor(adapter, options);
  if (!accounts) return [await adapter.fetchQuota(options)];
  // Keep each adapter's declaration order, including failed accounts. Readers
  // return their own structured failure; no account selects a sibling's token.
  const readings: { account: ProviderAccount; report: ProviderQuota }[] = [];
  for (const account of accounts) {
    let report: ProviderQuota | undefined;
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
    if (report) readings.push({ account, report });
  }
  return readings.map(({ account, report }) =>
    accounts.length === 1
      ? report
      : {
          ...report,
          accountKey: account.accountKey,
        },
  );
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
