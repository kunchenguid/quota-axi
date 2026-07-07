import { encode } from "@toon-format/toon";
import { quotaHelpLines } from "./advice.js";
import { collapseHome } from "./lib/fs.js";
import type {
  AuthProviderReport,
  ProviderQuota,
  QuotaAxiResponse,
  SourceAttempt,
} from "./types.js";

export function renderHelp(lines: string[]): string {
  return `help[${lines.length}]:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

export function renderQuotaToon(
  response: QuotaAxiResponse,
  binPath: string,
  full: boolean,
): string {
  const providers = response.providers.map((provider) => ({
    provider: provider.provider,
    plan: provider.plan ?? "unknown",
    source: provider.source,
    status: provider.state.status,
    refreshedAt: provider.state.refreshedAt ?? "none",
  }));
  const windows = response.providers.flatMap((provider) =>
    provider.windows.map((window) => ({
      provider: provider.provider,
      id: window.id,
      label: window.label,
      percentRemaining: window.percentRemaining ?? "unknown",
      resetsAt: window.resetsAt ?? window.resetText ?? "unknown",
      state: provider.state.status,
    })),
  );
  const blocks = [
    encode({
      bin: collapseHome(binPath),
      description:
        "Report local agent-provider quota windows for routing-aware agents",
      generatedAt: response.generatedAt,
    }),
    encode({ providers }),
    encode({ windows }),
  ];
  const advice = response.providers
    .filter((provider) => provider.state.reason && provider.state.remedyCommand)
    .map((provider) => ({
      provider: provider.provider,
      reason: provider.state.reason,
      remedyCommand: provider.state.remedyCommand,
    }));
  if (advice.length > 0) blocks.push(encode({ advice }));

  if (full) {
    const accounts = response.providers.map((provider) => ({
      provider: provider.provider,
      email: provider.account?.email ?? "hidden",
      organization: provider.account?.organization ?? "none",
      accountId: provider.account?.accountId ?? "none",
    }));
    const attempts = response.providers.flatMap((provider) =>
      (provider.attempts ?? []).map((attempt) => attemptRow(provider, attempt)),
    );
    blocks.push(encode({ accounts }));
    blocks.push(encode({ attempts }));
  }

  blocks.push(renderHelp(quotaHelpLines(response)));
  return blocks.filter(Boolean).join("\n");
}

export function renderAuthToon(
  reports: AuthProviderReport[],
  binPath: string,
): string {
  const sources = reports.flatMap((report) =>
    report.sources.map((source) => ({
      provider: report.provider,
      source: source.source,
      path: source.path ? collapseHome(source.path) : "none",
      status: source.status,
      error: source.error ?? "none",
    })),
  );
  return [
    encode({
      bin: collapseHome(binPath),
      description:
        "Inspect local quota auth sources without printing secret values",
    }),
    encode({ auth: sources }),
    renderHelp([
      "Run `quota-axi --allow-keychain-prompt auth` to permit macOS Keychain access",
    ]),
  ].join("\n");
}

export function renderError(
  message: string,
  code = "error",
  help: string[] = [],
): string {
  const blocks = [encode({ error: message, code })];
  if (help.length > 0) blocks.push(renderHelp(help));
  return blocks.join("\n");
}

export function redactedResponse(
  response: QuotaAxiResponse,
  full: boolean,
): QuotaAxiResponse {
  if (full) return response;
  return {
    ...response,
    providers: response.providers.map((provider) => ({
      ...provider,
      account: undefined,
      attempts: undefined,
    })),
  };
}

function attemptRow(provider: ProviderQuota, attempt: SourceAttempt) {
  return {
    provider: provider.provider,
    source: attempt.source,
    status: attempt.status,
    error: attempt.error ?? "none",
  };
}
