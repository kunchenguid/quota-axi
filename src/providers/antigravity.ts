import { execFileText } from "../lib/process.js";
import { nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
} from "../types.js";
import { failedProvider, successProvider } from "./common.js";

export const antigravityAdapter: ProviderAdapter = {
  id: "antigravity",
  label: "Antigravity",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const session = `quota-axi-agy-${Date.now()}`;
  try {
    await execFileText(
      "tmux",
      ["new-session", "-d", "-s", session, "-x", "100", "-y", "60", "agy"],
      10_000,
    );
    try {
      await waitForPane(session, /Gemini|Claude|>|\/usage/i, 8_000);
      await execFileText(
        "tmux",
        ["send-keys", "-t", session, "/usage", "Enter"],
        5_000,
      );
      await waitForPane(
        session,
        /Models\s*&?\s*Quota|\d+%\s+remaining|Quota\s+available/i,
        8_000,
      );
      const output = await execFileText(
        "tmux",
        ["capture-pane", "-t", session, "-p", "-S", "-200"],
        5_000,
      );
      const windows = parseAntigravityQuota(output);
      if (windows.length === 0)
        throw new Error("agy /usage returned no quota windows");
      return successProvider({
        provider: "antigravity",
        label: "Antigravity",
        source: "official-cli",
        windows,
        refreshedAt: nowIso(),
        sourcesTried: ["agy /usage"],
      });
    } finally {
      await execFileText("tmux", ["kill-session", "-t", session], 5_000).catch(
        () => undefined,
      );
    }
  } catch (error) {
    return failedProvider({
      provider: "antigravity",
      label: "Antigravity",
      source: "official-cli",
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      sourcesTried: ["agy /usage"],
    });
  }
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return {
    provider: "antigravity",
    sources: [
      {
        source: "agy-cli",
        status: "available",
        error: "quota is collected through the bounded /usage TUI probe",
      },
    ],
  };
}

async function waitForPane(
  session: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pane = await execFileText(
        "tmux",
        ["capture-pane", "-t", session, "-p"],
        2_000,
      );
      if (pattern.test(pane)) return;
    } catch {
      // The next bounded poll distinguishes slow startup from a dead session.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`agy TUI timeout waiting for ${pattern}`);
}

const percent = /(\d+)%\s+remaining\s+·\s+Refreshes\s+in\s+(\d+)h\s+(\d+)m/;
const available = /Quota\s+available/i;
const windowHeader =
  /^\s*(Weekly\s+Limit|Five\s+Hour\s+Limit|Daily\s+Limit|Monthly\s+Limit)/i;
const groupHeader = /^\s*([A-Z][A-Z\s&]+MODELS)/;

export function parseAntigravityQuota(output: string): QuotaWindow[] {
  const lines = output.split("\n");
  const windows: QuotaWindow[] = [];
  const seen = new Set<string>();
  let group = "";
  for (let index = 0; index < lines.length; index++) {
    const groupMatch = lines[index]?.match(groupHeader);
    if (groupMatch) {
      group = groupMatch[1]
        .toLowerCase()
        .replace(/ models/g, "")
        .replace(/ /g, "_")
        .replace("claude_and_gpt", "claude");
    }
    const match = lines[index]?.match(percent);
    const isAvailable = available.test(lines[index] ?? "");
    if (!match && !isAvailable) continue;
    const label = `${group ? `${group}/` : ""}${findHeader(lines, index)}`;
    if (seen.has(label)) continue;
    seen.add(label);
    if (isAvailable) {
      windows.push({
        id: label,
        label,
        kind: headerKind(label),
        percentUsed: 0,
        percentRemaining: 100,
      });
      continue;
    }
    const used = 100 - Number(match?.[1]);
    const reset = new Date(
      Date.now() + Number(match?.[2]) * 3_600_000 + Number(match?.[3]) * 60_000,
    ).toISOString();
    windows.push({
      id: label,
      label,
      kind: headerKind(label),
      percentUsed: used,
      percentRemaining: 100 - used,
      resetsAt: reset,
    });
  }
  return windows;
}

function findHeader(lines: string[], index: number): string {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 10); cursor--) {
    const match = lines[cursor]?.match(windowHeader);
    if (match) return match[1].toLowerCase().replace(/ /g, "_");
  }
  return "window";
}

function headerKind(label: string): QuotaWindow["kind"] {
  if (label.includes("weekly")) return "weekly";
  if (label.includes("five_hour")) return "session";
  if (label.includes("monthly")) return "monthly";
  return "unknown";
}
