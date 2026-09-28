import { homedir } from "node:os";
import { join } from "node:path";
import * as processUtils from "../lib/process.js";
import { traceInput } from "../lib/input-trace.js";
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
const KIRO_WHOAMI_ARGS = ["whoami", "-f", "json"];
const KIRO_TIMEOUT_MS = 15_000;
const KIRO_SIGN_IN_ERROR = "kiro_sign_in_required";
const KIRO_SIGN_IN_REMEDY = "kiro-cli login";
const LABEL = "Kiro";

type KiroDependencies = {
  findCommandPath: typeof processUtils.findCommandPath;
  execFileText: typeof processUtils.execFileText;
  now: () => number;
  credentialStorePath: () => string | undefined;
};

export type NormalizedKiroUsage = {
  plan?: string;
  windows: QuotaWindow[];
};

/**
 * The signed-in identity `kiro-cli whoami -f json` reports for the account the
 * usage view would read. `signed_out` is the CLI's own "Not logged in" answer;
 * `malformed` is output the published shape does not explain.
 */
type KiroIdentity =
  | { status: "signed_in"; email?: string; accountType?: string }
  | { status: "signed_out" }
  | { status: "malformed" };

export function createKiroAdapter(
  overrides: Partial<KiroDependencies> = {},
): ProviderAdapter {
  const dependencies: KiroDependencies = {
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    execFileText: (...args) => processUtils.execFileText(...args),
    now: Date.now,
    credentialStorePath: kiroCredentialStorePath,
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
    credentialStorePath: kiroCredentialStorePath,
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

    // The usage read derives entirely from the vendor CLI's credential store,
    // so a sign-out or account switch must invalidate a cached reading. The
    // store is stat-traced, never opened, which binds --max-age fresh reuse to
    // the exact store state this reading came from without reading a secret.
    const storePath = dependencies.credentialStorePath();
    if (storePath) traceInput(storePath);

    // `chat` launches a browser sign-in flow when no account is logged in, so
    // identity is established first and a signed-out CLI never reaches it.
    const identity = await readKiroIdentity(commandPath, dependencies);
    if (identity.status === "signed_out") throw new Error(KIRO_SIGN_IN_ERROR);
    if (identity.status === "malformed")
      throw new Error("kiro_whoami_malformed");

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
      ...(identity.email ? { account: { email: identity.email } } : {}),
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (attempts[0]?.status !== "skipped")
      attempts[0] = { source: KIRO_SOURCE, status: "failed", error: message };
    const report = failedProvider({
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
    if (message === KIRO_SIGN_IN_ERROR)
      report.state.remedyCommand = KIRO_SIGN_IN_REMEDY;
    return report;
  }
}

async function inspectAuthWithDependencies(
  dependencies: KiroDependencies,
): Promise<AuthProviderReport> {
  let source: AuthSourceReport;
  try {
    const commandPath = await dependencies.findCommandPath(KIRO_COMMAND);
    if (!commandPath) {
      source = { source: KIRO_SOURCE, status: "missing" };
    } else {
      try {
        const identity = await readKiroIdentity(commandPath, dependencies);
        source =
          identity.status === "signed_in"
            ? { source: KIRO_SOURCE, status: "available" }
            : identity.status === "signed_out"
              ? {
                  source: KIRO_SOURCE,
                  status: "missing",
                  error: KIRO_SIGN_IN_ERROR,
                }
              : {
                  source: KIRO_SOURCE,
                  status: "error",
                  error: "kiro_whoami_malformed",
                };
      } catch (error) {
        source = {
          source: KIRO_SOURCE,
          status: "error",
          error: errorMessage(error),
        };
      }
    }
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
 * `kiro-cli whoami -f json` is the vendor's own signed-in probe: it exits 0
 * with `{"accountType": ..., "email": ...}` for a logged-in account and exits
 * nonzero with `{"account": null}` ("Not logged in" in plain output) when no
 * account is signed in. A nonzero exit from `whoami` means the CLI ran and
 * reported no session; a spawn failure, signal, or timeout is not a sign-out
 * and propagates as a plain error.
 */
async function readKiroIdentity(
  commandPath: string,
  dependencies: KiroDependencies,
): Promise<KiroIdentity> {
  let output: string;
  try {
    output = await dependencies.execFileText(
      commandPath,
      KIRO_WHOAMI_ARGS,
      KIRO_TIMEOUT_MS,
    );
  } catch (error) {
    if (isCleanNonzeroExit(error)) return { status: "signed_out" };
    throw error;
  }
  return parseKiroWhoami(output);
}

export function parseKiroWhoami(output: unknown): KiroIdentity {
  if (typeof output !== "string") return { status: "malformed" };
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return { status: "malformed" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { status: "malformed" };
  const root = data as Record<string, unknown>;
  // Current builds print top-level accountType/email; the `account` key is
  // `null` when signed out and may wrap the same fields on others.
  if ("account" in root && root.account === null)
    return { status: "signed_out" };
  const record =
    root.account &&
    typeof root.account === "object" &&
    !Array.isArray(root.account)
      ? (root.account as Record<string, unknown>)
      : root;
  const email = nonempty(record.email);
  const accountType = nonempty(record.accountType);
  if (!email && !accountType) return { status: "signed_out" };
  return {
    status: "signed_in",
    ...(email ? { email } : {}),
    ...(accountType ? { accountType } : {}),
  };
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isCleanNonzeroExit(error: unknown): boolean {
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
  } | null;
  return (
    typeof failure?.code === "number" &&
    failure.code !== 0 &&
    !failure.signal &&
    !failure.killed
  );
}

/**
 * The credential store `kiro-cli` reads for this user. Stat-traced as a
 * reading input so a login that rewrites it can never be served another
 * account's cached reading; a store that lives elsewhere traces as absent,
 * which still distinguishes absent from present on the next reuse check.
 */
function kiroCredentialStorePath(): string | undefined {
  const home = homedir();
  if (!home) return undefined;
  return join(home, ".local", "share", "kiro-cli", "data.sqlite3");
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

/**
 * A `YYYY-MM-DD` the vendor printed is a calendar claim, and `Date.parse`
 * normalizes impossible dates (`2026-02-30` becomes `2026-03-02`), which
 * would publish a reset the vendor never stated. Only a date that round-trips
 * its own year, month, and day in UTC is accepted.
 */
function parseResetDate(value: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date.toISOString();
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
