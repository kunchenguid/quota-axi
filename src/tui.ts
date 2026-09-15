import type {
  EffectiveAvailability,
  ProviderId,
  ProviderQuota,
  QuotaAxiResponse,
  QuotaWindow,
} from "./types.js";

/**
 * Human terminal report ("Direction D'"): a two-up card grid with thin
 * headroom bars and a linear-pace marker wherever pace is known. This surface is
 * presentation only - it renders the same redacted response the TOON and JSON
 * surfaces receive and derives nothing new from providers or the cache.
 */

export type TuiColorDepth = "none" | "16" | "256" | "truecolor";

export type TuiOptions = {
  /** Raw terminal width; clamped to [80, 120], defaults to 100. */
  columns?: number;
  colorDepth?: TuiColorDepth;
  /** Mirrors `--full`: appends account identity and source-attempt footers. */
  full?: boolean;
  /** IANA time zone for header/absolute times; defaults to the system zone. */
  timeZone?: string;
};

const CARD_WIDTH = 49;
const CARD_INTERIOR = CARD_WIDTH - 2;
const CARD_GUTTER = 2;
const TWO_COLUMN_MIN = CARD_WIDTH * 2 + CARD_GUTTER;
const EFFECTIVE_BAR_WIDTH = 41;
/** 3 gutter + 8 label + bar + 1 + 4 percent + 2 + 6 reset + 1 = CARD_INTERIOR. */
const WINDOW_BAR_WIDTH = CARD_INTERIOR - 25;
const MIN_COLUMNS = 80;
const MAX_COLUMNS = 120;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

type StyleName =
  | "dim"
  | "dimmer"
  | "dimBold"
  | "label"
  | "ok"
  | "okBold"
  | "warn"
  | "warnBold"
  | "crit"
  | "critBold"
  | "marker"
  | "track"
  | "border"
  | "borderDim"
  | `accent:${ProviderId}`;

type Segment = { text: string; style?: StyleName };
type Line = Segment[];

type StyleSpec = {
  rgb: [number, number, number];
  ansi16: string;
  bold?: boolean;
};

const ACCENTS: Record<ProviderId, StyleSpec> = {
  claude: { rgb: [250, 179, 135], ansi16: "93", bold: true },
  codex: { rgb: [148, 226, 213], ansi16: "96", bold: true },
  cursor: { rgb: [137, 180, 250], ansi16: "94", bold: true },
  copilot: { rgb: [116, 199, 236], ansi16: "94", bold: true },
  grok: { rgb: [180, 190, 254], ansi16: "95", bold: true },
  kimi: { rgb: [245, 194, 231], ansi16: "95", bold: true },
  zai: { rgb: [129, 216, 209], ansi16: "96", bold: true },
  agy: { rgb: [232, 184, 109], ansi16: "93", bold: true },
  alibaba: { rgb: [255, 155, 120], ansi16: "91", bold: true },
  "opencode-go": { rgb: [160, 210, 255], ansi16: "96", bold: true },
  minimax: { rgb: [255, 196, 112], ansi16: "93", bold: true },
  mimo: { rgb: [174, 214, 241], ansi16: "96", bold: true },
  deepseek: { rgb: [88, 160, 242], ansi16: "94", bold: true },
  openrouter: { rgb: [183, 148, 232], ansi16: "95", bold: true },
};

const STYLES: Record<Exclude<StyleName, `accent:${ProviderId}`>, StyleSpec> = {
  dim: { rgb: [127, 132, 156], ansi16: "90" },
  dimmer: { rgb: [88, 91, 112], ansi16: "90" },
  dimBold: { rgb: [127, 132, 156], ansi16: "90", bold: true },
  label: { rgb: [166, 173, 200], ansi16: "37" },
  ok: { rgb: [166, 227, 161], ansi16: "32" },
  okBold: { rgb: [166, 227, 161], ansi16: "32", bold: true },
  warn: { rgb: [249, 226, 175], ansi16: "33" },
  warnBold: { rgb: [249, 226, 175], ansi16: "33", bold: true },
  crit: { rgb: [243, 139, 168], ansi16: "31" },
  critBold: { rgb: [243, 139, 168], ansi16: "31", bold: true },
  marker: { rgb: [137, 220, 235], ansi16: "96" },
  track: { rgb: [69, 71, 90], ansi16: "90" },
  border: { rgb: [88, 91, 112], ansi16: "90" },
  borderDim: { rgb: [49, 50, 68], ansi16: "90" },
};

