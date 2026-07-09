import { execFileText } from "../lib/process.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  statusFromError,
} from "./common.js";

const PROCESS_TIMEOUT_MS = 5_000;
const PORT_TIMEOUT_MS = 2_000;

type AgyProcessSource = "agy" | "app";

export type AgyProcessInfo = {
  pid: number;
  command: string;
  source: AgyProcessSource;
  csrfToken?: string;
  extensionPort?: number;
  extensionServerCsrfToken?: string;
};

export type AgyConnectionEndpoint = {
  scheme: "https" | "http";
  port: number;
  source: AgyProcessSource;
  pid: number;
  csrfToken?: string;
  requiresCsrfToken: boolean;
  requiresUnleashProbe: boolean;
};

export type AgyProbeRuntime = {
  execFileText(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string>;
};

export const agyAdapter: ProviderAdapter = {
  id: "agy",
  label: "Antigravity",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWithRuntime(defaultRuntime);
}

export async function fetchQuotaWithRuntime(
  runtime: AgyProbeRuntime,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [{ source: "loopback", status: "failed" }];
  let finalError: string;

  try {
    const endpoints = await discoverAgyEndpoints(runtime);
    if (endpoints.length === 0)
      throw new AgyUnavailableError("Antigravity/agy is not running");
    throw new AgyUnavailableError("Antigravity quota RPC client unavailable");
  } catch (error) {
    finalError = errorMessage(error);
    attempts[0] = {
      source: "loopback",
      status: error instanceof AgyUnavailableError ? "skipped" : "failed",
      error: finalError,
    };
  }

  return failedProvider({
    provider: "agy",
    label: "Antigravity",
    status: statusForError(finalError),
    error: finalError,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const endpoints = await discoverAgyEndpoints(defaultRuntime);
  return {
    provider: "agy",
    sources: [
      {
        source: "loopback",
        status: endpoints.length > 0 ? "available" : "missing",
      },
    ],
  };
}

export function processInfosFromPs(output: string): AgyProcessInfo[] {
  const processes: AgyProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2].trim();
    if (!Number.isInteger(pid) || command.length === 0) continue;
    const source = agyProcessSource(command);
    if (!source) continue;
    processes.push({
      pid,
      command,
      source,
      csrfToken: flagValue(command, "csrf_token"),
      extensionPort: numberValue(flagValue(command, "extension_server_port")),
      extensionServerCsrfToken: flagValue(
        command,
        "extension_server_csrf_token",
      ),
    });
  }
  return processes;
}

export function portsFromLsof(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/TCP\s+(?:\[[^\]]+\]|[^:]+):(\d+)\s+\(LISTEN\)/);
    const port = match ? Number(match[1]) : undefined;
    if (port && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

async function discoverAgyEndpoints(
  runtime: AgyProbeRuntime,
): Promise<AgyConnectionEndpoint[]> {
  const processes = processInfosFromPs(await readProcessList(runtime));
  const endpoints: AgyConnectionEndpoint[] = [];
  for (const processInfo of processes) {
    const listeningPorts = await readListeningPorts(runtime, processInfo.pid);
    if (processInfo.source === "agy") {
      for (const port of listeningPorts) {
        endpoints.push(
          endpointFor(processInfo, "https", port, undefined, false, false),
          endpointFor(processInfo, "http", port, undefined, false, false),
        );
      }
      continue;
    }

    if (processInfo.csrfToken) {
      for (const port of listeningPorts) {
        endpoints.push(
          endpointFor(
            processInfo,
            "https",
            port,
            processInfo.csrfToken,
            true,
            true,
          ),
          endpointFor(
            processInfo,
            "http",
            port,
            processInfo.csrfToken,
            true,
            true,
          ),
        );
      }
    }

    if (processInfo.extensionPort) {
      const token =
        processInfo.extensionServerCsrfToken ?? processInfo.csrfToken;
      if (token) {
        endpoints.push(
          endpointFor(
            processInfo,
            "http",
            processInfo.extensionPort,
            token,
            true,
            true,
          ),
        );
      }
    }
  }
  return endpoints.sort(compareEndpoints);
}

function endpointFor(
  processInfo: AgyProcessInfo,
  scheme: AgyConnectionEndpoint["scheme"],
  port: number,
  csrfToken: string | undefined,
  requiresCsrfToken: boolean,
  requiresUnleashProbe: boolean,
): AgyConnectionEndpoint {
  return {
    scheme,
    port,
    source: processInfo.source,
    pid: processInfo.pid,
    csrfToken,
    requiresCsrfToken,
    requiresUnleashProbe,
  };
}

async function readProcessList(runtime: AgyProbeRuntime): Promise<string> {
  if (process.platform === "win32") return "";
  try {
    return await runtime.execFileText(
      "ps",
      ["-axo", "pid=,command="],
      PROCESS_TIMEOUT_MS,
    );
  } catch {
    return "";
  }
}

async function readListeningPorts(
  runtime: AgyProbeRuntime,
  pid: number,
): Promise<number[]> {
  if (process.platform === "win32") return [];
  try {
    return portsFromLsof(
      await runtime.execFileText(
        "lsof",
        ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
        PORT_TIMEOUT_MS,
      ),
    );
  } catch {
    return [];
  }
}

function agyProcessSource(command: string): AgyProcessSource | undefined {
  const executable = executableName(command);
  if (executable === "agy") return "agy";
  const lowered = command.toLowerCase();
  if (lowered.includes("antigravity-cli") && lowered.includes("mcp-server.cjs"))
    return "agy";
  if (
    /language[-_]server(?:_[a-z0-9_]+)?/i.test(command) &&
    lowered.includes("antigravity")
  )
    return "app";
  return undefined;
}

function executableName(command: string): string | undefined {
  const token = command.trim().split(/\s+/, 1)[0];
  if (!token) return undefined;
  const name = token.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  return name?.replace(/\.exe$/, "");
}

function flagValue(command: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)--${name}(?:=([^\\s]+)|\\s+([^\\s]+))`);
  const match = command.match(pattern);
  return match?.[1] ?? match?.[2];
}

function portsFromEndpoint(endpoint: AgyConnectionEndpoint): number {
  return endpoint.port;
}

function compareEndpoints(
  left: AgyConnectionEndpoint,
  right: AgyConnectionEndpoint,
): number {
  const sourceRank = sourceSortRank(left.source) - sourceSortRank(right.source);
  if (sourceRank !== 0) return sourceRank;
  const portRank = portsFromEndpoint(left) - portsFromEndpoint(right);
  if (portRank !== 0) return portRank;
  return schemeSortRank(left.scheme) - schemeSortRank(right.scheme);
}

function sourceSortRank(source: AgyProcessSource): number {
  return source === "agy" ? 0 : 1;
}

function schemeSortRank(scheme: AgyConnectionEndpoint["scheme"]): number {
  return scheme === "https" ? 0 : 1;
}

function statusForError(error: string): ProviderStatus {
  if (
    /not running|no local|loopback timed out|ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EPIPE|EPROTO|socket hang up/i.test(
      error,
    )
  )
    return "unavailable";
  return statusFromError(error);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Antigravity quota unavailable";
}

class AgyUnavailableError extends Error {}

const defaultRuntime: AgyProbeRuntime = {
  execFileText,
};
