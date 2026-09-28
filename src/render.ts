import { encode } from "@toon-format/toon";
import { quotaHelpLines } from "./advice.js";
import { accountColumns } from "./providers/accounts.js";
import { collapseHome } from "./lib/fs.js";
import { isUsageFetchFailure } from "./providers/usage-fetch-failure.js";
import { SELECTION_SCALAR_KEY } from "./types.js";
import type {
  AuthProviderReport,
  BoundConflict,
  EffectiveAvailability,
  ModelsResponse,
  ProviderId,
  ProviderQuota,
  QuotaAxiResponse,
  QuotaSemantics,
  QuotaWindow,
  SourceAttempt,
} from "./types.js";

const UNKNOWN = "unknown";
const NONE = "none";
const ID_SEPARATOR = " + ";
/** Kept out of `,` so a detail never forces TOON string quoting on its own. */
const DETAIL_SEPARATOR = " · ";

export function renderHelp(lines: string[]): string {
  return `help[${lines.length}]:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

/**
 * One measurable scope. Every column is populated for every row, and rows stay
 * in provider-declaration and account-discovery order: a `spendPriority`
 * column must never read as a published ranking.
 */
type QuotaRow = {
  provider: ProviderId;
  accountKey?: string;
  scope: string;
  effectivePercentRemaining: number;
  [SELECTION_SCALAR_KEY]: number | string;
  runway: string;
  confidence: string;
  limitedBy: string;
  resetsAt: string;
};

/**
 * Sparse: a scope appears only when it has a finite exhaustion point, so it
 * joins back to exactly one `quota[]` row on `provider` + `scope`, plus
 * `accountKey` when the report is account-expanded.
 */
type ExhaustionRow = {
  provider: ProviderId;
  accountKey?: string;
  scope: string;
  usableRunwaySeconds: number | string;
  projectedExhaustedAt: string;
  limitingWindowId: string;
};

/** Sparse: every non-nominal fact, so uncertainty is named rather than padded. */
type AttentionRow = {
  provider: ProviderId;
  accountKey?: string;
  scope: string;
  kind: string;
  detail: string;
  remedy: string;
};

type ProviderBlocks = {
  quota: QuotaRow[];
  exhaustion: ExhaustionRow[];
  attention: AttentionRow[];
};

/**
 * Render the default decision-shaped report: one `quota[]` row per measurable
 * scope, plus the sparse `exhaustion[]` and `attention[]` blocks. Providers
 * named in `omitProviderIds` drop out of those blocks and are counted in one
 * help line. `--full` ignores that list (it adds the audit blocks and never
 * subtracts) and prints no omission line. Demotion happens here, never at
 * computation, so `--tui` and the normalized model keep every field.
 */
export function renderQuotaToon(
  response: QuotaAxiResponse,
  binPath: string,
  full: boolean,
  omitProviderIds: readonly ProviderId[] = [],
): string {
  const omit = new Set(full ? [] : omitProviderIds);
  const shown =
    omit.size === 0
      ? response
      : {
          ...response,
          providers: response.providers.filter(
            (provider) => !omit.has(provider.provider),
          ),
        };
  const { quota, exhaustion, attention } = quotaBlocks(shown);
  const blocks = [
    encode({
      bin: collapseHome(binPath),
      description:
        "Report local agent-provider quota windows for routing-aware agents",
      generatedAt: response.generatedAt,
    }),
    encode({ quota }),
    encode({ exhaustion }),
    encode({ attention }),
  ];

  if (full) blocks.push(...auditBlocks(response));
  blocks.push(renderHelp(quotaHelpLines(response, omit.size)));
  return blocks.filter(Boolean).join("\n");
}

/**
 * Contract invariant: every provider this function is given appears at least
 * once, in `quota[]` or `attention[]`, and never in metric order. Default
 * TOON omission of not-set-up providers happens before this runs.
 */
function quotaBlocks(response: QuotaAxiResponse): ProviderBlocks {
  const blocks: ProviderBlocks = { quota: [], exhaustion: [], attention: [] };
  for (const provider of response.providers) {
    const scopes = provider.quotaSemantics?.effectiveAvailability ?? [];
    const scopeAttention: AttentionRow[] = [];
    let measured = false;

    for (const scope of scopes) {
      if (scope.effectivePercentRemaining === undefined) {
        scopeAttention.push({
          ...providerColumns(provider),
          scope: scope.scope,
          kind: scope.boundConflict ? "bound_conflict" : "headroom_unknown",
          detail: scope.boundConflict
            ? boundConflictDetail(scope.boundConflict)
            : unknownHeadroomDetail(scope),
          remedy: NONE,
        });
      } else {
        measured = true;
        blocks.quota.push(quotaRow(provider, scope));
        const exhaustion = exhaustionRow(provider, scope);
        if (exhaustion) blocks.exhaustion.push(exhaustion);
        const blocked = blockedSignals(scope);
        if (blocked) {
          scopeAttention.push({
            ...providerColumns(provider),
            scope: scope.scope,
            kind: "unmeasurable",
            detail: blocked,
            remedy: NONE,
          });
        }
      }
    }

    blocks.attention.push(
      ...providerAttention(provider, measured, scopeAttention.length),
    );
    blocks.attention.push(...shareRows(provider));
    blocks.attention.push(...scopeAttention);
  }
  return blocks;
}

function quotaRow(
  provider: ProviderQuota,
  scope: EffectiveAvailability,
): QuotaRow {
  return {
    ...providerColumns(provider),
    scope: scope.scope,
    effectivePercentRemaining: scope.effectivePercentRemaining as number,
    // `unknown`, never `0`: `0` is exact utilization, a different claim.
    [SELECTION_SCALAR_KEY]: scope.selection?.[SELECTION_SCALAR_KEY] ?? UNKNOWN,
    runway: scope.runway?.status ?? UNKNOWN,
    confidence: scope.runway?.projectionConfidence ?? UNKNOWN,
    limitedBy: joinIds(scope.limitingWindowIds) ?? UNKNOWN,
    resetsAt: bindingReset(provider.windows, scope),
  };
}

function exhaustionRow(
  provider: ProviderQuota,
  scope: EffectiveAvailability,
): ExhaustionRow | undefined {
  const runway = scope.runway;
  if (
    runway?.status !== "exhausted_now" &&
    runway?.status !== "projected_exhaustion"
  ) {
    return undefined;
  }
  return {
    ...providerColumns(provider),
    scope: scope.scope,
    usableRunwaySeconds: runway.usableRunwaySeconds ?? UNKNOWN,
    projectedExhaustedAt: runway.projectedExhaustedAt ?? UNKNOWN,
    limitingWindowId: runway.limitingWindowId ?? UNKNOWN,
  };
}

/**
 * Provider-level facts. A provider with no `quota[]` row always ends up with at
 * least one row across this block and its scope rows, so it can never be
 * silently absent, and it always states its auth fact - positive included -
 * rather than only a degraded one.
 */
function providerAttention(
  provider: ProviderQuota,
  measured: boolean,
  scopeRows: number,
): AttentionRow[] {
  // Degraded sources are appended, never counted: they name the provider but
  // not why a scope is missing, so they must not suppress the `no_quota` row.
  return [
    ...providerStateRows(provider, measured, scopeRows),
    ...degradedSourceRows(provider),
  ];
}

function shareRows(provider: ProviderQuota): AttentionRow[] {
  return provider.windows
    .filter((window) => window.shareOf)
    .map((window) => ({
      ...providerColumns(provider),
      scope: "all",
      kind: "share",
      detail: shareDetail(window),
      remedy: NONE,
    }));
}

function shareDetail(window: QuotaWindow): string {
  const relationship = `${window.id} of ${window.shareOf}`;
  return window.percentUsed === undefined
    ? relationship
    : `${relationship}${DETAIL_SEPARATOR}${window.percentUsed}`;
}

/**
 * A working sibling answered for this provider, so the rows above are healthy
 * and this is the only place the superseded breakage is still stated.
 */
function degradedSourceRows(provider: ProviderQuota): AttentionRow[] {
  return (provider.state.degradedSources ?? []).map((degraded) => ({
    ...providerColumns(provider),
    scope: "all",
    kind: "degraded_source",
    detail: degraded.error
      ? `${degraded.source}${DETAIL_SEPARATOR}${degraded.error}`
      : degraded.source,
    remedy: NONE,
  }));
}

function providerStateRows(
  provider: ProviderQuota,
  measured: boolean,
  scopeRows: number,
): AttentionRow[] {
  const rows: AttentionRow[] = [];
  const primary = primaryProviderRow(provider);
  if (primary) rows.push(primary);
  if (provider.state.reused) {
    rows.push({
      ...providerColumns(provider),
      scope: "all",
      kind: "reused",
      detail: `last refreshed ${provider.state.refreshedAt ?? UNKNOWN}`,
      remedy: NONE,
    });
  }
  const unresolved = joinIds(provider.quotaSemantics?.unresolvedWindowIds);
  if (unresolved) {
    rows.push({
      ...providerColumns(provider),
      scope: "all",
      kind: "unresolved_windows",
      detail: unresolved,
      remedy: NONE,
    });
  }
  const untrusted = joinIds(provider.state.untrustedWindowIds);
  if (untrusted) {
    rows.push({
      ...providerColumns(provider),
      scope: "all",
      kind: "untrusted_windows",
      detail: untrusted,
      remedy: NONE,
    });
  }
  if (measured) return rows;

  const authStatus = provider.state.authStatus;
  const suffix = authStatus ? ` (auth ${authStatus})` : "";
  if (primary) {
    primary.detail += suffix;
    return rows;
  }
  const credits = creditBalance(provider);
  if (credits) {
    rows.unshift({
      ...providerColumns(provider),
      scope: "all",
      kind: "credits",
      detail: `${credits}${suffix}`,
      remedy: provider.state.remedyCommand ?? NONE,
    });
    return rows;
  }
  // No status row to carry the auth fact. Emit one when there is an auth
  // status to state, or when nothing else would name this provider at all.
  if (suffix === "" && rows.length + scopeRows > 0) return rows;
  rows.unshift({
    ...providerColumns(provider),
    scope: "all",
    kind: "no_quota",
    detail: `${provider.state.error ?? "no measurable scope"}${suffix}`,
    remedy: provider.state.remedyCommand ?? NONE,
  });
  return rows;
}

/**
 * A provider that reports a raw credit balance but no measurable scope has a
 * real number to state. Naming it keeps the default report from contradicting
 * the same run's `credits` with a bare `no_quota`, without inventing a
 * percentage or a routing bound from a balance that has no cap.
 */
function creditBalance(provider: ProviderQuota): string | undefined {
  const credits = provider.credits;
  if (!credits) return undefined;
  if (credits.unlimited) return "credits unlimited";
  if (credits.remaining === undefined) return undefined;
  return `remaining ${credits.remaining} ${credits.unit ?? "credits"}`;
}

function primaryProviderRow(provider: ProviderQuota): AttentionRow | undefined {
  const state = provider.state;
  if (!state.stale && state.status === "fresh") return undefined;
  const kind = state.stale ? "stale" : state.status;
  const staleDetail = [
    `last refreshed ${state.refreshedAt ?? UNKNOWN}`,
    state.error
      ? `${isUsageFetchFailure(provider) ? "fetch failed " : ""}${state.error}`
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(DETAIL_SEPARATOR);
  const baseDetail = state.stale ? staleDetail : (state.error ?? kind);
  const detail = state.reason
    ? `${baseDetail}${DETAIL_SEPARATOR}reason ${state.reason}`
    : baseDetail;
  return {
    ...providerColumns(provider),
    scope: "all",
    kind,
    detail: state.retryAfter
      ? `${detail} retry after ${state.retryAfter}`
      : detail,
    remedy: state.remedyCommand ?? NONE,
  };
}

/**
 * State both sides of a bound conflict, so the reason the scope has no number
 * is the contradiction itself rather than a bare list of blocking windows.
 */
function boundConflictDetail(conflict: BoundConflict): string {
  return [
    `${joinIds(conflict.exhaustedWindowIds) ?? UNKNOWN} reads 0`,
    `${joinIds(conflict.liveWindowIds) ?? UNKNOWN} still report allowance`,
  ].join(DETAIL_SEPARATOR);
}

/** Which windows suppress the scope's headroom, so absence is explained. */
function headroomBlockers(scope: EffectiveAvailability): string {
  return joinIds(unmeasurableIds(scope)) ?? joinIds(scope.boundedBy) ?? UNKNOWN;
}

function unknownHeadroomDetail(scope: EffectiveAvailability): string {
  const blockers = headroomBlockers(scope);
  const runway = scope.runway;
  if (
    runway?.status !== "exhausted_now" &&
    runway?.status !== "projected_exhaustion"
  ) {
    return blockers;
  }
  return `${blockers}${DETAIL_SEPARATOR}${runway.status} limited by ${runway.limitingWindowId ?? UNKNOWN}`;
}

/** Which windows block a derived signal on a scope that does report headroom. */
function blockedSignals(scope: EffectiveAvailability): string | undefined {
  const runwayIds = scope.runway?.unmeasurableWindowIds ?? [];
  const selectionIds = scope.selection?.unmeasurableWindowIds ?? [];
  if (runwayIds.length === 0 && selectionIds.length === 0) return undefined;
  if (runwayIds.length > 0 && sameIds(runwayIds, selectionIds)) {
    return `${joinIds(runwayIds)} blocks runway + ${SELECTION_SCALAR_KEY}`;
  }
  const segments: string[] = [];
  if (runwayIds.length > 0)
    segments.push(`${joinIds(runwayIds)} blocks runway`);
  if (selectionIds.length > 0) {
    segments.push(`${joinIds(selectionIds)} blocks ${SELECTION_SCALAR_KEY}`);
  }
  return segments.join(DETAIL_SEPARATOR);
}

function unmeasurableIds(scope: EffectiveAvailability): string[] {
  return [
    ...new Set([
      ...(scope.runway?.unmeasurableWindowIds ?? []),
      ...(scope.selection?.unmeasurableWindowIds ?? []),
    ]),
  ];
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/** The binding window's own reset: the one fact that made `windows[]` load-bearing. */
function bindingReset(
  windows: QuotaWindow[],
  scope: EffectiveAvailability,
): string {
  for (const id of scope.limitingWindowIds ?? []) {
    const window = windows.find((candidate) => candidate.id === id);
    const reset = window?.resetsAt ?? window?.resetText;
    if (reset) return reset;
  }
  return UNKNOWN;
}

function joinIds(ids: string[] | undefined): string | undefined {
  return ids && ids.length > 0 ? ids.join(ID_SEPARATOR) : undefined;
}

/** `--full` audit tier: every derivation input the lean blocks summarize. */
function auditBlocks(response: QuotaAxiResponse): string[] {
  const providers = response.providers.map((provider) => ({
    ...providerColumns(provider),
    plan: provider.plan ?? UNKNOWN,
    source: provider.source ?? UNKNOWN,
    status: provider.state.status,
    authStatus: provider.state.authStatus ?? UNKNOWN,
    relationships: provider.quotaSemantics?.status ?? UNKNOWN,
    refreshedAt: provider.state.refreshedAt ?? NONE,
  }));
  const windows = response.providers.flatMap((provider) =>
    provider.windows.map((window) => ({
      ...providerColumns(provider),
      id: window.id,
      label: window.label,
      percentRemaining: window.percentRemaining ?? UNKNOWN,
      resetsAt: window.resetsAt ?? window.resetText ?? UNKNOWN,
      pace: window.pace?.status ?? UNKNOWN,
      reserve: window.pace?.reservePercentPoints ?? UNKNOWN,
      burnMultiple: window.pace?.burnMultiple ?? UNKNOWN,
      timeRemainingPercent: window.pace?.timeRemainingPercent ?? UNKNOWN,
      elapsedPercent: window.pace?.elapsedPercent ?? UNKNOWN,
      cycleSeconds: window.pace?.cycleSeconds ?? UNKNOWN,
      projectedExhaustedAt: window.pace?.projectedExhaustedAt ?? UNKNOWN,
      confidence: window.pace?.projectionConfidence ?? UNKNOWN,
    })),
  );
  const scopeAudit = response.providers.flatMap((provider) =>
    (provider.quotaSemantics?.effectiveAvailability ?? []).map((scope) => ({
      ...providerColumns(provider),
      scope: scope.scope,
      boundedBy: joinIds(scope.boundedBy) ?? NONE,
      relationships: provider.quotaSemantics?.status ?? UNKNOWN,
      pace: scope.pace?.status ?? UNKNOWN,
      aheadWindowIds: joinIds(scope.pace?.aheadWindowIds) ?? NONE,
      behindWindowIds: joinIds(scope.pace?.behindWindowIds) ?? NONE,
      onPaceWindowIds: joinIds(scope.pace?.onPaceWindowIds) ?? NONE,
      unknownWindowIds: joinIds(scope.pace?.unknownWindowIds) ?? NONE,
      worstReserve: scope.pace?.worstReservePercentPoints ?? UNKNOWN,
      worstReserveWindowId: scope.pace?.worstReserveWindowId ?? UNKNOWN,
    })),
  );
  const accounts = response.providers.map((provider) => ({
    ...providerColumns(provider),
    email: provider.account?.email ?? "hidden",
    organization: provider.account?.organization ?? NONE,
    accountId: provider.account?.accountId ?? NONE,
    identityStatus: provider.account?.identityStatus ?? UNKNOWN,
  }));
  const attempts = response.providers.flatMap((provider) =>
    (provider.attempts ?? []).map((attempt) => attemptRow(provider, attempt)),
  );
  return [
    encode({ providers }),
    encode({ windows }),
    encode({ scopeAudit }),
    encode({ accounts }),
    encode({ attempts }),
  ];
}

export function renderAuthToon(
  reports: AuthProviderReport[],
  binPath: string,
): string {
  const sources = reports.flatMap((report) =>
    report.sources.map((source) => ({
      provider: report.provider,
      ...accountColumns(report),
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
      "Run `quota-axi --allow-keychain-prompt auth` to permit native secure-store access",
    ]),
  ].join("\n");
}

export function renderModelsToon(
  response: ModelsResponse,
  binPath: string,
  full: boolean,
): string {
  const models = response.models.map((model) => ({
    provider: model.provider,
    ...accountColumns(model),
    id: model.id,
    label: model.label,
    intelligence: model.intelligence,
    quotaScopes: model.quotaScopes.join(" + ") || "unknown",
    status: model.state.status,
    stale: model.state.stale,
    effectivePercentRemaining:
      model.effective?.effectivePercentRemaining ?? ("unknown" as const),
    runway: model.effective?.runway?.status ?? "unknown",
    usableRunwaySeconds:
      model.effective?.runway?.usableRunwaySeconds ?? ("unknown" as const),
  }));
  const blocks = [
    encode({
      bin: collapseHome(binPath),
      description:
        "Join curated provider-native model intelligence buckets with local quota evidence",
      generatedAt: response.generatedAt,
      catalogVersion: response.catalog.version,
    }),
    encode({ models }),
  ];
  if (response.sort) blocks.push(encode({ sort: response.sort }));
  if (response.unmatchedWindowIds?.length) {
    blocks.push(encode({ unmatchedWindowIds: response.unmatchedWindowIds }));
  }
  if (full) {
    const evidence = response.models.map((model) => ({
      provider: model.provider,
      ...accountColumns(model),
      id: model.id,
      boundedBy: model.effective?.boundedBy.join(" + ") ?? "unknown",
      limitingWindowIds:
        model.effective?.limitingWindowIds?.join(" + ") ?? "unknown",
      projectedExhaustedAt:
        model.effective?.runway?.projectedExhaustedAt ?? "unknown",
      authStatus: model.state.authStatus ?? "unknown",
      reason: model.state.reason ?? "none",
      remedyCommand: model.state.remedyCommand ?? "none",
    }));
    blocks.push(encode({ evidence }));
  }
  blocks.push(
    renderHelp([
      response.schemaVersion === 2
        ? "Default model order is deterministic and non-preferential (provider, accountKey, then id)"
        : "Default model order is deterministic and non-preferential (provider, then id)",
      "Run `quota-axi models --sort runway` for the documented opt-in runway comparator",
      "Run `quota-axi models --json` for catalog provenance and full quota evidence",
    ]),
  );
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

/**
 * The `--json` payload: redaction plus derivation-input demotion. Structure and
 * field names are untouched - a demoted field is simply absent until `--full`.
 * Eligibility and uncertainty fields are never demoted, so an unknown can never
 * read as healthy.
 */
export function quotaJsonReport(
  response: QuotaAxiResponse,
  full: boolean,
  laneAbsent: readonly boolean[] = [],
): QuotaAxiResponse {
  const redacted = redactedResponse(markNotSetUp(response, laneAbsent), full);
  if (full) return redacted;
  return {
    ...redacted,
    providers: redacted.providers.map((provider) => ({
      ...provider,
      label: undefined,
      source: undefined,
      windows: provider.windows.map(demotedWindow),
      ...(provider.quotaSemantics
        ? { quotaSemantics: demotedSemantics(provider.quotaSemantics) }
        : {}),
      state: {
        ...provider.state,
        // A reused reading's age is load-bearing, so its fetch time stays.
        refreshedAt: provider.state.reused
          ? provider.state.refreshedAt
          : undefined,
        sourcesTried: undefined,
      },
    })),
  };
}

/**
 * Sparse `notSetUp: true` on lanes the caller already classified absent.
 * The flags are computed before redaction strips `attempts`. An empty list
 * leaves the model untouched, so a caller that has not classified adds nothing.
 */
function markNotSetUp(
  response: QuotaAxiResponse,
  laneAbsent: readonly boolean[],
): QuotaAxiResponse {
  if (!laneAbsent.some(Boolean)) return response;
  return {
    ...response,
    providers: response.providers.map((provider, index) =>
      laneAbsent[index] ? { ...provider, notSetUp: true } : provider,
    ),
  };
}

function demotedWindow(window: QuotaWindow): QuotaWindow {
  return {
    ...window,
    percentUsed: window.shareOf === undefined ? undefined : window.percentUsed,
    startsAt: undefined,
    windowSeconds: undefined,
    ...(window.pace
      ? {
          pace: {
            // Kept: `reason` is uncertainty, reserve and burn are tie-break
            // evidence. Dropped: the inputs those two are derived from.
            status: window.pace.status,
            ...(window.pace.reason ? { reason: window.pace.reason } : {}),
            reservePercentPoints: window.pace.reservePercentPoints,
            burnMultiple: window.pace.burnMultiple,
          },
        }
      : {}),
  };
}

function demotedSemantics(semantics: QuotaSemantics): QuotaSemantics {
  return {
    ...semantics,
    description: undefined,
    effectiveAvailability: semantics.effectiveAvailability.map(
      (availability) => ({
        ...availability,
        ...(availability.pace
          ? {
              pace: {
                ...availability.pace,
                behindWindowIds: undefined,
                onPaceWindowIds: undefined,
              },
            }
          : {}),
      }),
    ),
  };
}

function attemptRow(provider: ProviderQuota, attempt: SourceAttempt) {
  return {
    ...providerColumns(provider),
    source: attempt.source,
    status: attempt.status,
    error: attempt.error ?? "none",
  };
}

function providerColumns(provider: ProviderQuota) {
  return {
    provider: provider.provider,
    ...accountColumns(provider),
  };
}