/**
 * Resolve the color depth for the TUI report from the environment. Honors
 * NO_COLOR, TERM=dumb, and non-TTY stdout (color off, glyph skeleton kept);
 * FORCE_COLOR re-enables. Truecolor requires COLORTERM=truecolor|24bit.
 */
export function detectTuiColorDepth(
  env: Record<string, string | undefined>,
  isTty: boolean,
): TuiColorDepth {
  const force = env.FORCE_COLOR;
  const forced = force !== undefined && force !== "0";
  if (!forced) {
    if (env.NO_COLOR !== undefined) return "none";
    if (env.TERM === "dumb") return "none";
    if (!isTty) return "none";
  }
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "") || force === "3") {
    return "truecolor";
  }
  if ((env.TERM ?? "").includes("256color") || force === "2") return "256";
  return "16";
}

export function renderQuotaTui(
  response: QuotaAxiResponse,
  options: TuiOptions = {},
): string {
  const columns = resolveColumns(options.columns);
  const twoColumn = columns >= TWO_COLUMN_MIN;
  const generatedAtMs = Date.parse(response.generatedAt);
  const timeZone = options.timeZone;

  const ordered = [
    ...response.providers.filter(isLive),
    ...response.providers.filter((provider) => !isLive(provider)),
  ];
  const cards = ordered.map((provider) => buildCard(provider, generatedAtMs));

  const lines: Line[] = [];
  lines.push([{ text: `  ${headerText(response, timeZone)}`, style: "dim" }]);
  lines.push([]);
  lines.push(...layoutCards(cards, twoColumn));
  if (options.full) {
    lines.push([]);
    for (const provider of ordered) {
      for (const footerLine of fullFooterLines(provider, columns - 2)) {
        lines.push([{ text: `  ${footerLine}`, style: "dim" }]);
      }
    }
  }
  return lines
    .map((line) => renderLine(trimRight(line), options.colorDepth ?? "none"))
    .join("\n");
}

/**
 * The report's dim closing line, rendered on its own so the live viewport can
 * pin it to the last row instead of letting it scroll away with the cards.
 */
export function renderTuiHintLine(
  text: string,
  options: TuiOptions = {},
): string {
  const columns = resolveColumns(options.columns);
  const line: Line = [
    { text: `  ${truncate(text, columns - 2)}`, style: "dim" },
  ];
  return renderLine(trimRight(line), options.colorDepth ?? "none");
}

function resolveColumns(columns: number | undefined): number {
  return Math.min(
    MAX_COLUMNS,
    Math.max(MIN_COLUMNS, columns ?? TWO_COLUMN_MIN),
  );
}

function isLive(provider: ProviderQuota): boolean {
  return provider.state.status === "fresh" || provider.state.status === "stale";
}

function headerText(response: QuotaAxiResponse, timeZone?: string): string {
  const live = response.providers.filter(isLive).length;
  const signedOut = response.providers.filter(
    (provider) => provider.state.status === "auth_required",
  ).length;
  const failed = response.providers.length - live - signedOut;
  const parts = [
    "quota-axi",
    formatHeaderTime(response.generatedAt, timeZone),
    `${live} live`,
    `${signedOut} signed out`,
  ];
  if (failed > 0) parts.push(`${failed} unavailable`);
  return parts.filter(Boolean).join(" · ");
}

type Card = Line[];

function buildCard(provider: ProviderQuota, generatedAtMs: number): Card {
  return isLive(provider)
    ? buildLiveCard(provider, generatedAtMs)
    : buildFailedCard(provider);
}

