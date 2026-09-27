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
 * would land in cache slots and output join columns - costs only its own lane:
 * the rest still expand, because one unusable entry must not hide the accounts
 * beside it. Only when no lane survives does the read fall back to the
 * adapter's single selected account, which never fails the whole report.
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
  const keys = new Set<string>();
  const usable = accounts.filter((account) => {
    if (
      !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(account.accountKey) ||
      keys.has(account.accountKey)
    )
      return false;
    keys.add(account.accountKey);
    return true;
  });
  return usable.length > 0 ? usable : undefined;
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
  for (const { account, report } of readings) {
    if (accounts.length > 1) report.accountKey = account.accountKey;
    report.accountKeys = coveredAccountKeys(
      account.accountKey,
      report.accountKeys,
    );
  }
  return readings.map(({ report }) => report);
}

/**
 * Credential keys one account row covers.
 *
 * The lane's own key is first. A provider that folded other credentials into
 * the lane lists them after it, in the order it recorded them. Callers that
 * hold a credential key match the row by membership, not by `accountKey` alone.
 */
export function coveredAccountKeys(
  accountKey: string,
  covered: readonly string[] | undefined,
): string[] {
  const keys = [accountKey];
  for (const key of covered ?? []) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
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

/**
 * One spelling for the join columns in every flat output block.
 *
 * Expansion is already decided upstream: each command fills every report's
 * `accountKey` with the `default` filler as soon as one report carries a real
 * key (`annotateQuotaAdvice`, `inspectAuth`, `createModelsResponse`). So a key
 * here means the response expanded, and the renderer only copies it across.
 */
export function accountColumns(report: {
  provider: string;
  accountKey?: string;
}): { accountKey?: string } {
  return report.accountKey ? { accountKey: report.accountKey } : {};
}
