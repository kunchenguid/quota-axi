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
    parts.push(`${integer(v.totalCredits)} credits`);
  else if (
    v.usd !== undefined &&
    v.diem !== undefined &&
    v.bundledUsd !== undefined
  )
    parts.push(
      `${integer([v.usd, v.diem, v.bundledUsd].reduce((sum, n) => sum + Math.round(n * 100), 0))} known credits`,
    );
  if (v.diem !== undefined)
    parts.push(`DIEM ${integer(Math.round(v.diem * 100))} today`);
  if (v.earnedUsd !== undefined && v.earnedUsd > 0)
    parts.push(`earned ${integer(Math.round(v.earnedUsd * 100))}`);
  if (v.bundledUsd !== undefined)
    parts.push(`plan ${integer(Math.round(v.bundledUsd * 100))} this month`);
  if (v.usd !== undefined)
    parts.push(`banked ${integer(Math.round(v.usd * 100))}`);
  return parts;
}