function buildLiveCard(provider: ProviderQuota, generatedAtMs: number): Card {
  const stale = provider.state.stale;
  const rightTitle = [
    provider.plan,
    provider.source,
    stale ? "stale" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const lines: Line[] = [
    titleLine(
      {
        text: ` ● ${provider.provider} `,
        style: `accent:${provider.provider}`,
      },
      rightTitle,
      "border",
    ),
    interior([], "border"),
  ];

  const headline = pickHeadlineAvailability(provider);
  if (hasWhollyUnknownWindowRelationships(provider)) {
    lines.push(...windowsOnlyHeadline(stale));
  } else {
    lines.push(...effectiveHeadline(provider, headline, stale));
  }

  if (provider.windows.length > 0) {
    lines.push(interior([], "border"));
    for (const window of provider.windows) {
      lines.push(interior(windowRow(window, generatedAtMs), "border"));
    }
  }

  for (const note of cardNotes(provider)) {
    lines.push(
      interior(
        [{ text: `   ${truncate(note, CARD_INTERIOR - 4)}`, style: "dimmer" }],
        "border",
      ),
    );
  }

  lines.push(interior([], "border"));
  lines.push(bottomLine("border"));
  return lines;
}

/**
 * The standard effective-headroom block: the binding window's percentage, its
 * runway verdict, and the effective bar. It also preserves the existing
 * unknown fallback for zero-window and partially understood providers.
 */
function effectiveHeadline(
  provider: ProviderQuota,
  headline: EffectiveAvailability | undefined,
  stale: boolean | undefined,
): Line[] {
  const lines: Line[] = [];
  const effectivePct = headline?.effectivePercentRemaining;
  const markerPct = effectiveMarkerPercent(provider, headline);

  const verdict = runwayVerdict(headline);
  const percentText =
    effectivePct === undefined ? undefined : `${Math.round(effectivePct)}%`;
  const headlineLabelWidth = Math.max(
    0,
    EFFECTIVE_BAR_WIDTH -
      lineWidth(verdict) -
      1 -
      displayWidth(percentText ?? "") -
      1,
  );
  const left: Line =
    effectivePct !== undefined && percentText !== undefined
      ? [
          {
            text: percentText,
            style: boldHealthStyle(effectivePct),
          },
          {
            text: ` ${headlineLabel(provider, headline, headlineLabelWidth)}`,
            style: "dim",
          },
        ]
      : [
          {
            text: stale ? "stale · effective unknown" : "effective unknown",
            style: "dim",
          },
        ];
  lines.push(
    interior(
      [
        { text: "   " },
        ...padBetween(left, verdict, EFFECTIVE_BAR_WIDTH),
        { text: "   " },
      ],
      "border",
    ),
  );
  lines.push(
    interior(
      [
        { text: "   " },
        ...thinBar(effectivePct, markerPct, EFFECTIVE_BAR_WIDTH),
        { text: "   " },
      ],
      "border",
    ),
  );
  return lines;
}

/**
 * The headline block for a provider that reports real per-window usage but no
 * combinable bound: quota-axi does not know whether those windows are
 * independent or jointly bounding, so there is no combined
 * effective percentage, pace, or runway to show. Rendering the empty effective
 * bar there reads as a failure, so the block is replaced by a single line naming
 * what the card actually is - the per-window rows below carry the real data.
 */
function hasWhollyUnknownWindowRelationships(provider: ProviderQuota): boolean {
  const semantics = provider.quotaSemantics;
  if (
    provider.windows.length === 0 ||
    semantics?.status !== "unknown" ||
    semantics.unresolvedWindowIds === undefined
  ) {
    return false;
  }
  const unresolved = new Set(semantics.unresolvedWindowIds);
  return provider.windows.every(({ id }) => unresolved.has(id));
}

function windowsOnlyHeadline(stale: boolean | undefined): Line[] {
  const left: Line = [
    {
      text: stale ? "stale · per-window usage" : "per-window usage",
      style: "dim",
    },
  ];
  const right: Line = [{ text: "no combined bound", style: "dim" }];
  // Without the effective bar under it, this line's right edge belongs with the
  // window rows' reset column rather than the (absent) bar's end.
  return [
    interior(
      [
        { text: "   " },
        ...padBetween(left, right, CARD_INTERIOR - 4),
        { text: " " },
      ],
      "border",
    ),
  ];
}

function buildFailedCard(provider: ProviderQuota): Card {
  const status = provider.state.status;
  const rightTitle =
    status === "auth_required" ? "signed out" : humanize(status);
  const lines: Line[] = [
    titleLine(
      { text: ` ○ ${provider.provider} `, style: "dimBold" },
      rightTitle,
      "borderDim",
    ),
    interior([], "borderDim"),
  ];
  const message =
    humanize(provider.state.error ?? "") ||
    (status === "auth_required" ? "sign-in required" : humanize(status));
  const body: { text: string; style: StyleName }[] = [
    { text: message, style: "dim" },
  ];
  if (provider.state.retryAfter) {
    body.push({
      text: `retry after ${provider.state.retryAfter}`,
      style: "dim",
    });
  }
  if (provider.state.remedyCommand) {
    body.push({ text: `run: ${provider.state.remedyCommand}`, style: "dim" });
  }
  body.push({ text: "excluded from fleet totals", style: "dimmer" });
  for (const entry of body) {
    lines.push(
      interior(
        [
          {
            text: `   ${truncate(entry.text, CARD_INTERIOR - 4)}`,
            style: entry.style,
          },
        ],
        "borderDim",
      ),
    );
  }
  lines.push(interior([], "borderDim"));
  lines.push(bottomLine("borderDim"));
  return lines;
}

function titleLine(
  name: Segment,
  rightText: string,
  borderStyle: StyleName,
): Line {
  let right = rightText === "" ? "" : ` ${rightText} `;
  let dashes = CARD_WIDTH - 4 - displayWidth(name.text) - displayWidth(right);
  if (dashes < 1) {
    right = ` ${truncate(
      rightText,
      Math.max(0, CARD_WIDTH - 7 - displayWidth(name.text)),
    )} `;
    dashes = Math.max(
      1,
      CARD_WIDTH - 4 - displayWidth(name.text) - displayWidth(right),
    );
  }
  return [
    { text: "╭─", style: borderStyle },
    name,
    { text: "─".repeat(dashes), style: borderStyle },
    { text: right, style: "dim" },
    { text: "─╮", style: borderStyle },
  ];
}

function bottomLine(borderStyle: StyleName): Line {
  return [{ text: `╰${"─".repeat(CARD_INTERIOR)}╯`, style: borderStyle }];
}

function interior(content: Line, borderStyle: StyleName): Line {
  const used = lineWidth(content);
  const pad = Math.max(0, CARD_INTERIOR - used);
  return [
    { text: "│", style: borderStyle },
    ...content,
    { text: " ".repeat(pad) },
    { text: "│", style: borderStyle },
  ];
}

function windowRow(window: QuotaWindow, generatedAtMs: number): Line {
  const pct = window.percentRemaining;
  const marker = window.pace?.timeRemainingPercent;
  const reset = resetCountdown(window, generatedAtMs);
  return [
    { text: "   " },
    { text: padEndDisplay(shortWindowLabel(window), 8), style: "label" },
    ...thinBar(pct, marker, WINDOW_BAR_WIDTH),
    { text: " " },
    {
      text: (pct === undefined ? "?" : `${Math.round(pct)}%`).padStart(4),
      style: pct === undefined ? "dim" : healthStyle(pct),
    },
    { text: "  " },
    { text: padEndDisplay(reset, 6), style: "dim" },
    { text: " " },
  ];
}

/**
 * Quiet-Ledger thin bar with the linear-pace marker: fill is current
 * headroom at half-cell resolution, `┃` overwrites the cell at
 * `timeRemainingPercent` (the fill position of exactly linear burn), and the
 * marker is omitted when pace is unknown rather than faked.
 */
export function thinBar(
  percentRemaining: number | undefined,
  markerPercent: number | undefined,
  width: number,
): Line {
  const fillStyle: StyleName =
    percentRemaining === undefined ? "track" : healthStyle(percentRemaining);
  let halfUnits = 0;
  if (percentRemaining !== undefined) {
    const pct = Math.min(100, Math.max(0, percentRemaining));
    halfUnits = Math.round((pct / 100) * width * 2);
    if (pct > 0 && halfUnits === 0) halfUnits = 1;
    if (pct < 100 && halfUnits === width * 2) halfUnits = width * 2 - 1;
  }
  const cells: Segment[] = [];
  for (let index = 0; index < width; index++) {
    const cellHalves = Math.min(2, Math.max(0, halfUnits - index * 2));
    if (cellHalves === 2) cells.push({ text: "━", style: fillStyle });
    else if (cellHalves === 1) cells.push({ text: "╸", style: fillStyle });
    else cells.push({ text: "─", style: "track" });
  }
  if (markerPercent !== undefined && Number.isFinite(markerPercent)) {
    const cell = Math.min(
      width - 1,
      Math.max(0, Math.round((markerPercent / 100) * width)),
    );
    cells[cell] = { text: "┃", style: "marker" };
  }
  return coalesce(cells);
}

function pickHeadlineAvailability(
  provider: ProviderQuota,
): EffectiveAvailability | undefined {
  const availability = provider.quotaSemantics?.effectiveAvailability ?? [];
  return (
    availability.find(
      (entry) => entry.scope.startsWith("all_") && entry.status === "known",
    ) ??
    availability.find((entry) => entry.status === "known") ??
    availability[0]
  );
}

function effectiveMarkerPercent(
  provider: ProviderQuota,
  headline: EffectiveAvailability | undefined,
): number | undefined {
  if (!headline) return undefined;
  // The headline bar represents effective headroom, so its reset marker must
  // follow that headroom's binding window. A finite runway can be constrained
  // by another window and is rendered as the separate "empty in" verdict.
  const limitingId = headline.limitingWindowIds?.[0];
  if (limitingId === undefined) return undefined;
  const limiting = provider.windows.find((window) => window.id === limitingId);
  return limiting?.pace?.timeRemainingPercent;
}

function runwayVerdict(headline: EffectiveAvailability | undefined): Line {
  const runway = headline?.runway;
  if (!runway || runway.status === "unknown") {
    return [{ text: "runway unknown", style: "dim" }];
  }
  if (runway.status === "through_reset") {
    // The JSON/TOON contract keeps `through_reset`; only this label is humanized.
    return [
      { text: "on pace ", style: "dim" },
      { text: "✓", style: "okBold" },
    ];
  }
  if (runway.status === "exhausted_now") {
    return [{ text: "✗ exhausted now", style: "critBold" }];
  }
  const seconds = runway.usableRunwaySeconds;
  const text =
    seconds === undefined
      ? "exhaustion projected"
      : `empty in ${formatCountdown(seconds)}`;
  return [{ text, style: "warnBold" }];
}

function cardNotes(provider: ProviderQuota): string[] {
  const notes: string[] = [];
  if (provider.state.retryAfter) {
    notes.push(`retry after ${provider.state.retryAfter}`);
  }
  if (provider.state.remedyCommand) {
    notes.push(`run: ${provider.state.remedyCommand}`);
  }
  return notes;
}

function scopeLabel(scope: string | undefined): string {
  if (scope === undefined) return "unknown scope";
  return humanize(scope.replace(/^all_/, "all "));
}

/** Budget for the headline window name, leaving room for the runway verdict. */
const HEADLINE_LABEL_WIDTH = 20;

/**
 * Name the window the headline percent actually is. Effective remaining is the
 * minimum across the bounded windows, so it always equals one named window's
 * `percentRemaining` - `limitingWindowIds` is exactly that window (or the tied
 * set), and its provider label ("week", "session", "credits") is what the
 * headline bar is showing. Falls back to the model-scope wording when any
 * limiting window is unresolvable; a model-scoped headline keeps the scope as
 * a suffix so "week · fable" stays unambiguous.
 */
export function headlineLabel(
  provider: ProviderQuota,
  headline: EffectiveAvailability | undefined,
  width = HEADLINE_LABEL_WIDTH,
): string {
  const ids = headline?.limitingWindowIds ?? [];
  const names = ids
    .map((id) => provider.windows.find((window) => window.id === id)?.label)
    .map((label) =>
      label === undefined
        ? undefined
        : sanitizeTerminalText(label).toLowerCase(),
    )
    .filter((label): label is string => label !== undefined && label !== "");
  const scope = headline?.scope;
  if (names.length === 0 || names.length !== ids.length) {
    return truncate(scopeLabel(scope), width);
  }
  const suffix =
    scope !== undefined && !scope.startsWith("all_")
      ? ` · ${humanize(scope.replace(/^(?:model|product):/, "")).toLowerCase()}`
      : "";
  const joined = names.join(" + ");
  let windowLabel = joined;
  if (displayWidth(joined) > width) {
    const tie = names.length > 1 ? ` +${names.length - 1}` : "";
    windowLabel = `${compactHeadlineWindowName(
      names[0],
      width - displayWidth(tie),
    )}${tie}`;
  }
  return displayWidth(`${windowLabel}${suffix}`) <= width
    ? `${windowLabel}${suffix}`
    : windowLabel;
}

function compactHeadlineWindowName(label: string, width: number): string {
  const safeLabel = sanitizeTerminalText(label);
  if (displayWidth(safeLabel) <= width) return safeLabel;
  const parts = safeLabel.match(/^(.*\S)\s+(\S+)$/u);
  if (parts === null) return truncate(safeLabel, width);
  const period = parts[2];
  const separatorWidth = 1;
  const prefixWidth = width - displayWidth(period) - separatorWidth;
  if (prefixWidth <= 0) return truncate(period, width);
  return `${truncate(parts[1], prefixWidth)} ${period}`;
}

/**
 * Compress a window label into the 7-char row column: drop a trailing
 * period/unit token ("Fable week" -> "fable", "730h window" -> "730h"),
 * then fall back to the last hyphen segment and an ellipsis.
 */
export function shortWindowLabel(window: QuotaWindow): string {
  const tokens = window.label.split(/[\s_]+/).filter(Boolean);
  if (
    tokens.length > 1 &&
    /^(week|window|day|month|session|usage|quota)$/i.test(
      tokens[tokens.length - 1],
    )
  ) {
    tokens.pop();
  }
  let label = tokens.join(" ").toLowerCase();
  if (displayWidth(label) > 7 && label.includes("-")) {
    label = label.slice(label.lastIndexOf("-") + 1);
  }
  if (displayWidth(label) > 7) label = truncate(label, 7);
  return label || truncate(window.id, 7);
}

function resetCountdown(window: QuotaWindow, generatedAtMs: number): string {
  if (window.resetsAt !== undefined) {
    const resetMs = Date.parse(window.resetsAt);
    if (Number.isFinite(resetMs) && Number.isFinite(generatedAtMs)) {
      return formatCountdown((resetMs - generatedAtMs) / 1000);
    }
  }
  return window.resetText === undefined ? "" : truncate(window.resetText, 6);
}

/** Two-unit countdown ("4h 39m", "4d 21h") degrading to one unit at 7+ chars. */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    const both = `${days}d ${hours}h`;
    return both.length > 6 ? truncate(`${days}d`, 6) : both;
  }
  if (hours > 0) {
    const both = `${hours}h ${minutes}m`;
    return both.length > 6 ? `${hours}h` : both;
  }
  return minutes > 0 ? `${minutes}m` : "<1m";
}

