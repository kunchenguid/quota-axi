import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { findCommandPath } from "../lib/process.js";
import type { ProviderStatus, QuotaWindow } from "../types.js";
import { withRemaining } from "./common.js";

const NATIVE_TIMEOUT_MS = 55_000;
const NATIVE_KILL_GRACE_MS = 2_000;
const MAX_DEBUG_BYTES = 4 * 1024 * 1024;
const FIVE_HOURS_SECONDS = 18_000;
const SEVEN_DAYS_SECONDS = 604_800;

const CLAUDE_ARGS = [
  "--debug",
  "api",
  "--debug-file",
  "/dev/stderr",
  "--print",
  "--safe-mode",
  "--strict-mcp-config",
  "--tools",
  "",
  "--permission-prompts",
  "none",
  "--no-session-persistence",
  "--no-chrome",
  "--disable-slash-commands",
  "--prompt-suggestions",
  "false",
  "--model",
  "sonnet",
  "--effort",
  "low",
  "--max-budget-usd",
  "0.05",
  "--output-format",
  "text",
  "Reply with exactly OK and nothing else.",
] as const;

export type ClaudeNativeQuotaResult =
  | { kind: "success"; windows: QuotaWindow[]; refreshedAt: string }
  | {
      kind: "failure";
      error: string;
      status: ProviderStatus;
      retryAfter?: string;
      /** Validated unified windows the rate-limited response itself carried. */
      windows?: QuotaWindow[];
    };

type NativeProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimited: boolean;
};

export type ClaudeNativeQuotaDependencies = {
  findClaude?: () => Promise<string | undefined>;
  makeScratch?: () => string;
  run?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<NativeProcessResult>;
  now?: () => number;
};

/**
 * Run Claude Code's own bounded inference path and retain only allowlisted
 * quota headers from its SDK debug stream. The raw stream is never returned or
 * written to disk.
 */
export async function fetchClaudeNativeQuota(
  dependencies: ClaudeNativeQuotaDependencies = {},
): Promise<ClaudeNativeQuotaResult> {
  if (process.platform === "win32") return incompatible();
  if ((process.env.ANTHROPIC_API_KEY ?? "").trim() !== "") {
    return failure("claude_native_api_key_present");
  }
  if ((process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim() !== "") {
    return failure("claude_native_auth_token_present");
  }
  const callerCwd = process.cwd();
  const discoveredCommand = await (
    dependencies.findClaude ?? (() => findCommandPath("claude"))
  )();
  if (!discoveredCommand) return incompatible();
  const command = isAbsolute(discoveredCommand)
    ? discoveredCommand
    : resolve(callerCwd, discoveredCommand);

  let scratch: string | undefined;
  try {
    const run = dependencies.run ?? runNativeProcess;
    let result: NativeProcessResult;
    try {
      scratch = (dependencies.makeScratch ?? makeScratchDirectory)();
      result = await run(command, CLAUDE_ARGS, {
        cwd: scratch,
        env: {
          ...process.env,
          ANTHROPIC_LOG: "debug",
          CLAUDE_CODE_MAX_RETRIES: "0",
          CLAUDE_CODE_RETRY_WATCHDOG: "0",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      });
    } catch {
      return failure("claude_native_process_failed");
    }

    const now = dependencies.now?.() ?? Date.now();
    const parsed = selectNativeObservation(
      parseClaudeNativeDebug(result.stdout, now),
      parseClaudeNativeDebug(result.stderr, now),
    );
    if (isCompleteRateLimitObservation(parsed)) return parsed;
    if (result.timedOut) return failure("claude_native_timeout");
    if (result.outputLimited) return failure("claude_native_output_limit");
    if (parsed.kind === "failure") {
      if (parsed.status === "rate_limited") return parsed;
      if (result.exitCode !== 0 || result.signal !== null) {
        return failure("claude_native_process_failed");
      }
      return parsed;
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      return failure("claude_native_process_failed");
    }
    return parsed;
  } finally {
    if (scratch !== undefined) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * The Anthropic SDK's default console logger writes debug records to stdout,
 * while Claude's own debug sink can use stderr. Treat the streams as
 * independent observations so unrelated model/application output cannot join
 * fragments across the stream boundary.
 */
function selectNativeObservation(
  stdout: ClaudeNativeQuotaResult,
  stderr: ClaudeNativeQuotaResult,
): ClaudeNativeQuotaResult {
  const observed = [stdout, stderr].filter(
    (result) =>
      result.kind === "success" || isCompleteRateLimitObservation(result),
  );
  if (observed.length === 0) {
    return (
      [stdout, stderr].find(
        (result) =>
          result.kind === "failure" && result.status === "rate_limited",
      ) ?? failure("claude_native_quota_unavailable")
    );
  }
  if (observed.length === 1) return observed[0]!;
  return JSON.stringify(observed[0]) === JSON.stringify(observed[1])
    ? observed[0]!
    : failure("claude_native_quota_unavailable");
}

/**
 * A 429 outranks a later execution or output bound only when the observation
 * is complete: bare status digits from a truncated block prove nothing about
 * the limit, so they must not replace an honest timeout verdict.
 */
function isCompleteRateLimitObservation(
  parsed: ClaudeNativeQuotaResult,
): boolean {
  return (
    parsed.kind === "failure" &&
    parsed.status === "rate_limited" &&
    (parsed.retryAfter !== undefined || parsed.windows !== undefined)
  );
}

function makeScratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), "quota-axi-claude-"));
}

