import {
  computeEffectiveRunway,
  computeWindowPace,
  summarizeEffectivePace,
  summarizeEffectiveSelection,
} from "./pace.js";
import type {
  EffectiveAvailability,
  ProviderQuota,
  QuotaSemantics,
  QuotaWindow,
} from "./types.js";

export function withQuotaSemantics(
  provider: ProviderQuota,
  generatedAt: string,
): ProviderQuota {
  const windows = provider.windows.map((window) => ({
    ...window,
    pace: computeWindowPace(window, generatedAt, {
      stale: provider.state.stale,
    }),
  }));
  const withWindows = { ...provider, windows };
  const semantics = semanticsFor(withWindows, generatedAt);
  return {
    ...withWindows,
    quotaSemantics: provider.state.stale
      ? staleSemantics(semantics)
      : semantics,
  };
}

function staleSemantics(semantics: QuotaSemantics): QuotaSemantics {
  return {
    status: semantics.status === "partial" ? "partial" : "unknown",
    description:
      "The raw quota windows are stale diagnostic data, so effective remaining is unknown until the provider refreshes successfully.",
    effectiveAvailability: semantics.effectiveAvailability.map(
      ({ scope, boundedBy, pace }) => ({
        scope,
        status: "unknown",
        boundedBy,
        runway: {
          status: "unknown" as const,
          ...(boundedBy.length > 0 ? { unmeasurableWindowIds: boundedBy } : {}),
        },
        selection: {
          status: "unknown" as const,
          ...(boundedBy.length > 0 ? { unmeasurableWindowIds: boundedBy } : {}),
        },
        ...(pace
          ? {
              pace: {
                status: "unknown" as const,
                ...(pace.unknownWindowIds
                  ? { unknownWindowIds: pace.unknownWindowIds }
                  : boundedBy.length > 0
                    ? { unknownWindowIds: boundedBy }
                    : {}),
              },
            }
          : boundedBy.length > 0
            ? {
                pace: {
                  status: "unknown" as const,
                  unknownWindowIds: boundedBy,
                },
              }
            : {}),
      }),
    ),
    ...(semantics.unresolvedWindowIds
      ? { unresolvedWindowIds: semantics.unresolvedWindowIds }
      : {}),
  };
}

function semanticsFor(
  provider: ProviderQuota,
  generatedAt: string,
): QuotaSemantics {
  switch (provider.provider) {
    case "claude":
      return claudeSemantics(provider.windows, generatedAt);
    case "codex":
      return codexSemantics(provider.windows, generatedAt);
    case "grok":
      return grokSemantics(provider.windows, generatedAt);
    case "kimi":
      return kimiSemantics(
        provider.windows,
        provider.state.untrustedWindowIds ?? [],
        generatedAt,
      );
    case "zai":
      return zaiSemantics(
        provider.windows,
        provider.state.untrustedWindowIds ?? [],
        generatedAt,
      );
    case "cursor":
      return cursorSemantics(provider.windows, generatedAt);
    case "copilot":
    case "agy":
      return unknownSemantics(
        provider.windows,
        `quota-axi does not know whether ${provider.label ?? provider.provider}'s reported windows are independent or jointly bounding, so it does not claim an effective remaining percentage.`,
      );
  }
}

function claudeSemantics(
  windows: QuotaWindow[],
  generatedAt: string,
): QuotaSemantics {
  const account = windows.filter(({ id }) =>
    ["five_hour", "seven_day"].includes(id),
  );
  const models = windows.filter(({ kind }) => kind === "model");
  const unresolved = windows.filter(
    ({ id, kind }) =>
      !["five_hour", "seven_day", "extra_usage"].includes(id) &&
      kind !== "model",
  );
  if (unresolved.length > 0) {
    return partialSemantics(
      unresolved,
      "Claude account windows bound every model and model windows add another bound, but unfamiliar windows prevent a definitive effective percentage.",
    );
  }

  const effectiveAvailability: EffectiveAvailability[] = [];
  if (account.length > 0) {
    effectiveAvailability.push(
      availability("all_models", account, generatedAt),
    );
  }
  for (const model of models) {
    effectiveAvailability.push(
      availability(model.id, [...account, model], generatedAt),
    );
  }
  return knownSemantics(
    effectiveAvailability,
    "Claude account windows bound every model. A model-specific window is an additional bound, so that model's effective remaining percentage is the minimum across the named windows.",
  );
}