function formatHeaderTime(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")} ${get("timeZoneName")}`.trim();
}

function fullFooterLines(provider: ProviderQuota, width: number): string[] {
  const accountParts: string[] = [provider.provider];
  const protectedAccountParts = new Set([0]);
  if (provider.account?.email) accountParts.push(provider.account.email);
  if (provider.account?.organization) {
    accountParts.push(provider.account.organization);
  }
  if (provider.account?.accountId) {
    accountParts.push(`id ${provider.account.accountId}`);
  }
  if (provider.account?.identityStatus) {
    protectedAccountParts.add(accountParts.length);
    accountParts.push(`identity ${provider.account.identityStatus}`);
  }
  const attempts = (provider.attempts ?? []).map(
    (attempt) =>
      `${attempt.source} (${attempt.status}${attempt.error ? `: ${attempt.error}` : ""})`,
  );
  const tried =
    attempts.length > 0 ? attempts : (provider.state.sourcesTried ?? []);
  const completeParts = [...accountParts];
  if (tried.length > 0) completeParts.push(`tried ${tried.join(" → ")}`);
  const complete = completeParts.join(" · ");
  if (displayWidth(complete) <= width) return [complete];

  const lines = [fitFooterParts(accountParts, width, protectedAccountParts)];
  if (provider.attempts && provider.attempts.length > 0) {
    lines.push(
      ...provider.attempts.map((attempt) => formatAttemptLine(attempt, width)),
    );
  } else {
    lines.push(
      ...(provider.state.sourcesTried ?? []).map((source) =>
        truncate(`  tried ${source}`, width),
      ),
    );
  }
  return lines;
}

