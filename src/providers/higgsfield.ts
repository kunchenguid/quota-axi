import { stripVTControlCharacters } from "node:util";
import * as processUtils from "../lib/process.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

const HIGGSFIELD_COMMAND = "higgsfield";
const HIGGSFIELD_SOURCE = "higgsfield-cli";
const TRANSACTIONS_SOURCE = "higgsfield-transactions";
const JOBS_SOURCE = "higgsfield-jobs";
const STATUS_ARGS = ["account", "status", "--json"] as const;
const TRANSACTIONS_ARGS = [
  "account",
  "transactions",
  "--json",
  "--size",
  "100",
] as const;
const JOBS_ARGS = ["generate", "list", "--json", "--size", "20"] as const;
const CLI_TIMEOUT_MS = 15_000;
const LABEL = "Higgsfield";
const CREDITS_WINDOW_ID = "credits";
const SUBSCRIPTION_GRANT_NAME = "subscription credits";
/**
 * Slack for remaining vs grant plus newer on-page entries. Higgsfield reports
 * fractional credits, and the balance is rounded to the vendor's 0.01-credit
 * precision, so a difference at or below one hundredth of a credit is vendor
 * rounding, not a contradiction. A larger difference means the page cannot
 * explain the balance and the window stays withheld.
 */
const CREDITS_RECONCILE_EPS = 0.01;

const COMPLETED_JOB_STATUSES = new Set([
  "completed",
  "success",
  "succeeded",
  "done",
]);
const FAILED_JOB_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
  "timeout",
  "timed_out",
  "rejected",
]);

type HiggsfieldDependencies = {
  findCommandPath: typeof processUtils.findCommandPath;
  execFileText: typeof processUtils.execFileText;
  now: () => number;
};

export type HiggsfieldJobsRollup = {
  sampled: number;
  completed: number;
  failed: number;
  other: number;
};

export type NormalizedHiggsfieldQuota = {
  plan?: string;
  credits?: { remaining: number; unit: "credits" };
  windows: QuotaWindow[];
  jobs?: HiggsfieldJobsRollup;
};

export function createHiggsfieldAdapter(
  overrides: Partial<HiggsfieldDependencies> = {},
): ProviderAdapter {
  const dependencies: HiggsfieldDependencies = {
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    execFileText: (...args) => processUtils.execFileText(...args),
    now: Date.now,
    ...overrides,
  };

  return {
    id: "higgsfield",
    label: LABEL,
    fetchQuota: (_options: ProviderOptions) =>
      fetchQuotaWithDependencies(dependencies),
    inspectAuth: (_options: ProviderOptions) =>
      inspectAuthWithDependencies(dependencies),
  };
}

export const higgsfieldAdapter = createHiggsfieldAdapter();

