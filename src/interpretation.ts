import type {
  EffectiveAvailability,
  ProviderQuota,
  QuotaSemantics,
  QuotaWindow,
} from "./types.js";

export function withQuotaSemantics(provider: ProviderQuota): ProviderQuota {
  return { ...provider, quotaSemantics: semanticsFor(provider) };
}

function semanticsFor(provider: ProviderQuota): QuotaSemantics {
  switch (provider.provider) {
    case "claude":
      return claudeSemantics(provider.windows);
    case "codex":
      return codexSemantics(provider.windows);
    case "grok":
      return grokSemantics(provider.windows);
    case "kimi":
      return kimiSemantics(
        provider.windows,
        provider.state.untrustedWindowIds ?? [],
      );
    case "cursor":
    case "copilot":
      return unknownSemantics(
        provider.windows,
        `quota-axi does not know whether ${provider.label}'s reported windows are independent or jointly bounding, so it does not claim an effective remaining percentage.`,
      );
  }
}

function claudeSemantics(windows: QuotaWindow[]): QuotaSemantics {
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
    effectiveAvailability.push(availability("all_models", account));
  }
  for (const model of models) {
    effectiveAvailability.push(availability(model.id, [...account, model]));
  }
  return knownSemantics(
    effectiveAvailability,
    "Claude account windows bound every model. A model-specific window is an additional bound, so that model's effective remaining percentage is the minimum across the named windows.",
  );
}

function codexSemantics(windows: QuotaWindow[]): QuotaSemantics {
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
    effectiveAvailability.push(availability("all_models", account));
  }
  if (codeReview.length > 0) {
    effectiveAvailability.push(availability("code_review", codeReview));
  }
  for (const [scope, modelWindows] of models) {
    effectiveAvailability.push(
      availability(scope, [...account, ...modelWindows]),
    );
  }
  return knownSemantics(
    effectiveAvailability,
    "Codex base account windows bound every model. Named model windows add bounds for that model; code-review windows describe a separate workload and are not included in model availability.",
  );
}

function grokSemantics(windows: QuotaWindow[]): QuotaSemantics {
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
    effectiveAvailability.push(availability("all_products", shared));
  }
  for (const product of products) {
    effectiveAvailability.push(availability(product.id, [...shared, product]));
  }
  return knownSemantics(
    effectiveAvailability,
    "Grok's shared credits window bounds every product. A product window is an additional bound, so that product's effective remaining percentage is the minimum across the named windows.",
  );
}

function kimiSemantics(
  windows: QuotaWindow[],
  untrustedWindowIds: string[],
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
              {
                scope: "all_models",
                status: "unknown",
                boundedBy: recognized.map(({ id }) => id),
              },
            ]
          : [],
      unresolvedWindowIds,
    };
  }
  const effectiveAvailability =
    windows.length > 0 ? [availability("all_models", windows)] : [];
  return knownSemantics(
    effectiveAvailability,
    "Kimi's weekly and five-hour account windows jointly bound every model, so effective remaining is the minimum across the named windows.",
  );
}

function availability(
  scope: string,
  windows: QuotaWindow[],
): EffectiveAvailability {
  const boundedBy = windows.map(({ id }) => id);
  const remaining = windows.map(({ percentRemaining }) => percentRemaining);
  if (
    remaining.length === 0 ||
    remaining.some((value) => value === undefined)
  ) {
    return { scope, status: "unknown", boundedBy };
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