function formatAttemptLine(
  attempt: NonNullable<ProviderQuota["attempts"]>[number],
  width: number,
): string {
  const prefix = "  tried ";
  const statusPrefix = ` (${attempt.status}${attempt.error ? ": " : ""}`;
  const suffix = ")";
  const complete = `${prefix}${attempt.source}${statusPrefix}${attempt.error ?? ""}${suffix}`;
  if (displayWidth(complete) <= width) return complete;

  const fixedWidth =
    displayWidth(prefix) + displayWidth(statusPrefix) + displayWidth(suffix);
  const available = Math.max(2, width - fixedWidth);
  const minimumSourceWidth = Math.min(8, displayWidth(attempt.source));
  const errorWidth = attempt.error
    ? Math.min(
        displayWidth(attempt.error),
        Math.max(1, available - minimumSourceWidth),
      )
    : 0;
  const sourceWidth = Math.max(1, available - errorWidth);
  return `${prefix}${truncate(attempt.source, sourceWidth)}${statusPrefix}${
    attempt.error ? truncate(attempt.error, errorWidth) : ""
  }${suffix}`;
}

function fitFooterParts(
  parts: string[],
  width: number,
  protectedParts = new Set([0]),
): string {
  const separator = " · ";
  const complete = parts.join(separator);
  if (displayWidth(complete) <= width) return complete;

  const available = Math.max(
    0,
    width - displayWidth(separator) * (parts.length - 1),
  );
  const widths = new Array<number>(parts.length).fill(0);
  let remaining = available;
  for (const index of protectedParts) {
    widths[index] = Math.min(displayWidth(parts[index]), remaining);
    remaining -= widths[index];
  }
  let pending = parts
    .map((_, index) => index)
    .filter((index) => !protectedParts.has(index));

  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const fitting = pending.filter(
      (index) => displayWidth(parts[index]) <= share,
    );
    if (fitting.length === 0) {
      for (const [position, index] of pending.entries()) {
        widths[index] = share + (position < remaining % pending.length ? 1 : 0);
      }
      break;
    }
    for (const index of fitting) {
      widths[index] = displayWidth(parts[index]);
      remaining -= widths[index];
    }
    pending = pending.filter((index) => !fitting.includes(index));
  }

  return parts
    .map((part, index) => truncate(part, widths[index]))
    .join(separator);
}

