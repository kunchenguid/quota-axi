import type { ProviderAdapter, ProviderSpend } from "../types.js";
import {
  type ApiSpendSpec,
  createApiSpendAdapter,
  objectValue,
  SPEND_PAGE_BUCKETS,
  type SpendPage,
} from "./api-spend.js";

export const ANTHROPIC_COST_URL =
  "https://api.anthropic.com/v1/organizations/cost_report";
export const ANTHROPIC_ORGANIZATION_URL =
  "https://api.anthropic.com/v1/organizations/me";
export const ANTHROPIC_ADMIN_KEY_ENV = "ANTHROPIC_ADMIN_KEY";
export const ANTHROPIC_API_LIMIT_ENV = "QUOTA_AXI_ANTHROPIC_API_LIMIT_USD";

const ANTHROPIC_VERSION = "2023-06-01";

/** The cost report states amounts as decimal strings of USD cents. */
export function parseAnthropicCostPage(raw: unknown): SpendPage {
  const root = objectValue(raw);
  if (!root || !Array.isArray(root.data)) throw new Error("invalid_payload");
  let cents = 0;
  for (const bucket of root.data) {
    const results = objectValue(bucket)?.results;
    if (!Array.isArray(results)) throw new Error("invalid_payload");
    for (const result of results) {
      const row = objectValue(result);
      if (!row || row.currency !== "USD") throw new Error("invalid_currency");
      const amount = Number(row.amount);
      if (
        typeof row.amount !== "string" ||
        row.amount.trim() === "" ||
        !Number.isFinite(amount)
      )
        throw new Error("invalid_amount");
      cents += amount;
    }
  }
  const next = root.next_page;
  if (root.has_more === true && (typeof next !== "string" || next === ""))
    throw new Error("invalid_payload");
  return {
    buckets: root.data.length,
    spentUsd: cents / 100,
    ...(root.has_more === true ? { nextPage: next as string } : {}),
  };
}

/** `GET /v1/organizations/me` states `{ id, type: "organization", name }`. */
export function parseAnthropicOrganization(
  raw: unknown,
): ProviderSpend["organization"] {
  const root = objectValue(raw);
  if (
    !root ||
    root.type !== "organization" ||
    typeof root.id !== "string" ||
    root.id.trim() === ""
  )
    throw new Error("invalid_payload");
  const name = typeof root.name === "string" ? root.name.trim() : "";
  return { id: root.id, ...(name ? { name } : {}) };
}

export const ANTHROPIC_API_SPEC: ApiSpendSpec = {
  id: "anthropic-api",
  label: "Anthropic API",
  envVar: ANTHROPIC_ADMIN_KEY_ENV,
  limitEnvVar: ANTHROPIC_API_LIMIT_ENV,
  reportedLag: "typically within 5 minutes",
  url: (period, page) => {
    const url = new URL(ANTHROPIC_COST_URL);
    url.searchParams.set("starting_at", period.start.toISOString());
    url.searchParams.set("ending_at", period.end.toISOString());
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", String(SPEND_PAGE_BUCKETS));
    if (page) url.searchParams.set("page", page);
    return url.toString();
  },
  identityUrl: ANTHROPIC_ORGANIZATION_URL,
  headers: (key) => ({
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
  }),
  parsePage: parseAnthropicCostPage,
  parseIdentity: parseAnthropicOrganization,
};

export const anthropicApiAdapter: ProviderAdapter =
  createApiSpendAdapter(ANTHROPIC_API_SPEC);
