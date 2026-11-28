import type { ProviderId } from "../types.js";

/** Format Venice monetary and DIEM balances for text surfaces only. */
export function displayCreditAmount(
  provider: ProviderId,
  unit: string,
  amount: number,
): string {
  if (provider === "venice" && (unit === "usd" || unit === "diem")) {
    return new Intl.NumberFormat("en-US", {
      useGrouping: false,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }
  return String(amount);
}

import type { ProviderQuota } from "../types.js";

export function veniceCreditParts(
  provider: ProviderQuota,
): string[] | undefined {
  const v = provider.credits?.venice;
  if (!v) return undefined;
  const integer = (n: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
  const parts: string[] = [];
  if (v.totalCredits !== undefined)
    parts.push(`${integer(v.totalCredits)} Venice Credits`);
  else if (
    v.usd !== undefined &&
    v.diem !== undefined &&
    v.bundledUsd !== undefined
  )
    parts.push(
      `${integer([v.usd, v.diem, v.bundledUsd].reduce((sum, n) => sum + Math.round(n * 100), 0))} known credits (earned unknown)`,
    );
  if (v.usd !== undefined)
    parts.push(`USD $${displayCreditAmount("venice", "usd", v.usd)}`);
  if (v.diem !== undefined)
    parts.push(`DIEM ${displayCreditAmount("venice", "diem", v.diem)}`);
  if (v.bundledUsd !== undefined)
    parts.push(`plan ${integer(Math.round(v.bundledUsd * 100))} credits`);
  if (v.earnedUsd !== undefined)
    parts.push(`earned ${integer(Math.round(v.earnedUsd * 100))} credits`);
  return parts;
}