function layoutCards(cards: Card[], twoColumn: boolean): Line[] {
  const lines: Line[] = [];
  if (!twoColumn) {
    cards.forEach((card, index) => {
      if (index > 0) lines.push([]);
      lines.push(...card);
    });
    return lines;
  }
  for (let index = 0; index < cards.length; index += 2) {
    if (index > 0) lines.push([]);
    const left = cards[index];
    const right = cards[index + 1];
    if (!right) {
      lines.push(...left);
      continue;
    }
    const height = Math.max(left.length, right.length);
    const paddedLeft = padCardToHeight(left, height);
    const paddedRight = padCardToHeight(right, height);
    for (let row = 0; row < height; row++) {
      lines.push([
        ...paddedLeft[row],
        { text: " ".repeat(CARD_GUTTER) },
        ...paddedRight[row],
      ]);
    }
  }
  return lines;
}

function padCardToHeight(card: Card, height: number): Card {
  const missing = height - card.length;
  if (missing <= 0) return card;
  const bottom = card.at(-1);
  const interiorLine = card[1];
  if (!bottom || !interiorLine) return card;
  return [
    ...card.slice(0, -1),
    ...Array.from({ length: missing }, () => [...interiorLine]),
    bottom,
  ];
}

function healthStyle(pct: number): "ok" | "warn" | "crit" {
  if (pct >= 50) return "ok";
  if (pct >= 20) return "warn";
  return "crit";
}