function codexSemantics(
  windows: QuotaWindow[],
  generatedAt: string,
): QuotaSemantics {
  const account = windows.filter(isCodexAccountWindow);
  const codeReview = windows.filter(
    ({ id }) =>
      id.startsWith("code_review_five_hour") ||
      id.startsWith("code_review_weekly") ||
      id.startsWith("code_review_window:"),
  );
  const modelWindows = windows.filter(({ kind }) => kind === "model");
  const models = new Map<string, QuotaWindow[]>();
  for (const window of modelWindows) {
    const scope = codexModelScope(window.id);
    const scoped = models.get(scope) ?? [];
    scoped.push(window);
    models.set(scope, scoped);
  }
  const recognized = new Set([...account, ...codeReview, ...modelWindows]);
  const unresolved = windows.filter((window) => !recognized.has(window));
  if (unresolved.length > 0) {
    return partialSemantics(
      unresolved,
      "Codex base account windows bound every model and named model windows add model-specific bounds, but unfamiliar windows prevent a definitive effective percentage.",
    );
  }

  const effectiveAvailability: EffectiveAvailability[] = [];
  if (account.length > 0) {
    effectiveAvailability.push(
      availability("all_models", account, generatedAt),
    );
  }
  if (codeReview.length > 0) {
    effectiveAvailability.push(
      availability("code_review", codeReview, generatedAt),
    );
  }
  for (const [scope, modelWindows] of models) {
    effectiveAvailability.push(
      availability(scope, [...account, ...modelWindows], generatedAt),
    );
  }
  return knownSemantics(
    effectiveAvailability,
    "Codex base account windows bound every model. Named model windows add bounds for that model; code-review windows describe a separate workload and are not included in model availability.",
  );
}

function grokSemantics(
  windows: QuotaWindow[],
  generatedAt: string,
): QuotaSemantics {
  const shared = windows.filter(({ id }) => id === "credits");
  const products = windows.filter(({ id }) => id.startsWith("product:"));
  const unresolved = windows.filter(
    ({ id }) => id !== "credits" && !id.startsWith("product:"),
  );
  if (unresolved.length > 0) {
    return partialSemantics(
      unresolved,
      "Grok's shared credits window bounds every product and each product window adds a product-specific bound, but unfamiliar windows prevent a definitive effective percentage.",
    );
  }

  const effectiveAvailability: EffectiveAvailability[] = [];
  if (shared.length > 0) {
    effectiveAvailability.push(
      availability("all_products", shared, generatedAt),
    );
  }
  for (const product of products) {
    effectiveAvailability.push(
      availability(product.id, [...shared, product], generatedAt),
    );
  }
  return knownSemantics(
    effectiveAvailability,
    "Grok's shared credits window bounds every product. A product window is an additional bound, so that product's effective remaining percentage is the minimum across the named windows.",
  );
}

function kimiSemantics(
  windows: QuotaWindow[],
  untrustedWindowIds: string[],
  generatedAt: string,
): QuotaSemantics {
  const unresolved = windows.filter(
    ({ id }) => id !== "weekly" && id !== "five_hour",
  );
  const unresolvedWindowIds = [
    ...new Set([...unresolved.map(({ id }) => id), ...untrustedWindowIds]),
  ];
  if (unresolvedWindowIds.length > 0) {
    const recognized = windows.filter(
      ({ id }) => id === "weekly" || id === "five_hour",
    );
    return {
      status: "partial",
      description:
        "Kimi's valid weekly and five-hour account windows are known bounds, but unrecognized or unparsed limits may add bounds, so effective remaining is unknown.",
      effectiveAvailability:
        recognized.length > 0
          ? [
              unresolvedAvailability(
                "all_models",
                recognized,
                unresolvedWindowIds,
              ),
            ]
          : [],
      unresolvedWindowIds,
    };
  }
  const effectiveAvailability =
    windows.length > 0
      ? [availability("all_models", windows, generatedAt)]
      : [];
  return knownSemantics(
    effectiveAvailability,
    "Kimi's weekly and five-hour account windows jointly bound every model, so effective remaining is the minimum across the named windows.",
  );
}

/**
 * Cursor's recognized windows all draw on the same plan billing cycle, so
 * quota-axi treats them as jointly bounding rather than independent. That is
 * the conservative reading: the effective remaining is the minimum across them,
 * which never overstates headroom even if a window later turns out to be
 * independent.
 */
const CURSOR_RECOGNIZED_WINDOW_IDS = [
  "included_usage",
  "auto_usage",
  "api_usage",
  "spend_limit",
];

function cursorSemantics(
  windows: QuotaWindow[],
  generatedAt: string,
): QuotaSemantics {
  const recognized = windows.filter(({ id }) =>
    CURSOR_RECOGNIZED_WINDOW_IDS.includes(id),
  );
  const unresolved = windows.filter(
    ({ id }) => !CURSOR_RECOGNIZED_WINDOW_IDS.includes(id),
  );
  const effectiveAvailability =
    recognized.length > 0
      ? [availability("all_models", recognized, generatedAt)]
      : [];
  if (unresolved.length > 0) {
    return {
      status: "partial",
      description:
        "Cursor's included, auto, API usage, and spend-limit windows jointly bound every model, so effective remaining is the minimum across those named windows. Unfamiliar windows are not folded into that bound, so they stay unresolved.",
      effectiveAvailability,
      unresolvedWindowIds: unresolved.map(({ id }) => id),
    };
  }
  return knownSemantics(
    effectiveAvailability,
    "Cursor's included, auto, API usage, and spend-limit windows jointly bound every model, so effective remaining is the minimum across the named windows.",
  );
}