/** Parse only status, Retry-After, and unified 5h/7d quota headers. */
export function parseClaudeNativeDebug(
  raw: string,
  now = Date.now(),
): ClaudeNativeQuotaResult {
  const clean = stripVTControlCharacters(raw);
  const responsePattern =
    /\[(log_[^\]]+)\] response start([\s\S]{0,12000}?)(?=\[log_|$)/g;
  let latestBlock: string | undefined;
  for (const match of clean.matchAll(responsePattern)) {
    latestBlock = match[2];
  }
  if (latestBlock === undefined)
    return failure("claude_native_quota_unavailable");

  const status = responseStatus(latestBlock);
  const windows = parsedWindows(latestBlock, now);
  if (status === 429) {
    const retryAfterAt = boundedRetryAfter(
      stringHeader(latestBlock, "retry-after"),
      now,
    );
    return {
      kind: "failure",
      error: "claude_native_rate_limited",
      status: "rate_limited",
      ...(retryAfterAt ? { retryAfter: retryAfterAt } : {}),
      ...(windows.length > 0 ? { windows } : {}),
    };
  }
  if (status === 200 && windows.length > 0) {
    return {
      kind: "success",
      windows,
      refreshedAt: new Date(now).toISOString(),
    };
  }
  return failure("claude_native_quota_unavailable");
}

function parsedWindows(block: string, now: number): QuotaWindow[] {
  const windows = [
    parsedWindow(
      block,
      "5h",
      "five_hour",
      "session",
      "session",
      FIVE_HOURS_SECONDS,
      now,
    ),
    parsedWindow(
      block,
      "7d",
      "seven_day",
      "week",
      "weekly",
      SEVEN_DAYS_SECONDS,
      now,
    ),
  ];
  return windows.every((window): window is QuotaWindow => window !== undefined)
    ? windows
    : [];
}

function parsedWindow(
  block: string,
  headerSlug: string,
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  windowSeconds: number,
  now: number,
): QuotaWindow | undefined {
  const utilization = numericHeader(
    block,
    `anthropic-ratelimit-unified-${headerSlug}-utilization`,
  );
  const reset = numericHeader(
    block,
    `anthropic-ratelimit-unified-${headerSlug}-reset`,
  );
  if (
    utilization === undefined ||
    utilization < 0 ||
    utilization > 1 ||
    reset === undefined ||
    reset * 1000 < now - 86_400_000 ||
    reset * 1000 > now + 31_536_000_000
  ) {
    return undefined;
  }
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: utilization * 100,
    resetsAt: new Date(reset * 1000).toISOString(),
    windowSeconds,
  });
}

function responseStatus(block: string): number | undefined {
  const match = block.match(/status[^0-9]{0,10}([1-5][0-9]{2})/i);
  return match ? Number(match[1]) : undefined;
}

function numericHeader(block: string, name: string): number | undefined {
  const raw = stringHeader(block, name);
  if (raw === undefined || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function stringHeader(block: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(
    new RegExp(
      `${escaped}["']?\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^"',}\\s]+))`,
      "i",
    ),
  );
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function boundedRetryAfter(
  raw: string | undefined,
  now: number,
): string | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 604_800
      ? new Date(now + seconds * 1000).toISOString()
      : undefined;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) &&
    timestamp >= now &&
    timestamp <= now + 604_800_000
    ? new Date(timestamp).toISOString()
    : undefined;
}

function incompatible(): ClaudeNativeQuotaResult {
  return failure("claude_native_incompatible");
}

function failure(
  error: string,
  status: ProviderStatus = "unavailable",
): ClaudeNativeQuotaResult {
  return { kind: "failure", error, status };
}

function runNativeProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<NativeProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(processFailure());
      return;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let settled = false;
    let interrupted: NodeJS.Signals | undefined;
    let resumeDefaultSignal = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const stop = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The child can exit between the process-group and direct kill.
        }
      }
    };
    const scheduleForceKill = (): void => {
      if (forceKill) return;
      forceKill = setTimeout(() => {
        stop("SIGKILL");
        if (interrupted) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(processFailure());
        }
      }, NATIVE_KILL_GRACE_MS);
      forceKill.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      scheduleForceKill();
    }, NATIVE_TIMEOUT_MS);
    timeout.unref();

    const collect = (target: string[], chunk: Buffer | string): void => {
      const text = chunk.toString();
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_DEBUG_BYTES) {
        if (outputLimited) return;
        outputLimited = true;
        stop("SIGTERM");
        scheduleForceKill();
        return;
      }
      target.push(text);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const onSignal = (signal: NodeJS.Signals): void => {
      if (interrupted) return;
      interrupted = signal;
      resumeDefaultSignal = process.listenerCount(signal) === 1;
      stop("SIGTERM");
      scheduleForceKill();
    };
    const onInterrupt = (): void => onSignal("SIGINT");
    const onTerminate = (): void => onSignal("SIGTERM");
    const finish = (result: NativeProcessResult): void => {
      if (settled) return;
      settled = true;
      if (interrupted) stop("SIGKILL");
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      resolve(result);
      if (interrupted && resumeDefaultSignal) {
        const signal = interrupted;
        setImmediate(() => process.kill(process.pid, signal));
      }
    };
    process.prependListener("SIGINT", onInterrupt);
    process.prependListener("SIGTERM", onTerminate);
    child.once("error", () => finish(processFailure()));
    child.once("close", (exitCode, signal) => {
      finish({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode,
        signal,
        timedOut,
        outputLimited,
      });
    });
  });
}

function processFailure(): NativeProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 1,
    signal: null,
    timedOut: false,
    outputLimited: false,
  };
}