function boldHealthStyle(pct: number): "okBold" | "warnBold" | "critBold" {
  return `${healthStyle(pct)}Bold`;
}

function humanize(text: string): string {
  return text.replace(/_/g, " ");
}

function truncate(text: string, width: number): string {
  const safeText = sanitizeTerminalText(text);
  if (width <= 0) return "";
  if (displayWidth(safeText) <= width) return safeText;
  if (width === 1) return "…";

  const limit = width - 1;
  let used = 0;
  let result = "";
  for (const unit of terminalTextUnits(safeText)) {
    const unitWidth = terminalUnitWidth(unit);
    if (unitWidth > 0 && used + unitWidth > limit) break;
    result += unit;
    used += unitWidth;
  }
  return `${result}…`;
}

function padEndDisplay(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

function padBetween(left: Line, right: Line, width: number): Line {
  const boundedRight = truncateLine(right, Math.max(0, width - 1));
  const leftWidth = Math.max(0, width - lineWidth(boundedRight) - 1);
  const boundedLeft = truncateLine(left, leftWidth);
  const pad = Math.max(
    1,
    width - lineWidth(boundedLeft) - lineWidth(boundedRight),
  );
  return [...boundedLeft, { text: " ".repeat(pad) }, ...boundedRight];
}

function truncateLine(line: Line, width: number): Line {
  if (width <= 0) return [];
  if (lineWidth(line) <= width) return line;

  const result: Line = [];
  let remaining = width;
  for (const segment of line) {
    const segmentWidth = displayWidth(segment.text);
    if (segmentWidth <= remaining) {
      result.push(segment);
      remaining -= segmentWidth;
      continue;
    }
    if (remaining > 0) {
      result.push({ ...segment, text: truncate(segment.text, remaining) });
    }
    break;
  }
  return result;
}

function lineWidth(line: Line): number {
  return line.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
}

function displayWidth(text: string): number {
  let width = 0;
  for (const unit of terminalTextUnits(sanitizeTerminalText(text))) {
    width += terminalUnitWidth(unit);
  }
  return width;
}

export function terminalTextUnits(text: string): string[] {
  return [...GRAPHEME_SEGMENTER.segment(text)].map((part) => part.segment);
}

export function sanitizeTerminalText(text: string): string {
  let result = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09) {
      result += " ";
    } else if (codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f)) {
      result += character;
    }
  }
  return result;
}

