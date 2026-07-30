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
    authStatus: provider.state.authStatus ?? "unknown",
    refreshedAt: provider.state.refreshedAt ?? "none",
  }));
  const windows = response.providers.flatMap((provider) =>
    provider.windows.map((window) => ({
      provider: provider.provider,
      id: window.id,
      label: window.label,
      percentRemaining: window.percentRemaining ?? "unknown",
      resetsAt: window.resetsAt ?? window.resetText ?? "unknown",
      pace: window.pace?.status ?? "unknown",
      state: provider.state.status,
    })),
  );
  const credits = response.providers
    .filter((provider) => provider.credits)
    .map((provider) => ({
      provider: provider.provider,
      remaining: provider.credits?.remaining ?? "unknown",
      unlimited: provider.credits?.unlimited ?? "unknown",
      unit: provider.credits?.unit ?? "unknown",
      state: provider.state.status,
    }));
  const effective = response.providers.flatMap((provider) => {
    const semantics = provider.quotaSemantics;
    if (!semantics || semantics.effectiveAvailability.length === 0) {
      const row = {
        provider: provider.provider,
        scope: "unresolved",
        effectivePercentRemaining: "unknown" as string | number,
        boundedBy: "none",
        limitingWindowIds: "unknown",
        runway: "unknown",
        usableRunwaySeconds: "unknown" as string | number,
        projectedExhaustedAt: "unknown",
        limitingWindowId: "unknown",
        projectionConfidence: "unknown",
        projectionBasis: "unknown",
        unmeasurableWindowIds: "none",
        unresolvedWindowIds:
          semantics?.unresolvedWindowIds?.join(" + ") ?? "none",
        relationshipStatus: semantics?.status ?? ("unknown" as const),
      };
      return [row];
    }
    return semantics.effectiveAvailability.map((availability) => ({
      provider: provider.provider,
      scope: availability.scope,
      effectivePercentRemaining:
        availability.effectivePercentRemaining ?? ("unknown" as const),
      boundedBy: availability.boundedBy.join(" + ") || "none",
      limitingWindowIds:
        availability.limitingWindowIds?.join(" + ") ?? "unknown",
      runway: availability.runway?.status ?? "unknown",
      usableRunwaySeconds:
        availability.runway?.usableRunwaySeconds ?? ("unknown" as const),
      projectedExhaustedAt:
        availability.runway?.projectedExhaustedAt ?? ("unknown" as const),
      limitingWindowId:
        availability.runway?.limitingWindowId ?? ("unknown" as const),
      projectionConfidence:
        availability.runway?.projectionConfidence ?? ("unknown" as const),
      projectionBasis:
        availability.runway?.projectionBasis ?? ("unknown" as const),
      unmeasurableWindowIds:
        availability.runway?.unmeasurableWindowIds?.join(" + ") ?? "none",
      unresolvedWindowIds: semantics.unresolvedWindowIds?.join(" + ") ?? "none",
      relationshipStatus: semantics.status,
    }));
  });
  const blocks = [
    encode({
      bin: collapseHome(binPath),
      description:
        "Report local agent-provider quota windows for routing-aware agents",
      generatedAt: response.generatedAt,
    }),
    encode({ providers }),
    ...(credits.length > 0 ? [encode({ credits })] : []),
    encode({ windows }),
    encode({ effective }),
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
    const windowPace = response.providers.flatMap((provider) =>
      provider.windows.map((window) => ({
        provider: provider.provider,
        id: window.id,
        reserve: window.pace?.reservePercentPoints ?? "unknown",
        burnMultiple: window.pace?.burnMultiple ?? "unknown",
        projectedExhaustedAt:
          window.pace?.projectedExhaustedAt ?? ("unknown" as const),
        projectionConfidence:
          window.pace?.projectionConfidence ?? ("unknown" as const),
        projectionBasis: window.pace?.projectionBasis ?? ("unknown" as const),
      })),
    );
    const effectivePace = response.providers.flatMap((provider) =>
      (provider.quotaSemantics?.effectiveAvailability ?? []).map(
        (availability) => ({
          provider: provider.provider,
          scope: availability.scope,
          pace: availability.pace?.status ?? "unknown",
          aheadWindowIds:
            availability.pace?.aheadWindowIds?.join(" + ") ?? "none",
          unknownWindowIds:
            availability.pace?.unknownWindowIds?.join(" + ") ?? "none",
          worstReserve:
            availability.pace?.worstReservePercentPoints ??
            ("unknown" as const),
          worstReserveWindowId:
            availability.pace?.worstReserveWindowId ?? ("unknown" as const),
        }),
      ),
    );
    const accounts = response.providers.map((provider) => ({
      provider: provider.provider,
      email: provider.account?.email ?? "hidden",
      organization: provider.account?.organization ?? "none",
      accountId: provider.account?.accountId ?? "none",
      identityStatus: provider.account?.identityStatus ?? "unknown",
    }));
    const attempts = response.providers.flatMap((provider) =>
      (provider.attempts ?? []).map((attempt) => attemptRow(provider, attempt)),
    );
    blocks.push(encode({ windowPace }));
    blocks.push(encode({ effectivePace }));
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
