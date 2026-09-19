import type {
  AuthProviderReport,
  ProviderAccount,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import {
  markRetiredAccountKeys,
  retiredAccountKeys,
  subscriptionIdentity,
} from "../cache.js";
import { sourceNames } from "./common.js";

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
  // After every lane has been read, collection coalesces readings that share a
  // verified subscription identity so a second route is not extra capacity.
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
  if (accounts.length > 1) {
    for (const { account, report } of readings) {
      report.accountKey = account.accountKey;
    }
  }
  return coalesceVerifiedSubscriptions(readings.map(({ report }) => report));
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

/**
 * One published reading per verified subscription, in first-seen order.
 *
 * Identity is `account.accountId` when it is present and not marked
 * unverified, or the stamp a cached snapshot recorded from such a reading.
 * Email, path, profile label, and runner name never participate. Missing or
 * incomparable identity stays its own lane: two unknowns are not equal, and a
 * known id is not guessed onto a reading that lacks one.
 *
 * A fresh winner retires a superseded fresh lane's cache slot, so a later run
 * in which both routes fail cannot serve the same subscription twice from
 * cache. That slot is only marked here and retired by the same cache write
 * that persists the winner, never ahead of it. A superseded stale lane keeps
 * its stamped snapshot: that stamp is what lets the still-failing route
 * coalesce again instead of resurfacing as a separate unavailable card.
 */
function coalesceVerifiedSubscriptions(
  reports: ProviderQuota[],
): ProviderQuota[] {
  const result: ProviderQuota[] = [];
  for (const report of reports) {
    const identity = subscriptionIdentity(report);
    const existingIndex =
      identity === undefined
        ? -1
        : result.findIndex(
            (candidate) =>
              candidate.provider === report.provider &&
              subscriptionIdentity(candidate) === identity,
          );
    if (existingIndex < 0) {
      result.push(report);
      continue;
    }
    const merged = mergeSubscriptionReadings(result[existingIndex], report);
    if (merged.state.status === "fresh")
      markRetiredAccountKeys(
        merged,
        supersededSlots(merged, [result[existingIndex], report]),
      );
    result[existingIndex] = merged;
  }
  return result;
}

function supersededSlots(
  winner: ProviderQuota,
  readings: ProviderQuota[],
): string[] {
  const keys = new Set<string>();
  for (const reading of readings) {
    for (const key of retiredAccountKeys(reading)) keys.add(key);
    if (reading.state.status === "fresh" && reading.accountKey)
      keys.add(reading.accountKey);
  }
  if (winner.accountKey) keys.delete(winner.accountKey);
  return [...keys];
}

function mergeSubscriptionReadings(
  earlier: ProviderQuota,
  later: ProviderQuota,
): ProviderQuota {
  const winner = outranks(later, earlier) ? later : earlier;
  const attempts = mergedAttempts(earlier, later);
  const sourcesTried = mergedSourcesTried(earlier, later, attempts);
  return {
    ...winner,
    ...(attempts ? { attempts } : {}),
    state: {
      ...winner.state,
      ...(sourcesTried ? { sourcesTried } : {}),
    },
  };
}

/**
 * Fresh beats stale beats a rejected or failed reading so a usable sibling is
 * never discarded for a sign-out. Two stale readings prefer the later
 * `refreshedAt`; other ties keep declaration order. Windows stay the winner's:
 * coalescing must not sum, average, or concatenate them.
 */
function outranks(later: ProviderQuota, earlier: ProviderQuota): boolean {
  const rank = readingRank(later);
  if (rank !== readingRank(earlier)) return rank < readingRank(earlier);
  return rank === 1 && refreshedTime(later) > refreshedTime(earlier);
}

function refreshedTime(report: ProviderQuota): number {
  const time = Date.parse(report.state.refreshedAt ?? "");
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function readingRank(report: ProviderQuota): number {
  if (report.state.status === "fresh") return 0;
  if (report.state.status === "stale" || report.state.stale) return 1;
  return 2;
}

function mergedAttempts(
  earlier: ProviderQuota,
  later: ProviderQuota,
): SourceAttempt[] | undefined {
  const attempts = [...(earlier.attempts ?? []), ...(later.attempts ?? [])];
  return attempts.length > 0 ? attempts : undefined;
}

function mergedSourcesTried(
  earlier: ProviderQuota,
  later: ProviderQuota,
  attempts: SourceAttempt[] | undefined,
): string[] | undefined {
  if (attempts && attempts.length > 0) return sourceNames(attempts);
  const names = [
    ...(earlier.state.sourcesTried ?? []),
    ...(later.state.sourcesTried ?? []),
  ];
  return names.length > 0 ? [...new Set(names)] : undefined;
}