export function terminalUnitWidth(unit: string): number {
  if (
    /\p{Emoji_Presentation}/u.test(unit) ||
    (/\p{Emoji}/u.test(unit) &&
      (unit.includes("\ufe0f") || unit.includes("\u200d")))
  ) {
    return 2;
  }

  let width = 0;
  for (const character of unit) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      /\p{Mark}/u.test(character)
    ) {
      continue;
    }
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f6ff) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function coalesce(segments: Segment[]): Line {
  const out: Segment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.style === segment.style) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

function trimRight(line: Line): Line {
  const out = line.map((segment) => ({
    ...segment,
    text: sanitizeTerminalText(segment.text),
  }));
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.style === undefined) last.text = last.text.replace(/ +$/, "");
    if (last.text === "") out.pop();
    else break;
  }
  return out;
}

function renderLine(line: Line, depth: TuiColorDepth): string {
  if (depth === "none") {
    return line.map((segment) => segment.text).join("");
  }
  return line
    .map((segment) => {
      if (segment.style === undefined) return segment.text;
      const sgr = styleSgr(segment.style, depth);
      return sgr === "" ? segment.text : `\x1b[${sgr}m${segment.text}\x1b[0m`;
    })
    .join("");
}

function styleSgr(style: StyleName, depth: TuiColorDepth): string {
  const spec = style.startsWith("accent:")
    ? ACCENTS[style.slice("accent:".length) as ProviderId]
    : STYLES[style as Exclude<StyleName, `accent:${ProviderId}`>];
  const codes: string[] = [];
  if (spec.bold) codes.push("1");
  if (depth === "truecolor") {
    codes.push(`38;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}`);
  } else if (depth === "256") {
    codes.push(`38;5;${rgbToAnsi256(spec.rgb)}`);
  } else {
    codes.push(spec.ansi16);
  }
  return codes.join(";");
}

function rgbToAnsi256([r, g, b]: [number, number, number]): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const level = (value: number): number =>
    value < 48
      ? 0
      : value < 115
        ? 1
        : Math.min(5, Math.round((value - 35) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}