function zaiSemantics(
  windows: QuotaWindow[],
  untrustedWindowIds: string[],
  generatedAt: string,
): QuotaSemantics {
  const token = windows.filter(
    ({ id }) => id === "five_hour" || id === "weekly",
  );
  const tool = windows.filter(({ id }) => id === "mcp_month");
  const recognized = new Set([...token, ...tool]);
  const unresolved = windows.filter((window) => !recognized.has(window));
  const unresolvedWindowIds = [
    ...new Set([...unresolved.map(({ id }) => id), ...untrustedWindowIds]),
  ];
  if (unresolvedWindowIds.length > 0) {
    const effectiveAvailability: EffectiveAvailability[] = [];
    if (token.length > 0) {
      effectiveAvailability.push(
        unresolvedAvailability("all_models", token, unresolvedWindowIds),
      );
    }
    if (tool.length > 0) {
      effectiveAvailability.push(
        unresolvedAvailability("tools", tool, unresolvedWindowIds),
      );
    }
    return {
      status: "partial",
      description:
        "Z.AI's five-hour and weekly token windows jointly bound model usage and the monthly tool window is a separate resource, but unfamiliar windows prevent a definitive effective percentage.",
      effectiveAvailability,
      unresolvedWindowIds,
    };
  }

  const effectiveAvailability: EffectiveAvailability[] = [];
  if (token.length > 0) {
    effectiveAvailability.push(availability("all_models", token, generatedAt));
  }
  if (tool.length > 0) {
    effectiveAvailability.push(availability("tools", tool, generatedAt));
  }
  return knownSemantics(
    effectiveAvailability,
    "Z.AI's five-hour and weekly token windows jointly bound model usage, so effective remaining is the minimum across the named windows. The monthly tool window is an independent resource.",
  );
}

/**
 * Report a scope whose recognized windows are real bounds while unfamiliar
 * windows may add further bounds, so the effective percentage stays unknown and
 * every window that could bind the scope is named as unmeasurable.
 *
 * @param scope effective-availability scope name
 * @param windows recognized windows bounding this scope only
 * @param unresolvedWindowIds windows quota-axi could not place
 * @returns non-definitive availability entry for the scope
 */
function unresolvedAvailability(
  scope: string,
  windows: QuotaWindow[],
  unresolvedWindowIds: string[],
): EffectiveAvailability {
  const boundedBy = windows.map(({ id }) => id);
  const unmeasurableWindowIds = [...boundedBy, ...unresolvedWindowIds];
  return {
    scope,
    status: "unknown",
    boundedBy,
    pace: summarizeEffectivePace(windows),
    runway: {
      status: "unknown",
      unmeasurableWindowIds,
    },
    // Unrecognized limits may add bounds this scope cannot see, so the
    // selection scalar would be computed over an incomplete bound set.
    // Report it unmeasurable rather than optimistic.
    selection: {
      status: "unknown",
      unmeasurableWindowIds,
    },
  };
}

function availability(
  scope: string,
  windows: QuotaWindow[],
  generatedAt: string,
): EffectiveAvailability {
  const boundedBy = windows.map(({ id }) => id);
  const remaining = windows.map(({ percentRemaining }) => percentRemaining);
  const pace = summarizeEffectivePace(windows);
  const selection = summarizeEffectiveSelection(windows);
  if (
    remaining.length === 0 ||
    remaining.some((value) => value === undefined)
  ) {
    return {
      scope,
      status: "unknown",
      boundedBy,
      pace,
      runway: computeEffectiveRunway(windows, generatedAt),
      selection,
    };
  }
  const effectivePercentRemaining = Math.min(...(remaining as number[]));
  return {
    scope,
    status: "known",
    effectivePercentRemaining,
    boundedBy,
    limitingWindowIds: windows
      .filter(
        ({ percentRemaining }) =>
          percentRemaining === effectivePercentRemaining,
      )
      .map(({ id }) => id),
    pace,
    runway: computeEffectiveRunway(windows, generatedAt),
    selection,
  };
}

function isCodexAccountWindow(window: QuotaWindow): boolean {
  return (
    /^(?:five_hour|weekly)(?:_\d+)?$/.test(window.id) ||
    window.id.startsWith("window:")
  );
}

function codexModelScope(id: string): string {
  return id.replace(/_\d+$/, "").replace(/:(?:5h|7d|window:[^:]+)$/, "");
}

function knownSemantics(
  effectiveAvailability: EffectiveAvailability[],
  description: string,
): QuotaSemantics {
  return {
    status: effectiveAvailability.length > 0 ? "known" : "unknown",
    description:
      effectiveAvailability.length > 0
        ? description
        : "No quota windows are available, so no effective remaining percentage can be computed.",
    effectiveAvailability,
  };
}

function partialSemantics(
  unresolved: QuotaWindow[],
  description: string,
): QuotaSemantics {
  return {
    status: "partial",
    description,
    effectiveAvailability: [],
    unresolvedWindowIds: unresolved.map(({ id }) => id),
  };
}

function unknownSemantics(
  windows: QuotaWindow[],
  description: string,
): QuotaSemantics {
  return {
    status: "unknown",
    description:
      windows.length > 0
        ? description
        : "No quota windows are available, so no effective remaining percentage can be computed.",
    effectiveAvailability: [],
    unresolvedWindowIds: windows.map(({ id }) => id),
  };
}