async function fetchQuotaWithDependencies(
  dependencies: HiggsfieldDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [
    { source: HIGGSFIELD_SOURCE, status: "failed" },
  ];

  try {
    const commandPath = await dependencies.findCommandPath(HIGGSFIELD_COMMAND);
    if (!commandPath) {
      attempts[0] = {
        source: HIGGSFIELD_SOURCE,
        status: "skipped",
        error: "higgsfield_cli_unavailable",
      };
      throw new Error("higgsfield_cli_unavailable");
    }

    const statusOutput = await dependencies.execFileText(
      commandPath,
      [...STATUS_ARGS],
      CLI_TIMEOUT_MS,
    );
    const statusPayload = parseJson(statusOutput);
    if (!isHiggsfieldStatusPayload(statusPayload)) {
      throw new Error("higgsfield_status_malformed_json");
    }

    const [transactions, jobs] = await Promise.all([
      readOptionalCommand(
        dependencies,
        commandPath,
        TRANSACTIONS_ARGS,
        "higgsfield_transactions",
        isTransactionsPayload,
      ),
      readOptionalCommand(
        dependencies,
        commandPath,
        JOBS_ARGS,
        "higgsfield_jobs",
        isJobsPayload,
      ),
    ]);
    attempts.push(
      transactions.error === undefined
        ? { source: TRANSACTIONS_SOURCE, status: "success" }
        : {
            source: TRANSACTIONS_SOURCE,
            status: "failed",
            error: transactions.error,
          },
    );
    attempts.push(
      jobs.error === undefined
        ? { source: JOBS_SOURCE, status: "success" }
        : {
            source: JOBS_SOURCE,
            status: "failed",
            error: jobs.error,
          },
    );

    const normalized = normalizeHiggsfieldQuota({
      status: statusPayload,
      transactions: transactions.output,
      jobs: jobs.output,
    });

    attempts[0] = { source: HIGGSFIELD_SOURCE, status: "success" };
    const report = successProvider({
      provider: "higgsfield",
      label: LABEL,
      source: "cli",
      ...(normalized.plan ? { plan: normalized.plan } : {}),
      windows: normalized.windows,
      ...(normalized.credits ? { credits: normalized.credits } : {}),
      ...(normalized.jobs ? { jobs: normalized.jobs } : {}),
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    return {
      ...report,
      state: { ...report.state, authStatus: "usable" },
    };
  } catch (error) {
    const message = errorMessage(error);
    if (attempts[0]?.status !== "skipped") {
      attempts[0] = {
        source: HIGGSFIELD_SOURCE,
        status: "failed",
        error: message,
      };
    }
    return failedProvider({
      provider: "higgsfield",
      label: LABEL,
      status: statusFromSentinel(message),
      error: message,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuthWithDependencies(
  dependencies: HiggsfieldDependencies,
): Promise<AuthProviderReport> {
  let source: AuthSourceReport;
  try {
    source = (await dependencies.findCommandPath(HIGGSFIELD_COMMAND))
      ? { source: HIGGSFIELD_SOURCE, status: "available" }
      : { source: HIGGSFIELD_SOURCE, status: "missing" };
  } catch (error) {
    source = {
      source: HIGGSFIELD_SOURCE,
      status: "error",
      error: errorMessage(error),
    };
  }
  return { provider: "higgsfield", sources: [source] };
}

/**
 * Normalize the stable fields from `higgsfield account status --json`,
 * optional `account transactions --json`, and optional `generate list --json`.
 * Email and every job payload field other than `status` are ignored.
 */
export function normalizeHiggsfieldQuota(input: {
  status: unknown;
  transactions?: unknown;
  jobs?: unknown;
}): NormalizedHiggsfieldQuota {
  const root = objectValue(input.status);
  if (!root) return { windows: [] };

  const plan = stringValue(root.subscription_plan_type);
  const remaining = finiteNumber(root.credits);
  const allowance = subscriptionGrantAllowance(input.transactions, remaining);
  const windows: QuotaWindow[] = [];
  if (remaining !== undefined && allowance) {
    const used = allowance.limit - remaining;
    windows.push({
      id: CREDITS_WINDOW_ID,
      label: "credits",
      kind: "credits",
      percentUsed: clampPercentage((used / allowance.limit) * 100),
      percentRemaining: clampPercentage((remaining / allowance.limit) * 100),
      startsAt: allowance.startsAt,
    });
  }

  const jobs = normalizeHiggsfieldJobs(input.jobs);
  return {
    ...(plan ? { plan } : {}),
    ...(remaining !== undefined
      ? { credits: { remaining, unit: "credits" as const } }
      : {}),
    windows,
    ...(jobs ? { jobs } : {}),
  };
}

export function isHiggsfieldStatusPayload(raw: unknown): boolean {
  const root = objectValue(raw);
  if (!root) return false;
  const hasCredits = "credits" in root;
  const hasPlan = "subscription_plan_type" in root;
  if (!hasCredits && !hasPlan) return false;
  if (hasCredits && finiteNumber(root.credits) === undefined) return false;
  if (hasPlan && typeof root.subscription_plan_type !== "string") return false;
  if (hasPlan && stringValue(root.subscription_plan_type) === undefined) {
    return false;
  }
  return true;
}

function subscriptionGrantAllowance(
  raw: unknown,
  remaining: number | undefined,
): { limit: number; startsAt: string } | undefined {
  if (remaining === undefined) return undefined;
  const items = transactionItems(raw);
  if (!items) return undefined;

  let matched: { limit: number; at: number; startsAt: string } | undefined;
  for (const item of items) {
    const limit = finiteNumber(item.credits);
    if (limit === undefined) return undefined;
    if (limit <= 0) continue;
    if (matched) return undefined;
    if (stringValue(item.action) !== "grant") return undefined;
    if (normalizeName(item.display_name) !== SUBSCRIPTION_GRANT_NAME) {
      return undefined;
    }
    const startsAt = parseTimestamp(item.created_at);
    if (startsAt === undefined) return undefined;
    matched = { limit, at: Date.parse(startsAt), startsAt };
  }
  if (!matched) return undefined;

  let expected = matched.limit;
  for (const item of items) {
    const credits = finiteNumber(item.credits);
    if (credits === undefined) return undefined;
    const at = parseTimestamp(item.created_at);
    if (at === undefined) return undefined;
    if (Date.parse(at) > matched.at) {
      expected += credits;
    }
  }
  return creditsReconcile(remaining, expected)
    ? { limit: matched.limit, startsAt: matched.startsAt }
    : undefined;
}

function creditsReconcile(remaining: number, expected: number): boolean {
  return Math.abs(remaining - expected) <= CREDITS_RECONCILE_EPS;
}

function normalizeHiggsfieldJobs(
  raw: unknown,
): HiggsfieldJobsRollup | undefined {
  const records = jobRecords(raw);
  if (!records) return undefined;

  let completed = 0;
  let failed = 0;
  let other = 0;
  for (const record of records) {
    const status = stringValue(record.status)?.toLowerCase();
    if (status !== undefined && COMPLETED_JOB_STATUSES.has(status)) {
      completed += 1;
    } else if (status !== undefined && FAILED_JOB_STATUSES.has(status)) {
      failed += 1;
    } else {
      other += 1;
    }
  }
  return { sampled: records.length, completed, failed, other };
}

function transactionItems(raw: unknown): Record<string, unknown>[] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return objectList(raw);
  const root = objectValue(raw);
  if (!root || !("items" in root)) return undefined;
  return Array.isArray(root.items) ? objectList(root.items) : undefined;
}

function jobRecords(raw: unknown): Record<string, unknown>[] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return objectList(raw);
  const root = objectValue(raw);
  if (!root) return undefined;
  for (const key of ["items", "jobs", "data"] as const) {
    if (Array.isArray(root[key])) return objectList(root[key]);
  }
  return undefined;
}

function isTransactionsPayload(raw: unknown): boolean {
  const items = transactionItems(raw);
  if (!items) return false;
  return items.every(
    (item) =>
      stringValue(item.action) !== undefined &&
      stringValue(item.display_name) !== undefined &&
      parseTimestamp(item.created_at) !== undefined &&
      finiteNumber(item.credits) !== undefined,
  );
}

function isJobsPayload(raw: unknown): boolean {
  const records = jobRecords(raw);
  if (!records) return false;
  return records.every((record) => stringValue(record.status) !== undefined);
}

function objectList(value: unknown[]): Record<string, unknown>[] | undefined {
  const items: Record<string, unknown>[] = [];
  for (const entry of value) {
    const object = objectValue(entry);
    if (!object) return undefined;
    items.push(object);
  }
  return items;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

type OptionalCommandOutcome = { output?: unknown; error?: string };

async function readOptionalCommand(
  dependencies: HiggsfieldDependencies,
  commandPath: string,
  args: readonly string[],
  failurePrefix: string,
  validate: (raw: unknown) => boolean,
): Promise<OptionalCommandOutcome> {
  try {
    const output = parseJson(
      await dependencies.execFileText(commandPath, [...args], CLI_TIMEOUT_MS),
    );
    return validate(output)
      ? { output }
      : { error: `${failurePrefix}_malformed_json` };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { error: `${failurePrefix}_malformed_json` };
    }
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      error:
        message === ""
          ? `${failurePrefix}_failed`
          : `${failurePrefix}_failed: ${cliErrorDetail(message)}`,
    };
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeName(value: unknown): string | undefined {
  const text = stringValue(value);
  return text ? text.toLowerCase() : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "higgsfield_status_malformed_json";
  if (error instanceof Error) {
    const message = error.message.trim();
    if (
      message === "higgsfield_status_malformed_json" ||
      message === "higgsfield_cli_unavailable"
    ) {
      return message;
    }
    if (isAuthFailure(message)) return "higgsfield_sign_in_required";
    return message
      ? `higgsfield_status_failed: ${cliErrorDetail(message)}`
      : "higgsfield_status_failed";
  }
  return "higgsfield_status_failed";
}

/**
 * CLI error text lands in report rows, so keep the cause but drop terminal
 * escapes, emails, and credential-shaped values before the length cap.
 */
function cliErrorDetail(message: string): string {
  return stripVTControlCharacters(message)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[redacted-email]")
    .replace(/\b(bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(
      /\b([\w-]*(?:token|key|password|passwd|secret|authorization)[\w-]*\s*[:=]\s*)["']?[^\s"',;]+["']?/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, "[redacted]")
    .trim()
    .slice(0, 240);
}

function isAuthFailure(message: string): boolean {
  return /not logged|unauthori[sz]ed|unauthenticated|please log in|sign[- ]?in|access token expired|reauth/i.test(
    message,
  );
}

function statusFromSentinel(message: string): ProviderStatus {
  switch (message) {
    case "higgsfield_cli_unavailable":
      return "unavailable";
    case "higgsfield_sign_in_required":
      return "auth_required";
    default:
      return "error";
  }
}
