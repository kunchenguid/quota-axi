import * as processUtils from "../lib/process.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  statusFromError,
  successProvider,
} from "./common.js";

const KIRO_COMMAND = "kiro-cli";
const KIRO_SOURCE = "kiro-cli";
const KIRO_ARGS = ["chat", "--no-interactive", "/usage"];
const KIRO_TIMEOUT_MS = 15_000;
const LABEL = "Kiro";

type KiroDependencies = {
  findCommandPath: typeof processUtils.findCommandPath;
  execFileText: typeof processUtils.execFileText;
  now: () => number;
};

export type NormalizedKiroUsage = {
  plan?: string;
  windows: QuotaWindow[];
};

export function createKiroAdapter(
  overrides: Partial<KiroDependencies> = {},
): ProviderAdapter {
  const dependencies: KiroDependencies = {
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    execFileText: (...args) => processUtils.execFileText(...args),
    now: Date.now,
    ...overrides,
  };

  return {
    id: "kiro",
    label: LABEL,
    fetchQuota: (_options: ProviderOptions) =>
      fetchQuotaWithDependencies(dependencies),
    inspectAuth: (_options: ProviderOptions) =>
      inspectAuthWithDependencies(dependencies),
  };
}

export const kiroAdapter = createKiroAdapter();

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWithDependencies({
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    execFileText: (...args) => processUtils.execFileText(...args),
    now: Date.now,
  });
}

async function fetchQuotaWithDependencies(
  dependencies: KiroDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [{ source: KIRO_SOURCE, status: "failed" }];

  try {
    const commandPath = await dependencies.findCommandPath(KIRO_COMMAND);
    if (!commandPath) {
      attempts[0] = {
        source: KIRO_SOURCE,
        status: "skipped",
        error: "kiro_cli_unavailable",
      };
      throw new Error("kiro_cli_unavailable");
    }

    const output = await dependencies.execFileText(
      commandPath,
      KIRO_ARGS,
      KIRO_TIMEOUT_MS,
    );
    const normalized = normalizeKiroUsage(output);
    if (!normalized) throw new Error("kiro_usage_malformed");

    attempts[0] = { source: KIRO_SOURCE, status: "success" };
    return successProvider({
      provider: "kiro",
      label: LABEL,
      source: "cli",
      plan: normalized.plan,
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (attempts[0]?.status !== "skipped")
      attempts[0] = { source: KIRO_SOURCE, status: "failed", error: message };
    return failedProvider({
      provider: "kiro",
      label: LABEL,
      status:
        message === "kiro_cli_unavailable"
          ? "unavailable"
          : statusFromError(message),
      error: message,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuthWithDependencies(
  dependencies: KiroDependencies,
): Promise<AuthProviderReport> {
  let source: AuthSourceReport;
  try {
    source = (await dependencies.findCommandPath(KIRO_COMMAND))
      ? { source: KIRO_SOURCE, status: "available" }
      : { source: KIRO_SOURCE, status: "missing" };
  } catch (error) {
    source = {
      source: KIRO_SOURCE,
      status: "error",
      error: errorMessage(error),
    };
  }
  return { provider: "kiro", sources: [source] };
}

/**
 * Normalize the stable lines emitted by `kiro-cli chat --no-interactive
 * /usage`, the vendor CLI's own usage view (there is no dedicated usage
 * subcommand; `whoami` reports identity only):
 *
 *   Estimated Usage | resets on 2026-10-01 | KIRO PRO+
 *   Credits (2000.00 of 2000 covered in plan), 100.0%
 *
 * The header names the view "Estimated Usage" and the credits line counts
 * against the plan allowance, so the percentage is consumed share
 * (`percentUsed`), corroborated by a 100.0% reading taken while the vendor
 * was refusing requests as monthly-exhausted ahead of the stated reset. The
 * vendor's own percentage is authoritative; the used/total ratio only
 * cross-checks it (within rounding tolerance) and never replaces it. A
 * mismatch fails closed rather than guessing which figure moved.
 *
 * `resets on <date>` is date-precision with no published timezone, so
 * `resetsAt` is the start of that date in UTC. No start or duration is
 * published, so none is derived.
 */
export function normalizeKiroUsage(
  output: unknown,
): NormalizedKiroUsage | undefined {
  if (typeof output !== "string") return undefined;
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines.find((line) => line.startsWith("Estimated Usage"));
  const credits = lines.find((line) => line.startsWith("Credits ("));
  if (!header || !credits) return undefined;

  const headerMatch =
    /^Estimated Usage\s*\|\s*resets on (\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s*$/.exec(
      header,
    );
  if (!headerMatch) return undefined;
  const resetsAt = parseResetDate(headerMatch[1]);
  if (!resetsAt) return undefined;
  const plan = headerMatch[2]?.trim() || undefined;

  const creditsMatch =
    /^Credits \(\s*([0-9]+(?:\.[0-9]+)?)\s+of\s+([0-9]+(?:\.[0-9]+)?)\s+covered in plan\s*\),\s*([0-9]+(?:\.[0-9]+)?)%\s*$/.exec(
      credits,
    );
  if (!creditsMatch) return undefined;
  const used = Number(creditsMatch[1]);
  const total = Number(creditsMatch[2]);
  const percent = Number(creditsMatch[3]);
  if (
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    !Number.isFinite(percent) ||
    total <= 0 ||
    used < 0 ||
    percent < 0 ||
    percent > 100
  ) {
    return undefined;
  }
  // Rounding budget: `used` carries 2 decimals and `percent` 1 decimal, so a
  // consistent pair agrees within half a point plus rounding slack.
  if (Math.abs(percent - (used / total) * 100) > 0.51) return undefined;

  const percentUsed = clampPercentage(percent);
  return {
    ...(plan ? { plan } : {}),
    windows: [
      {
        id: "monthly",
        label: "month",
        kind: "monthly",
        percentUsed,
        percentRemaining: 100 - percentUsed,
        resetsAt,
      },
    ],
  };
}

function parseResetDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "kiro_request_failed";
}
