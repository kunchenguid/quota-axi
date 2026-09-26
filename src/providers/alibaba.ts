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

const BL_COMMAND = "bl";
const BL_SOURCE = "bl-cli";
const BL_ARGS = ["usage", "token-plan", "--output", "json"];
const BL_TIMEOUT_MS = 15_000;
const LABEL = "Alibaba Coding Plan";

type AlibabaDependencies = {
  findCommandPath: typeof processUtils.findCommandPath;
  execFileText: typeof processUtils.execFileText;
  now: () => number;
};

export type NormalizedAlibabaUsage = {
  plan?: string;
  windows: QuotaWindow[];
};

export function createAlibabaAdapter(
  overrides: Partial<AlibabaDependencies> = {},
): ProviderAdapter {
  const dependencies: AlibabaDependencies = {
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    execFileText: (...args) => processUtils.execFileText(...args),
    now: Date.now,
    ...overrides,
  };

  return {
    id: "alibaba",
    label: LABEL,
    fetchQuota: (_options: ProviderOptions) =>
      fetchQuotaWithDependencies(dependencies),
    inspectAuth: (_options: ProviderOptions) =>
      inspectAuthWithDependencies(dependencies),
  };
}

export const alibabaAdapter = createAlibabaAdapter();

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
  dependencies: AlibabaDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [{ source: BL_SOURCE, status: "failed" }];

  try {
    const commandPath = await dependencies.findCommandPath(BL_COMMAND);
    if (!commandPath) {
      attempts[0] = {
        source: BL_SOURCE,
        status: "skipped",
        error: "bl_cli_unavailable",
      };
      throw new Error("bl_cli_unavailable");
    }

    const output = await dependencies.execFileText(
      commandPath,
      BL_ARGS,
      BL_TIMEOUT_MS,
    );
    const raw = JSON.parse(output);
    if (!isAlibabaUsagePayload(raw)) throw new Error("bl_usage_malformed_json");
    const normalized = normalizeAlibabaUsage(raw);

    attempts[0] = { source: BL_SOURCE, status: "success" };
    return successProvider({
      provider: "alibaba",
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
      attempts[0] = { source: BL_SOURCE, status: "failed", error: message };
    return failedProvider({
      provider: "alibaba",
      label: LABEL,
      status:
        message === "bl_cli_unavailable"
          ? "unavailable"
          : statusFromError(message),
      error: message,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuthWithDependencies(
  dependencies: AlibabaDependencies,
): Promise<AuthProviderReport> {
  let source: AuthSourceReport;
  try {
    source = (await dependencies.findCommandPath(BL_COMMAND))
      ? { source: BL_SOURCE, status: "available" }
      : { source: BL_SOURCE, status: "missing" };
  } catch (error) {
    source = {
      source: BL_SOURCE,
      status: "error",
      error: errorMessage(error),
    };
  }
  return { provider: "alibaba", sources: [source] };
}

/** Normalize the stable fields emitted by `bl usage token-plan --output json`. */
export function normalizeAlibabaUsage(raw: unknown): NormalizedAlibabaUsage {
  const root = objectValue(raw);
  if (!root) return { windows: [] };
  const usage = numberValue(root.per1WeekPercentage);
  const windows: QuotaWindow[] = [];
  if (usage !== undefined) {
    const percentUsed = clampPercentage(usage <= 1 ? usage * 100 : usage);
    const percentRemaining = 100 - percentUsed;
    const reset = parseAlibabaReset(root.per1WeekResetTime);
    windows.push({
      id: "weekly",
      label: "week",
      kind: "weekly",
      percentUsed,
      percentRemaining,
      ...(reset ? { resetsAt: reset } : {}),
    });
  }

  return {
    plan: stringValue(root.planName) ?? stringValue(root.plan) ?? LABEL,
    windows: [...windows, ...normalizeAlibabaModelLimits(root.limits)],
  };
}

function isAlibabaUsagePayload(raw: unknown): boolean {
  const root = objectValue(raw);
  if (!root) return false;
  const hasRecognizedField = [
    "planName",
    "plan",
    "per1WeekPercentage",
    "per1WeekResetTime",
    "limits",
  ].some((key) => key in root);
  if (!hasRecognizedField) return false;
  const hasUsageEvidence = [
    "planName",
    "plan",
    "per1WeekPercentage",
    "limits",
  ].some((key) => key in root);
  if (!hasUsageEvidence) return false;
  if (
    ("planName" in root && typeof root.planName !== "string") ||
    ("plan" in root && typeof root.plan !== "string") ||
    ("per1WeekPercentage" in root &&
      numberValue(root.per1WeekPercentage) === undefined) ||
    ("per1WeekResetTime" in root &&
      !isValidAlibabaResetValue(root.per1WeekResetTime)) ||
    ("limits" in root &&
      (!Array.isArray(root.limits) ||
        root.limits.some((limit) => !isValidAlibabaModelLimit(limit))))
  ) {
    return false;
  }
  return true;
}

function isValidAlibabaResetValue(value: unknown): boolean {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 100_000_000_000 ? value : value * 1000);
    return !Number.isNaN(date.getTime());
  }
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isValidAlibabaModelLimit(value: unknown): boolean {
  const entry = objectValue(value);
  if (!entry) return false;
  const details =
    objectValue(entry.limit) ??
    objectValue(entry.quota) ??
    objectValue(entry.modelLimit) ??
    objectValue(entry.model_limit);
  const record = details ? { ...entry, ...details } : entry;
  const model = firstString(record, ["model", "modelName", "model_name"]);
  if (!model) return false;
  const remaining = firstNumber(record, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const fraction = firstNumber(record, ["per1WeekPercentage"]);
  const used =
    fraction !== undefined
      ? fraction <= 1
        ? fraction * 100
        : fraction
      : firstNumber(record, [
          "percentUsed",
          "usedPercent",
          "usagePercent",
          "percentage",
          "percent",
        ]);
  return remaining !== undefined || used !== undefined;
}

function normalizeAlibabaModelLimits(value: unknown): QuotaWindow[] {
  if (!Array.isArray(value)) return [];
  const occurrences = new Map<string, number>();
  const ids = new Set<string>();
  const windows: QuotaWindow[] = [];
  for (const rawLimit of value) {
    const entry = objectValue(rawLimit);
    if (!entry) continue;
    const details =
      objectValue(entry.limit) ??
      objectValue(entry.quota) ??
      objectValue(entry.modelLimit) ??
      objectValue(entry.model_limit);
    const record = details ? { ...entry, ...details } : entry;
    const model = firstString(record, ["model", "modelName", "model_name"]);
    if (!model) continue;

    const remaining = firstNumber(record, [
      "percentRemaining",
      "remainingPercent",
    ]);
    const fraction = firstNumber(record, ["per1WeekPercentage"]);
    const used =
      fraction !== undefined
        ? fraction <= 1
          ? fraction * 100
          : fraction
        : firstNumber(record, [
            "percentUsed",
            "usedPercent",
            "usagePercent",
            "percentage",
            "percent",
          ]);
    const percentRemaining =
      remaining !== undefined
        ? clampPercentage(remaining)
        : used !== undefined
          ? clampPercentage(100 - used)
          : undefined;
    if (percentRemaining === undefined) continue;

    const baseId = `model:${model}`;
    const occurrence = (occurrences.get(baseId) ?? 0) + 1;
    occurrences.set(baseId, occurrence);
    let suffix = occurrence;
    let id = occurrence === 1 ? baseId : `${baseId}:${suffix}`;
    while (ids.has(id)) {
      id = `${baseId}:${suffix}`;
      suffix += 1;
    }
    ids.add(id);
    const reset = parseAlibabaReset(
      firstValue(record, [
        "resetsAt",
        "resetAt",
        "reset_at",
        "per1WeekResetTime",
        "nextResetTime",
      ]),
    );
    windows.push({
      id,
      label: model,
      kind: "model",
      percentUsed: clampPercentage(100 - percentRemaining),
      percentRemaining,
      ...(reset ? { resetsAt: reset } : {}),
    });
  }
  return windows;
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

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return keys.map((key) => stringValue(value[key])).find(Boolean);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  return keys
    .map((key) => numberValue(value[key]))
    .find((item) => item !== undefined);
}

function firstValue(
  value: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  return keys
    .map((key) => value[key])
    .find((item) => item !== undefined && item !== null);
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseAlibabaReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 100_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "bl_usage_malformed_json";
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message === "bl_usage_malformed_json") return message;
    if (message === "bl_cli_unavailable") return message;
    return message
      ? `bl_usage_failed: ${message.slice(0, 240)}`
      : "bl_usage_failed";
  }
  return "bl_usage_failed";
}
