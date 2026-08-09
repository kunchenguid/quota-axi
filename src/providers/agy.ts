import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readCachedProvider, deleteCachedProvider } from "../cache.js";
import { findCommandPath, terminateChild } from "../lib/process.js";
import { clampPercent, nowIso } from "../lib/time.js";
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
  staleFromCache,
  successProvider,
} from "./common.js";

export const AGY_BINARY_ENV = "QUOTA_AXI_AGY_BINARY";
export const AGY_ARGS = ["-p", "/usage", "--output-format", "json"] as const;
export const AGY_TIMEOUT_MS = 15_000;
export const AGY_MAX_OUTPUT_BYTES = 1_048_576;

type AgyBinaryState =
  | { status: "available"; path: string }
  | { status: "missing"; path?: string; error?: string };

export type NormalizedAgyUsage = {
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

type AgyCommandResult = { stdout: string; stderr: string; exitCode: number };
type AgyRuntime = {
  executablePath?: string;
  spawnImpl?: typeof spawn;
};

class AgyProcessError extends Error {
  constructor(
    readonly code:
      | "agy_process_failed"
      | "agy_auth_required"
      | "agy_process_timeout"
      | "agy_output_too_large"
      | "agy_spawn_failed",
  ) {
    super(code);
  }
}

class AgyProtocolError extends Error {
  constructor(readonly code: "agy_output_invalid" | "agy_output_unsupported") {
    super(code);
  }
}

export const agyAdapter: ProviderAdapter = {
  id: "antigravity",
  label: "Antigravity",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
  runtime: AgyRuntime = {},
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [
    {
      source: "cli-print",
      status: "failed",
    },
  ];
  const binary = runtime.executablePath
    ? { status: "available" as const, path: runtime.executablePath }
    : await resolveAgyBinary();
  if (binary.status === "missing") {
    const error = binary.error ?? "agy_executable_missing";
    deleteCachedProvider("antigravity");
    attempts[0] = { source: "cli-print", status: "failed", error };
    return failedProvider({
      provider: "antigravity",
      label: "Antigravity",
      status: "unavailable",
      source: "cli-print",
      error,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  try {
    const result = await runAgyCommand({
      executablePath: binary.path,
      spawnImpl: runtime.spawnImpl,
    });
    let parsed: NormalizedAgyUsage | undefined;
    try {
      parsed = normalizeAgyUsage(JSON.parse(result.stdout) as unknown);
    } catch {
      throw new AgyProtocolError("agy_output_invalid");
    }
    if (!parsed) throw new AgyProtocolError("agy_output_unsupported");
    attempts[0] = { source: "cli-print", status: "success" };
    const provider = successProvider({
      provider: "antigravity",
      label: "Antigravity",
      source: "cli-print",
      windows: parsed.windows,
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    if (parsed.untrustedWindowIds.length > 0)
      provider.state.untrustedWindowIds = parsed.untrustedWindowIds;
    return provider;
  } catch (error) {
    const code = errorCode(error);
    attempts[0] = { source: "cli-print", status: "failed", error: code };
    if (
      code === "agy_process_timeout" ||
      code === "agy_process_failed" ||
      code === "agy_spawn_failed"
    ) {
      const cached = readCachedProvider("antigravity");
      if (cached)
        return staleFromCache(cached, code, sourceNames(attempts), attempts);
    }
    if (
      code === "agy_auth_required" ||
      code === "agy_output_invalid" ||
      code === "agy_output_unsupported" ||
      code === "agy_output_too_large"
    )
      deleteCachedProvider("antigravity");
    return failedProvider({
      provider: "antigravity",
      label: "Antigravity",
      source: "cli-print",
      status: code === "agy_auth_required" ? "auth_required" : "error",
      error: code,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

export async function inspectAuth(
  _options: ProviderOptions,
  runtime: Pick<AgyRuntime, "executablePath"> = {},
): Promise<AuthProviderReport> {
  const binary = runtime.executablePath
    ? { status: "available" as const, path: runtime.executablePath }
    : await resolveAgyBinary();
  const source: AuthSourceReport = {
    source: "cli-print",
    path: binary.path,
    status: binary.status === "available" ? "available" : "missing",
    ...(binary.status === "missing" ? { error: binary.error } : {}),
  };
  return { provider: "antigravity", sources: [source] };
}

export async function resolveAgyBinary(): Promise<AgyBinaryState> {
  const configured = process.env[AGY_BINARY_ENV];
  if (configured !== undefined) {
    const path = configured.trim();
    if (!path || !isAbsolute(path))
      return {
        status: "missing",
        path,
        error: "agy_binary_override_not_absolute",
      };
    const executable = await findCommandPath(path);
    return executable
      ? { status: "available", path: executable }
      : {
          status: "missing",
          path,
          error: "agy_binary_override_not_executable",
        };
  }
  const executable = await findCommandPath("agy");
  return executable
    ? { status: "available", path: executable }
    : { status: "missing" };
}

export async function runAgyCommand(options: {
  executablePath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnImpl?: typeof spawn;
}): Promise<AgyCommandResult> {
  const timeoutMs = options.timeoutMs ?? AGY_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? AGY_MAX_OUTPUT_BYTES;
  const root = await mkdtemp(join(tmpdir(), "quota-axi-agy-"));
  const config = join(root, "config");
  const cache = join(root, "cache");
  const state = join(root, "state");
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const spawnImpl = options.spawnImpl ?? spawn;
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "NO_COLOR",
    "USER",
    "LOGNAME",
    "USERNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
  });
  let commandResult: AgyCommandResult | undefined;
  let commandError: unknown;
  try {
    await Promise.all(
      [config, cache, state].map((directory) =>
        mkdir(directory, { recursive: true, mode: 0o700 }),
      ),
    );
    commandResult = await new Promise<AgyCommandResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let terminationRequested = false;
      let failure: Error | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const requestFailure = (error: Error): void => {
        failure ??= error;
        if (!terminationRequested) {
          terminationRequested = true;
          terminateChild(child);
        }
      };
      let child: ChildProcess;
      try {
        const spawnOptions: SpawnOptions = {
          cwd: root,
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        };
        child = spawnImpl(options.executablePath, [...AGY_ARGS], spawnOptions);
      } catch {
        reject(new AgyProcessError("agy_spawn_failed"));
        return;
      }
      const timer = setTimeout(() => {
        requestFailure(new AgyProcessError("agy_process_timeout"));
      }, timeoutMs);
      const append = (target: "stdout" | "stderr", chunk: unknown): void => {
        const value = bufferValue(chunk);
        const valueBytes = value.byteLength;
        const currentBytes = target === "stdout" ? stdoutBytes : stderrBytes;
        if (currentBytes + valueBytes > maxOutputBytes) {
          requestFailure(new AgyProcessError("agy_output_too_large"));
          return;
        }
        if (target === "stdout") {
          stdoutChunks.push(value);
          stdoutBytes += valueBytes;
        } else {
          stderrChunks.push(value);
          stderrBytes += valueBytes;
        }
      };
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      child.on("error", () => {
        requestFailure(new AgyProcessError("agy_spawn_failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (failure) {
          settled = true;
          reject(failure);
          return;
        }
        if (code !== 0) {
          settled = true;
          const stderr = decodeChunks(stderrChunks);
          reject(
            new AgyProcessError(
              /sign.?in|auth|login|unauthori[sz]ed|credential/i.test(stderr)
                ? "agy_auth_required"
                : "agy_process_failed",
            ),
          );
          return;
        }
        settled = true;
        resolve({
          stdout: decodeChunks(stdoutChunks),
          stderr: "",
          exitCode: code ?? 0,
        });
      });
    });
  } catch (error) {
    commandError = error;
  }
  let cleanupError: unknown;
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (commandError !== undefined) throw commandError;
  if (cleanupError !== undefined) throw cleanupError;
  return commandResult!;
}

export function normalizeAgyUsage(
  raw: unknown,
): NormalizedAgyUsage | undefined {
  const envelope = objectValue(raw);
  const command = objectValue(envelope?.command);
  if (envelope?.status !== "SUCCESS" || command?.name !== "usage")
    return undefined;
  const data = objectValue(command)?.data;
  const groups = objectValue(data)?.groups;
  if (!Array.isArray(groups)) return undefined;
  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];
  const usedWindowIds = new Set<string>();
  const nextSuffixByBase = new Map<string, number>();
  for (const [groupIndex, groupRaw] of groups.entries()) {
    const group = objectValue(groupRaw);
    const buckets = group?.buckets;
    if (!group || !Array.isArray(buckets)) return undefined;
    const rawGroupId = identityStringValue(group.id);
    const groupIdentity = rawGroupId ? safeIdentity(rawGroupId) : undefined;
    const rawGroupName = stringValue(group.name);
    const groupLabel = safeLabel(
      rawGroupName ?? groupIdentity?.value ?? `Group ${groupIndex + 1}`,
    );
    for (const [bucketIndex, bucketRaw] of buckets.entries()) {
      const bucket = objectValue(bucketRaw);
      if (!bucket) return undefined;
      const rawBucketId = identityStringValue(bucket.id);
      const bucketIdentity = safeIdentity(
        rawBucketId ?? `bucket-${bucketIndex}`,
      );
      const baseBucketId = bucketIdentity.value;
      const baseId = groupIdentity
        ? `${groupIdentity.value}/${baseBucketId}`
        : baseBucketId;
      const allocation = allocateWindowId(
        baseId,
        usedWindowIds,
        nextSuffixByBase,
      );
      const id = allocation.id;
      if (allocation.collision) untrustedWindowIds.push(id);
      const bucketLabel = safeLabel(
        stringValue(bucket.name) ?? stringValue(bucket.label) ?? baseBucketId,
      );
      const period = classifyPeriod(bucket.window);
      const fraction = numberValue(
        bucket.remaining_fraction ?? bucket.remainingFraction,
      );
      const validFraction = fraction !== undefined && Number.isFinite(fraction);
      const boundedFraction = validFraction && fraction! >= 0 && fraction! <= 1;
      const clamped = boundedFraction ? fraction : undefined;
      const reset = parseResetTime(
        bucket.reset_time ?? bucket.resetTime ?? bucket.resetsAt,
      );
      if (
        (rawGroupId === undefined && rawGroupName === undefined) ||
        rawBucketId === undefined ||
        groupIdentity?.untrusted ||
        bucketIdentity.untrusted ||
        !validFraction ||
        !boundedFraction ||
        reset === undefined ||
        period.kind === "unknown"
      ) {
        untrustedWindowIds.push(id);
      }
      windows.push({
        id,
        label: `${groupLabel}: ${bucketLabel}`,
        kind: period.kind,
        ...(clamped === undefined
          ? {}
          : {
              percentRemaining: clampPercent(clamped * 100),
              percentUsed: clampPercent((1 - clamped) * 100),
            }),
        ...(reset === undefined ? {} : { resetsAt: reset }),
        ...(period.windowSeconds === undefined
          ? {}
          : { windowSeconds: period.windowSeconds }),
      });
    }
  }
  return { windows, untrustedWindowIds: [...new Set(untrustedWindowIds)] };
}

function allocateWindowId(
  baseId: string,
  usedWindowIds: Set<string>,
  nextSuffixByBase: Map<string, number>,
): { id: string; collision: boolean } {
  let suffix = nextSuffixByBase.get(baseId) ?? 1;
  let id = suffix === 1 ? baseId : `${baseId}_${suffix}`;
  while (usedWindowIds.has(id)) {
    suffix += 1;
    id = `${baseId}_${suffix}`;
  }
  usedWindowIds.add(id);
  nextSuffixByBase.set(baseId, suffix + 1);
  return { id, collision: id !== baseId };
}

function classifyPeriod(value: unknown): {
  kind: QuotaWindow["kind"];
  windowSeconds?: number;
} {
  if (typeof value !== "string") return { kind: "unknown" };
  switch (value) {
    case "5h":
      return { kind: "session", windowSeconds: 18_000 };
    case "weekly":
      return { kind: "weekly", windowSeconds: 604_800 };
    default:
      return { kind: "unknown" };
  }
}

function parseResetTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeIdentity(value: string): { value: string; untrusted: boolean } {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9_.:-]+/g, "-");
  const truncated = normalized.slice(0, 120);
  return {
    value: truncated || "unknown",
    untrusted:
      value !== trimmed || normalized !== trimmed || normalized !== truncated,
  };
}

function safeLabel(value: string): string {
  const sanitized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("");
  return sanitized.trim().slice(0, 160) || "Unknown";
}

function errorCode(error: unknown): string {
  if (error instanceof AgyProcessError || error instanceof AgyProtocolError)
    return error.code;
  return "agy_process_failed";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function identityStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bufferValue(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

function decodeChunks(chunks: Buffer[]): string {
  const totalBytes = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const combined = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index++)
      combined[offset + index] = chunk[index]!;
    offset += chunk.byteLength;
  }
  return combined.toString("utf8");
}
