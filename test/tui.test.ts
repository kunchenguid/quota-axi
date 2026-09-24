import { describe, expect, it } from "vitest";
import {
  detectTuiColorDepth,
  formatCountdown,
  renderQuotaTui,
  renderTuiHintLine,
  shortWindowLabel,
  thinBar,
} from "../src/tui.js";
import { withQuotaSemantics } from "../src/interpretation.js";
import { providerPresence } from "../src/lib/source-attempts.js";
import { redactedResponse } from "../src/render.js";
import { PROVIDER_IDS } from "../src/types.js";
import type { ProviderQuota, QuotaAxiResponse } from "../src/types.js";
import {
  claudeProvider,
  codexProvider,
  fixtureResponse,
  GENERATED_AT,
  signedOutProvider,
} from "./fixtures/tui-response.js";

const CARD_COLUMNS = 49;

function render(options = {}): string[] {
  return renderQuotaTui(fixtureResponse(), {
    timeZone: "America/Los_Angeles",
    ...options,
  }).split("\n");
}

function findLine(lines: string[], needle: string): string {
  const line = lines.find((candidate) => candidate.includes(needle));
  expect(
    line,
    `expected a line containing ${JSON.stringify(needle)}`,
  ).toBeDefined();
  return line as string;
}

/** Search within one card column of the two-up grid, not the zipped row. */
function findCardLine(lines: string[], card: 0 | 1, needle: string): string {
  const column = (line: string): string =>
    card === 0 ? line.slice(0, CARD_COLUMNS) : line.slice(CARD_COLUMNS + 2);
  const line = lines
    .map(column)
    .find((candidate) => candidate.includes(needle));
  expect(
    line,
    `expected card ${card} to contain ${JSON.stringify(needle)}`,
  ).toBeDefined();
  return line as string;
}

function barText(segments: { text: string }[]): string {
  return segments.map((segment) => segment.text).join("");
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function displayColumns(text: string): number {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  return [...segmenter.segment(text)].reduce((width, part) => {
    if (
      /\p{Emoji_Presentation}/u.test(part.segment) ||
      (/\p{Emoji}/u.test(part.segment) && part.segment.includes("\ufe0f"))
    ) {
      return width + 2;
    }
    return (
      width +
      [...part.segment].reduce((unitWidth, character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return unitWidth + (codePoint >= 0x2e80 && codePoint <= 0x9fff ? 2 : 1);
      }, 0)
    );
  }, 0);
}

describe("renderQuotaTui structure", () => {
  it("summarizes the fleet in the dim header with local time", () => {
    const lines = render();
    expect(lines[0]).toBe(
      "  quota-axi · 2026-08-06 16:21 PDT · 3 live · 3 need attention · 0 not set up",
    );
  });

  it("zips live provider cards two-up with live providers first", () => {
    const lines = render();
    const title = findLine(lines, "● claude");
    expect(title).toMatch(
      /^╭─ ● claude ─+ max · oauth ─╮ {2}╭─ ● codex ─+ pro · oauth ─╮$/,
    );
    expect(title).toHaveLength(100);
    const grokTitle = findLine(lines, "● grok");
    expect(grokTitle).toMatch(
      /^╭─ ● grok ─+ web ─╮ {2}╭─ ○ cursor ─+ signed out ─╮$/,
    );
  });

  it("keeps every line within the effective width and aligns card borders", () => {
    const lines = render();
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    const row = findLine(lines, "session");
    expect(row[0]).toBe("│");
    expect(row[48]).toBe("│");
    expect(row[51]).toBe("│");
    expect(row[99]).toBe("│");
  });

  it("promotes effective headroom with the runway verdict on the headline", () => {
    const lines = render();
    expect(findLine(lines, "72% week")).toContain("on pace ✓");
    expect(findLine(lines, "5% week")).toContain("empty in 7h 21m");
    expect(findLine(lines, "45% credits")).toContain("empty in 2d 13h");
    expect(lines.join("\n")).not.toContain("▲ empty in");
  });

  it("names the binding window on the headline instead of the model scope", () => {
    const lines = render();
    // The headline percent is the minimum across bounded windows, so it always
    // equals one named window: claude/codex are bound by their week window and
    // grok by credits, and the label has to follow that per provider.
    expect(findCardLine(lines, 0, "72% week")).toBeDefined();
    expect(findCardLine(lines, 1, "5% week")).toBeDefined();
    expect(lines.join("\n")).not.toContain("all models");
    expect(lines.join("\n")).not.toContain("all products");
  });

  it("names a session-bound headline after the session window", () => {
    const response = fixtureResponse();
    const claude = response.providers[0];
    const availability = claude.quotaSemantics?.effectiveAvailability[0];
    expect(availability).toBeDefined();
    if (!availability) return;
    availability.effectivePercentRemaining = 97;
    availability.limitingWindowIds = ["five_hour"];

    const lines = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    }).split("\n");
    expect(findCardLine(lines, 0, "97% session")).toBeDefined();
  });

  it("uses the mapped headline window's reset marker instead of another window's runway", () => {
    for (const [mappedId, otherId] of [
      ["five_hour", "seven_day"],
      ["seven_day", "five_hour"],
    ]) {
      const response = fixtureResponse();
      const claude = response.providers[0];
      const mapped = claude.windows.find((window) => window.id === mappedId);
      const other = claude.windows.find((window) => window.id === otherId);
      const availability = claude.quotaSemantics?.effectiveAvailability[0];
      expect(mapped).toBeDefined();
      expect(other).toBeDefined();
      expect(availability).toBeDefined();
      if (!mapped || !other || !availability) continue;

      mapped.percentRemaining = 84;
      mapped.pace = { ...mapped.pace, timeRemainingPercent: 19.7 };
      other.percentRemaining = 95;
      other.pace = { ...other.pace, timeRemainingPercent: 97.3 };
      availability.effectivePercentRemaining = 84;
      availability.limitingWindowIds = [mapped.id];
      availability.runway = {
        status: "projected_exhaustion",
        usableRunwaySeconds: 360000,
        limitingWindowId: other.id,
        projectionConfidence: "established",
      };
      response.providers = [claude];

      const lines = renderQuotaTui(response, {
        timeZone: "America/Los_Angeles",
      }).split("\n");
      const headlineIndex = lines.findIndex((line) =>
        line.includes(`84% ${mapped.label}`),
      );
      expect(headlineIndex).toBeGreaterThanOrEqual(0);
      const headlineBar = lines[headlineIndex + 1];
      const mappedRow = findLine(lines, `│   ${mapped.label}`);

      // The main and sub-bars use different widths, but both must position the
      // marker from their mapped window's reset clock (19.7%), not the other
      // window's runway projection.
      expect(headlineBar).toContain(barText(thinBar(84, 19.7, 41)));
      expect(mappedRow).toContain(barText(thinBar(84, 19.7, 22)));
    }
  });

  it("compacts tied limiting windows and falls back to the scope wording", () => {
    const response = fixtureResponse();
    const grok = response.providers[4];
    grok.windows[0].label = "Grok Super Premium credits";
    grok.windows.push({
      ...grok.windows[0],
      id: "product:grok_build",
      label: "Grok Build",
    });
    const availability = grok.quotaSemantics?.effectiveAvailability[0];
    expect(availability).toBeDefined();
    if (!availability) return;
    availability.limitingWindowIds = ["credits", "product:grok_build"];

    let lines = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    }).split("\n");
    expect(findLine(lines, "45% grok supe… credits +1")).toBeDefined();

    grok.windows.push({
      ...grok.windows[0],
      id: "product:grok_imagine",
      label: "Grok Imagine",
    });
    availability.limitingWindowIds = [
      "credits",
      "product:grok_build",
      "product:grok_imagine",
    ];
    lines = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    }).split("\n");
    expect(findLine(lines, "45% grok supe… credits +2")).toBeDefined();

    availability.limitingWindowIds = ["credits", "missing"];
    lines = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    }).split("\n");
    expect(findLine(lines, "45% all products")).toBeDefined();

    availability.limitingWindowIds = ["missing"];
    lines = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    }).split("\n");
    expect(findLine(lines, "45% all products")).toBeDefined();
  });

  it("omits the triangle for the no-seconds exhaustion fallback", () => {
    const response = fixtureResponse();
    const runway =
      response.providers[1].quotaSemantics?.effectiveAvailability[0]?.runway;
    expect(runway).toBeDefined();
    if (!runway) return;
    runway.usableRunwaySeconds = undefined;

    const output = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    });
    expect(output).toContain("exhaustion projected");
    expect(output).not.toContain("▲");
  });

  it("preserves a long model-window period beside the longest verdict", () => {
    const response = fixtureResponse();
    const claude = response.providers[0];
    const availability = claude.quotaSemantics?.effectiveAvailability[0];
    const modelWindow = claude.windows.find(
      (window) => window.id === "model:fable",
    );
    expect(availability).toBeDefined();
    expect(modelWindow).toBeDefined();
    if (!availability || !availability.runway || !modelWindow) return;
    modelWindow.label = "Claude Opus 4.5 Extended week";
    availability.scope = "model:fable";
    availability.effectivePercentRemaining = 85;
    availability.limitingWindowIds = [modelWindow.id];
    availability.runway.status = "projected_exhaustion";
    availability.runway.usableRunwaySeconds = undefined;

    const lines = renderQuotaTui(response, {
      columns: 80,
      timeZone: "America/Los_Angeles",
    }).split("\n");
    const headline = findLine(lines, "85%");
    expect(headline).toMatch(/85% .* week\s+exhaustion projected/);
    expect(displayColumns(headline)).toBe(CARD_COLUMNS);
  });

  it("preserves a long first window and tie count beside the longest verdict", () => {
    const response = fixtureResponse();
    const claude = response.providers[0];
    const availability = claude.quotaSemantics?.effectiveAvailability[0];
    const modelWindow = claude.windows.find(
      (window) => window.id === "model:fable",
    );
    expect(availability).toBeDefined();
    expect(modelWindow).toBeDefined();
    if (!availability || !availability.runway || !modelWindow) return;
    modelWindow.label = "Claude Opus 4.5 Extended week";
    availability.effectivePercentRemaining = 85;
    availability.limitingWindowIds = [modelWindow.id, "seven_day"];
    availability.runway.status = "projected_exhaustion";
    availability.runway.usableRunwaySeconds = undefined;

    const lines = renderQuotaTui(response, {
      columns: 80,
      timeZone: "America/Los_Angeles",
    }).split("\n");
    const headline = findLine(lines, "85%");
    expect(headline).toMatch(/85% .* week \+1\s+exhaustion projected/);
    expect(displayColumns(headline)).toBe(CARD_COLUMNS);
  });

  it("aligns unequal two-up cards with padding inside the shorter box", () => {
    const lines = render();
    const rowStart = lines.findIndex((line) => line.includes("● grok"));
    const rowEnd = lines.findIndex(
      (line, index) => index > rowStart && line === "",
    );
    expect(rowStart).toBeGreaterThanOrEqual(0);
    expect(rowEnd).toBeGreaterThan(rowStart);

    const row = lines.slice(rowStart, rowEnd);
    expect(row.every((line) => line.length === 100)).toBe(true);
    expect(
      row.every(
        (line) =>
          ["╭╮", "││", "╰╯"].includes(`${line[0]}${line[48]}`) &&
          ["╭╮", "││", "╰╯"].includes(`${line[51]}${line[99]}`),
      ),
    ).toBe(true);
    expect(row.at(-1)?.slice(0, 49)).toMatch(/^╰─+╯$/);
    expect(row.at(-1)?.slice(51)).toMatch(/^╰─+╯$/);
  });

  it("renders a model scope without its machine prefix when it fits", () => {
    const response = fixtureResponse();
    const claude = response.providers[0];
    const availability = claude.quotaSemantics?.effectiveAvailability[0];
    expect(availability).toBeDefined();
    if (!availability) return;
    availability.scope = "model:fable";
    availability.effectivePercentRemaining = 85;
    availability.limitingWindowIds = ["model:fable"];

    const lines = renderQuotaTui(response, {
      columns: 80,
      timeZone: "America/Los_Angeles",
    }).split("\n");
    expect(findLine(lines, "85% fable week · fable")).toBeDefined();
  });

  it("compacts long model-window names without hiding their period", () => {
    const response = fixtureResponse();
    const claude = response.providers[0];
    const availability = claude.quotaSemantics?.effectiveAvailability[0];
    expect(availability).toBeDefined();
    if (!availability) return;
    const modelWindow = claude.windows.find(
      (window) => window.id === "model:fable",
    );
    expect(modelWindow).toBeDefined();
    if (!modelWindow) return;
    modelWindow.label = "Claude Opus 4.5 Extended week";
    availability.scope = "model_fable";
    availability.effectivePercentRemaining = 85;
    availability.limitingWindowIds = [modelWindow.id];

    const lines = renderQuotaTui(response, {
      columns: 80,
      timeZone: "America/Los_Angeles",
    }).split("\n");
    const headline = findLine(lines, "85%");
    expect(headline).toMatch(/85% .* week\s+on pace ✓/);
    expect(displayColumns(headline)).toBe(49);
  });

  it("renders aligned per-window rows with reset countdown and no burn chip", () => {
    const lines = render();
    const session = findCardLine(lines, 0, "│   session");
    expect(session).toContain(" 97%");
    expect(session).toContain("4h 38m");
    const claudeWeek = findCardLine(lines, 0, "│   week");
    expect(claudeWeek).toContain(" 72%");
    expect(claudeWeek).toContain("4d 21h");
    const codexWeek = findCardLine(lines, 1, "│   week");
    expect(codexWeek).toContain("  5%");
    expect(codexWeek).toContain("1d 4h");
    expect(lines.join("\n")).not.toContain("×");
  });

  it("shortens window labels into the 8-char column", () => {
    const lines = render();
    expect(findLine(lines, "fable   ")).toContain(" 85%");
    findLine(lines, "spark   ");
    expect(
      shortWindowLabel({ id: "w", label: "730h window", kind: "unknown" }),
    ).toBe("730h");
    expect(
      shortWindowLabel({ id: "w", label: "Fable week", kind: "model" }),
    ).toBe("fable");
    expect(
      shortWindowLabel({
        id: "w",
        label: "GPT-5.3-Codex-Spark week",
        kind: "model",
      }),
    ).toBe("spark");
  });

  it("omits the marker when a window's pace is unknown", () => {
    const lines = render();
    const spark = findLine(lines, "spark   ");
    const cell = spark.slice(51);
    expect(cell).not.toContain("┃");
    expect(cell).toContain("100%");
  });

  it("omits redundant absolute projected exhaustion notes", () => {
    const lines = render();
    expect(findLine(lines, "empty in 2d 13h")).toBeDefined();
    expect(lines.join("\n")).not.toContain("empty at");
    expect(lines.join("\n")).not.toContain("if pace holds");
    expect(lines.join("\n")).not.toContain("projected empty");
  });

  it("renders signed-out providers as dim cards excluded from totals", () => {
    const lines = render();
    findLine(lines, "○ cursor");
    findLine(lines, "Cursor sign-in required");
    findLine(lines, "unsupported credential type");
    expect(lines.join("\n").match(/excluded from fleet totals/g)).toHaveLength(
      3,
    );
  });

  it("leaves the pace marker to the bars instead of a legend line", () => {
    const output = render().join("\n");
    expect(output).toContain("┃");
    expect(output).not.toContain("marks linear pace");
    expect(output).not.toContain("linear pace");
  });

  it("keeps the live key hint out of the report body", () => {
    expect(render().join("\n")).not.toContain("Press q to quit");
  });

  it("renders the closing hint as its own indented line, fitted to width", () => {
    const hint = "Press q to quit · refreshing every 5m";
    expect(renderTuiHintLine(hint)).toBe(`  ${hint}`);
    const squeezed = renderTuiHintLine("x".repeat(200), { columns: 80 });
    expect(displayColumns(squeezed)).toBe(80);
    expect(squeezed.endsWith("…")).toBe(true);
  });

  it("reflows to a single column below the two-up width", () => {
    const narrow = render({ columns: 80 });
    for (const line of narrow) expect(line.length).toBeLessThanOrEqual(80);
    const claudeTitle = findLine(narrow, "● claude");
    expect(claudeTitle).not.toContain("codex");
    expect(claudeTitle.trimEnd()).toHaveLength(49);
    expect(narrow.length).toBeGreaterThan(render().length);
  });

  it("appends account and source-attempt footers only with full", () => {
    const response = fixtureResponse();
    response.providers[0].account = { email: "kun@example.com" };
    const plain = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    });
    expect(plain).not.toContain("kun@example.com");
    const full = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
      full: true,
    });
    expect(full).toContain(
      "claude · kun@example.com · tried oauth-file → keychain",
    );

    response.providers[0].attempts = [{ source: "oauth", status: "success" }];
    const withAttempt = renderQuotaTui(response, {
      full: true,
      timeZone: "America/Los_Angeles",
    });
    expect(withAttempt).toContain("tried oauth (success)");
  });

  it("preserves full account and attempt evidence within terminal width", () => {
    const response = fixtureResponse();
    response.providers[0].account = {
      email: "a-very-long-email-address@example.invalid",
      organization: "A Very Long Organization Name",
      accountId: "account-1234567890",
      identityStatus: "unverified",
    };
    response.providers[0].attempts = [
      {
        source: "oauth-profile-with-an-extremely-long-source-name",
        status: "skipped",
        error: "identity_context_mismatch",
      },
      { source: "oauth", status: "success" },
    ];
    const lines = renderQuotaTui(response, {
      columns: 80,
      full: true,
      timeZone: "America/Los_Angeles",
    }).split("\n");
    const accountFooter = findLine(lines, "claude ·");
    expect(accountFooter).toContain("id account-");
    expect(accountFooter).toContain("identity unverified");
    expect(accountFooter).toContain("…");
    const attemptFooter = findLine(lines, "tried oauth-profile");
    expect(attemptFooter).toContain("… (skipped: identity_context_mismatch)");
    expect(findLine(lines, "tried oauth (success)")).toBeDefined();
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);

    response.providers[0].account = {
      accountId: "account-123",
      identityStatus: "verified",
    };
    response.providers[0].attempts = [
      { source: "keychain", status: "failed", error: "access_denied" },
    ];
    const evidence = renderQuotaTui(response, {
      columns: 80,
      full: true,
      timeZone: "America/Los_Angeles",
    });
    expect(evidence).toContain("id account-123");
    expect(evidence).toContain("identity verified");
    expect(evidence).toContain("keychain (failed: access_");
  });

  it("bounds CJK account footers by terminal display columns", () => {
    const response = fixtureResponse();
    response.providers[0].account = {
      organization: "配额组织".repeat(20),
    };
    const lines = renderQuotaTui(response, {
      columns: 80,
      full: true,
      timeZone: "America/Los_Angeles",
    }).split("\n");
    const footer = findLine(lines, "claude · 配额组织");
    expect(footer).toContain("…");
    for (const line of lines) {
      expect(displayColumns(line)).toBeLessThanOrEqual(80);
    }
  });

  it("bounds emoji account footers by terminal display columns", () => {
    const response = fixtureResponse();
    response.providers[0].account = {
      organization: "🚀🪐☀️".repeat(24),
    };
    const lines = renderQuotaTui(response, {
      columns: 80,
      full: true,
      timeZone: "America/Los_Angeles",
    }).split("\n");
    const footer = findLine(lines, "claude · 🚀🪐☀️");
    expect(footer).toContain("…");
    for (const line of lines) {
      expect(displayColumns(line)).toBeLessThanOrEqual(80);
    }
  });

  it("sanitizes terminal controls before layout and rendering", () => {
    const hostile = fixtureResponse();
    const safe = fixtureResponse();
    hostile.providers[0].plan = "max\x1b[31m\n\tplus\u009b";
    safe.providers[0].plan = "max[31m plus";
    hostile.providers[0].account = {
      organization: "Org\x1b]0;owned\u0007\nName\tTeam",
    };
    safe.providers[0].account = { organization: "Org]0;ownedName Team" };
    hostile.providers[0].attempts = [
      {
        source: "oauth\x1b[2J",
        status: "failed",
        error: "denied\nnext\tstep\u0085",
      },
    ];
    safe.providers[0].attempts = [
      {
        source: "oauth[2J",
        status: "failed",
        error: "deniednext step",
      },
    ];

    const options = {
      columns: 80,
      full: true,
      timeZone: "America/Los_Angeles",
    } as const;
    const output = renderQuotaTui(hostile, options);
    expect(output).toBe(renderQuotaTui(safe, options));
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\t");
    expect(output).not.toContain("\u0085");
  });

  it("marks a stale provider and keeps effective headroom unknown", () => {
    const response = fixtureResponse();
    const claude = response.providers[0];
    claude.state.status = "stale";
    claude.state.stale = true;
    response.providers[0] = withQuotaSemantics(claude, GENERATED_AT);
    const lines = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
    }).split("\n");
    const title = findLine(lines, "● claude");
    expect(title).toContain("max · oauth · stale");
    findLine(lines, "stale · effective unknown");
    expect(findLine(lines, "stale · effective unknown")).toContain(
      "runway unknown",
    );
  });
});

describe("cards for providers with no combinable bound", () => {
  /**
   * Copilot reports real per-window usage but quota-axi cannot say whether those
   * windows are independent or jointly bounding, so the real interpretation
   * yields no effective availability at all.
   */
  function copilotProvider(stale = false): ProviderQuota {
    const window = (
      id: string,
      label: string,
      percentUsed: number,
    ): ProviderQuota["windows"][number] => ({
      id,
      label,
      kind: "monthly",
      percentUsed,
      percentRemaining: 100 - percentUsed,
      resetsAt: "2026-08-20T00:00:00.000Z",
    });
    return withQuotaSemantics(
      {
        provider: "copilot",
        label: "Copilot",
        source: "api",
        plan: "pro",
        windows: [
          window("chat", "chat", 42),
          window("completions", "completions", 12),
          window("premium_interactions", "premium interactions", 0),
        ],
        state: {
          status: stale ? "stale" : "fresh",
          stale,
          checkedAt: GENERATED_AT,
          sourcesTried: ["apps-json"],
        },
      },
      GENERATED_AT,
    );
  }

  function renderWithCopilot(stale = false): string[] {
    return renderQuotaTui(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 5,
        providers: [claudeProvider(), copilotProvider(stale)],
      },
      { timeZone: "America/Los_Angeles" },
    ).split("\n");
  }

  function unfamiliarClaude(stale: boolean): ProviderQuota {
    const provider = claudeProvider();
    provider.windows.push({
      id: "unexpected_limit",
      label: "unexpected limit",
      kind: "weekly",
      percentUsed: 20,
      percentRemaining: 80,
      resetsAt: "2026-08-12T00:00:00.000Z",
    });
    provider.state.status = stale ? "stale" : "fresh";
    provider.state.stale = stale;
    return withQuotaSemantics(provider, GENERATED_AT);
  }

  it("names the card per-window instead of showing unknown headroom", () => {
    const lines = renderWithCopilot();
    const headline = findCardLine(lines, 1, "per-window usage");
    expect(headline).toContain("no combined bound");
    const card = lines.map((line) => line.slice(CARD_COLUMNS + 2)).join("\n");
    expect(card).not.toContain("effective unknown");
    expect(card).not.toContain("runway unknown");
  });

  it("drops the empty effective bar rather than rendering an empty track", () => {
    const lines = renderWithCopilot();
    const emptyTrack = lines
      .map((line) => stripAnsi(line).slice(CARD_COLUMNS + 2))
      .filter((line) => /^\u2502\s+\u2500{10,}\s+\u2502$/.test(line));
    expect(emptyTrack).toHaveLength(0);
  });

  it("keeps the per-window rows it does have", () => {
    const lines = renderWithCopilot();
    expect(findCardLine(lines, 1, "chat")).toContain("58%");
    expect(findCardLine(lines, 1, "comple")).toContain("88%");
    expect(findCardLine(lines, 1, "premiu")).toContain("100%");
  });

  it("still marks the card stale when the snapshot is stale", () => {
    const lines = renderWithCopilot(true);
    expect(findCardLine(lines, 1, "\u25cf copilot")).toContain("stale");
    expect(findCardLine(lines, 1, "stale \u00b7 per-window usage")).toContain(
      "no combined bound",
    );
  });

  it("states a windowless provider's raw credit balance instead of an empty bar", () => {
    const creditsOnly = withQuotaSemantics(
      {
        provider: "commandcode",
        label: "Command Code",
        source: "api",
        windows: [],
        credits: { remaining: 12.5, unit: "credits" },
        state: {
          status: "fresh",
          stale: false,
          refreshedAt: GENERATED_AT,
          authStatus: "usable",
          sourcesTried: ["pi:commandcode"],
        },
      },
      GENERATED_AT,
    );
    const lines = renderQuotaTui(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 5,
        providers: [creditsOnly],
      },
      { timeZone: "America/Los_Angeles" },
    ).split("\n");

    expect(findLine(lines, "12.5 credits remaining")).toBeDefined();
    expect(lines.join("\n")).not.toContain("effective unknown");
    const emptyTrack = lines
      .map((line) => stripAnsi(line))
      .filter((line) => /^│\s+─{10,}\s+│$/.test(line));
    expect(emptyTrack).toHaveLength(0);
  });

  it("renders Cursor's jointly bounded card with its effective bar", () => {
    const cursor = withQuotaSemantics(
      {
        provider: "cursor",
        label: "Cursor",
        source: "state-vscdb",
        plan: "pro",
        windows: [
          {
            id: "included_usage",
            label: "included usage",
            kind: "monthly",
            percentUsed: 42,
            percentRemaining: 58,
            resetsAt: "2026-08-20T00:00:00.000Z",
          },
          {
            id: "auto_usage",
            label: "auto usage",
            kind: "monthly",
            percentUsed: 12,
            percentRemaining: 88,
            resetsAt: "2026-08-20T00:00:00.000Z",
          },
        ],
        state: {
          status: "fresh",
          stale: false,
          refreshedAt: GENERATED_AT,
          sourcesTried: ["state-vscdb"],
        },
      },
      GENERATED_AT,
    );
    const lines = renderQuotaTui(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 5,
        providers: [claudeProvider(), cursor],
      },
      { timeZone: "America/Los_Angeles" },
    ).split("\n");

    expect(findCardLine(lines, 1, "58%")).toContain("includ");
    const card = lines.map((line) => line.slice(CARD_COLUMNS + 2)).join("\n");
    expect(card).not.toContain("no combined bound");
  });

  it("leaves a provider with combinable bounds rendering its effective bar", () => {
    const lines = renderWithCopilot();
    const withoutCopilot = renderQuotaTui(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 5,
        providers: [claudeProvider()],
      },
      { timeZone: "America/Los_Angeles" },
    ).split("\n");
    const claudeCard = lines.map((line) => line.slice(0, CARD_COLUMNS));
    expect(claudeCard.slice(2, 2 + withoutCopilot.length - 2)).toEqual(
      withoutCopilot.slice(2).map((line) => line.slice(0, CARD_COLUMNS)),
    );
    expect(findCardLine(lines, 0, "72% week")).toBeDefined();
  });

  it.each([
    ["fresh", false, "effective unknown"],
    ["stale", true, "stale · effective unknown"],
  ])(
    "keeps the %s effective headline for partially understood providers",
    (_label, stale, headline) => {
      const output = renderQuotaTui(
        {
          generatedAt: GENERATED_AT,
          schemaVersion: 5,
          providers: [unfamiliarClaude(stale)],
        },
        { timeZone: "America/Los_Angeles" },
      );
      const lines = output.split("\n");
      expect(findLine(lines, headline)).toContain("runway unknown");
      expect(output).not.toContain("per-window usage");
      expect(
        lines.some((line) => /^│\s+─{10,}\s+│$/.test(stripAnsi(line))),
      ).toBe(true);
    },
  );
});

describe("used-share window rows", () => {
  it("prints percentUsed of the parent instead of a remaining bar or ?", () => {
    const kimi = withQuotaSemantics(
      {
        provider: "kimi",
        label: "Kimi",
        source: "api",
        windows: [
          {
            id: "five_hour",
            label: "session",
            kind: "session",
            percentUsed: 30,
            percentRemaining: 70,
            resetsAt: "2026-08-07T04:00:00.000Z",
            windowSeconds: 18_000,
          },
          {
            id: "month_total",
            label: "month",
            kind: "monthly",
            percentUsed: 40,
            percentRemaining: 60,
            resetsAt: "2026-09-01T00:00:00.000Z",
          },
          {
            id: "month_code",
            label: "code month",
            kind: "monthly",
            percentUsed: 25,
            shareOf: "month_total",
            resetsAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        state: { status: "fresh", stale: false, sourcesTried: ["api"] },
      },
      GENERATED_AT,
    );
    const lines = renderQuotaTui(
      { generatedAt: GENERATED_AT, schemaVersion: 5, providers: [kimi] },
      { timeZone: "America/Los_Angeles" },
    ).split("\n");
    const code = findLine(lines, "│   code");
    expect(code).toContain("25% of month");
    expect(code).not.toContain("?");
    expect(code).not.toContain("━");
    expect(code).not.toContain("─");
    expect(findLine(lines, "│   session")).toContain(" 70%");
    expect(findLine(lines, "│   month")).toContain(" 60%");

    // A share is already a used figure, so the used view leaves it as is and
    // flips only the windows around it.
    const used = renderQuotaTui(
      { generatedAt: GENERATED_AT, schemaVersion: 5, providers: [kimi] },
      { timeZone: "America/Los_Angeles", show: "used" },
    ).split("\n");
    expect(findLine(used, "│   code")).toBe(code);
    expect(findLine(used, "│   session")).toContain(" 30%");
    expect(findLine(used, "│   month")).toContain(" 40%");
  });

  it("still shows ? when remaining is absent on a window that is not a share", () => {
    const copilot = withQuotaSemantics(
      {
        provider: "copilot",
        label: "Copilot",
        source: "api",
        windows: [
          {
            id: "chat",
            label: "chat",
            kind: "monthly",
            percentUsed: 42,
          },
        ],
        state: { status: "fresh", stale: false, sourcesTried: ["apps-json"] },
      },
      GENERATED_AT,
    );
    const lines = renderQuotaTui(
      { generatedAt: GENERATED_AT, schemaVersion: 5, providers: [copilot] },
      { timeZone: "America/Los_Angeles" },
    ).split("\n");
    const chat = findLine(lines, "│   chat");
    expect(chat).toContain("?");
    expect(chat).not.toContain("% of");

    // The used view is a display of the same remaining figure, so it does not
    // turn an unmeasured window into a measured one either.
    const used = renderQuotaTui(
      { generatedAt: GENERATED_AT, schemaVersion: 5, providers: [copilot] },
      { timeZone: "America/Los_Angeles", show: "used" },
    ).split("\n");
    expect(findLine(used, "│   chat")).toBe(chat);
  });
});

describe("thin bars with pace markers", () => {
  it("places the marker at the linear-pace position over the fill", () => {
    expect(barText(thinBar(97, 92.9, 13))).toBe("━━━━━━━━━━━━┃");
    expect(barText(thinBar(5, 16.8, 13))).toBe("╸─┃──────────");
    expect(barText(thinBar(100, 100, 13))).toBe("━━━━━━━━━━━━┃");
    expect(barText(thinBar(85, 70, 13))).toBe("━━━━━━━━━┃━──");
  });

  it("styles fill by health thresholds and the marker as the pace cursor", () => {
    const bar = thinBar(5, 16.8, 13);
    expect(bar.map((segment) => segment.style)).toEqual([
      "crit",
      "track",
      "marker",
      "track",
    ]);
    expect(thinBar(45, undefined, 10)[0]?.style).toBe("warn");
    expect(thinBar(72, undefined, 10)[0]?.style).toBe("ok");
  });

  it("omits the marker when pace is unknown instead of faking one", () => {
    expect(barText(thinBar(50, undefined, 10))).toBe("━━━━━─────");
    expect(barText(thinBar(undefined, undefined, 10))).toBe("──────────");
  });

  it("keeps a nonzero fill visible and a nonfull bar open at the edges", () => {
    expect(barText(thinBar(1, undefined, 13))).toBe("╸────────────");
    expect(barText(thinBar(99.9, undefined, 5))).toBe("━━━━╸");
    expect(barText(thinBar(0, undefined, 5))).toBe("─────");
  });
});

describe("used display preference", () => {
  it("keeps the canonical remaining view by default", () => {
    expect(render({ show: "remaining" })).toEqual(render());
  });

  it("labels each headline with how much of its binding window is used", () => {
    const lines = render({ show: "used" });
    expect(findCardLine(lines, 0, "28% used · week")).toContain("on pace ✓");
    expect(findCardLine(lines, 1, "95% used · week")).toContain(
      "empty in 7h 21m",
    );
    expect(findLine(lines, "55% used · credits")).toContain("empty in 2d 13h");
    expect(lines.join("\n")).not.toContain("72% week");
  });

  it("prints each window row as the complement of its remaining figure", () => {
    const lines = render({ show: "used" });
    expect(findCardLine(lines, 0, "│   session")).toContain("  3%");
    expect(findCardLine(lines, 0, "│   week")).toContain(" 28%");
    expect(findCardLine(lines, 0, "│   fable")).toContain(" 15%");
    expect(findCardLine(lines, 1, "│   week")).toContain(" 95%");
    expect(findCardLine(lines, 1, "│   spark")).toContain("  0%");
  });

  it("rounds raw consumption independently of remaining in the headline and row", () => {
    const response = fixtureResponse();
    const claude = response.providers[0];
    const session = claude.windows[0];
    session.percentUsed = 48.5;
    session.percentRemaining = 51.5;
    const availability = claude.quotaSemantics?.effectiveAvailability[0];
    expect(availability).toBeDefined();
    if (!availability) return;
    availability.effectivePercentRemaining = 51.5;
    availability.limitingWindowIds = [session.id];
    const lines = (show: "remaining" | "used"): string[] =>
      renderQuotaTui(response, {
        timeZone: "America/Los_Angeles",
        show,
      }).split("\n");
    expect(findCardLine(lines("remaining"), 0, "52% session")).toBeDefined();
    expect(findCardLine(lines("remaining"), 0, "│   session")).toContain(
      " 52%",
    );
    expect(findCardLine(lines("used"), 0, "49% used · session")).toBeDefined();
    expect(findCardLine(lines("used"), 0, "│   session")).toContain(" 49%");
  });

  it("mirrors the bar fill and pace marker onto the used side", () => {
    expect(barText(thinBar(97, 92.9, 13, "used"))).toBe("╸┃───────────");
    expect(barText(thinBar(5, 16.8, 13, "used"))).toBe("━━━━━━━━━━━┃╸");
    expect(barText(thinBar(100, 100, 13, "used"))).toBe("┃────────────");
    expect(barText(thinBar(85, 70, 13, "used"))).toBe("━━──┃────────");
    expect(barText(thinBar(undefined, undefined, 13, "used"))).toBe(
      "─────────────",
    );
  });

  it("keeps coloring the fill by headroom", () => {
    expect(thinBar(5, 16.8, 13, "used")[0]?.style).toBe("crit");
    expect(thinBar(45, undefined, 10, "used")[0]?.style).toBe("warn");
    expect(thinBar(97, undefined, 10, "used")[0]?.style).toBe("ok");
  });

  it("changes only the percentages, bars, and headline direction", () => {
    const remaining = render();
    const used = render({ show: "used" });
    expect(used).toHaveLength(remaining.length);
    const neutral = (line: string): string =>
      line
        .replace(/\d+%( used ·)?/g, "N%")
        .replace(/[━╸┃─]{8,}/g, (bar) => "=".repeat(bar.length))
        .replace(/ +/g, " ");
    expect(used.map(neutral)).toEqual(remaining.map(neutral));
    for (const line of used)
      expect(displayColumns(line)).toBeLessThanOrEqual(100);
  });
});

describe("countdown formatting", () => {
  it("uses two units and degrades to one to stay within six chars", () => {
    expect(formatCountdown(26481)).toBe("7h 21m");
    expect(formatCountdown(16740)).toBe("4h 39m");
    expect(formatCountdown(86340)).toBe("23h");
    expect(formatCountdown(421200)).toBe("4d 21h");
    expect(formatCountdown(2245000)).toBe("25d");
    expect(formatCountdown(123456 * 86400)).toBe("12345…");
    expect(formatCountdown(600)).toBe("10m");
    expect(formatCountdown(30)).toBe("<1m");
    expect(formatCountdown(0)).toBe("now");
  });
});

describe("color handling", () => {
  it("emits plain glyph skeleton when color is off", () => {
    const output = renderQuotaTui(fixtureResponse(), {
      timeZone: "America/Los_Angeles",
    });
    expect(output).not.toContain("\x1b[");
  });

  it("emits truecolor SGR sequences that strip back to the plain skeleton", () => {
    const plain = renderQuotaTui(fixtureResponse(), {
      timeZone: "America/Los_Angeles",
    });
    const colored = renderQuotaTui(fixtureResponse(), {
      timeZone: "America/Los_Angeles",
      colorDepth: "truecolor",
    });
    expect(colored).toContain("\x1b[1;38;2;250;179;135m");
    expect(stripAnsi(colored)).toBe(plain);
  });

  it("maps the palette to 256-color and 16-color depths", () => {
    const c256 = renderQuotaTui(fixtureResponse(), {
      timeZone: "America/Los_Angeles",
      colorDepth: "256",
    });
    expect(c256).toContain("\x1b[38;5;");
    const c16 = renderQuotaTui(fixtureResponse(), {
      timeZone: "America/Los_Angeles",
      colorDepth: "16",
    });
    expect(c16).toContain("\x1b[32m");
    expect(c16).not.toContain("38;2;");
  });

  it("colors runway exhaustion independently from healthy headroom", () => {
    const response = fixtureResponse();
    const availability =
      response.providers[0].quotaSemantics?.effectiveAvailability[0];
    expect(availability).toBeDefined();
    if (!availability) return;
    availability.runway = {
      status: "projected_exhaustion",
      usableRunwaySeconds: 3600,
      limitingWindowId: "seven_day",
      projectionConfidence: "established",
    };
    const projected = renderQuotaTui(response, {
      colorDepth: "truecolor",
      timeZone: "America/Los_Angeles",
    });
    expect(projected).toContain("\x1b[1;38;2;166;227;161m72%\x1b[0m");
    expect(projected).toContain(
      "\x1b[1;38;2;249;226;175mempty in 1h 0m\x1b[0m",
    );

    availability.runway = {
      status: "exhausted_now",
      usableRunwaySeconds: 0,
      projectionConfidence: "established",
    };
    const exhausted = renderQuotaTui(response, {
      colorDepth: "truecolor",
      timeZone: "America/Los_Angeles",
    });
    expect(exhausted).toContain(
      "\x1b[1;38;2;243;139;168m✗ exhausted now\x1b[0m",
    );
  });

  it("pads a shorter account card with blank rows, not its account line", () => {
    const work = { ...codexProvider(), accountKey: "openai-codex-work" };
    const personal = {
      ...signedOutProvider("kimi", "Codex sign-in required"),
      provider: "codex",
      label: "Codex",
      accountKey: "openai-codex",
    };
    const lines = renderQuotaTui(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 5,
        providers: [work, personal],
      },
      { columns: 120, timeZone: "America/Los_Angeles" },
    ).split("\n");

    const cardLines = (card: 0 | 1): string[] =>
      lines.map((line) =>
        card === 0 ? line.slice(0, CARD_COLUMNS) : line.slice(CARD_COLUMNS + 2),
      );
    const accountRows = (card: 0 | 1, key: string): number =>
      cardLines(card).filter((line) => line.includes(`account ${key} `)).length;
    expect(accountRows(0, "openai-codex-work")).toBe(1);
    expect(accountRows(1, "openai-codex")).toBe(1);
    expect(findCardLine(lines, 1, "Codex sign-in required")).toBeDefined();
  });

  it("keeps the filler account key out of the full footer", () => {
    const response = fixtureResponse();
    response.providers[0].accountKey = "default";
    response.providers[0].account = { email: "kun@example.com" };
    const full = renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
      full: true,
    });
    expect(findLine(full.split("\n"), "claude ·")).not.toContain("· default");
    expect(full).toContain("claude · kun@example.com");

    response.providers[0].accountKey = "openai-codex-work";
    expect(
      renderQuotaTui(response, {
        timeZone: "America/Los_Angeles",
        full: true,
      }),
    ).toContain("claude · openai-codex-work · kun@example.com");
  });

  it("detects color depth from the environment", () => {
    expect(detectTuiColorDepth({}, false)).toBe("none");
    expect(detectTuiColorDepth({ NO_COLOR: "" }, true)).toBe("none");
    expect(detectTuiColorDepth({ TERM: "dumb" }, true)).toBe("none");
    expect(detectTuiColorDepth({ TERM: "xterm-256color" }, true)).toBe("256");
    expect(
      detectTuiColorDepth(
        { COLORTERM: "truecolor", TERM: "xterm-256color" },
        true,
      ),
    ).toBe("truecolor");
    expect(detectTuiColorDepth({ TERM: "xterm" }, true)).toBe("16");
    expect(detectTuiColorDepth({ FORCE_COLOR: "1" }, false)).toBe("16");
    expect(detectTuiColorDepth({ FORCE_COLOR: "3" }, false)).toBe("truecolor");
    expect(
      detectTuiColorDepth({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, false),
    ).toBe("none");
  });
});

describe("providers that are not set up", () => {
  function notSetUp(
    provider: ProviderQuota["provider"],
    sources: string[] = [`env:${provider.toUpperCase()}_API_KEY`],
  ): ProviderQuota {
    return {
      provider,
      label: provider,
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: `${provider}_credential_unavailable`,
        sourcesTried: sources,
      },
      attempts: sources.map((source) => ({
        source,
        status: "skipped",
        error: "credentials_missing",
      })),
    };
  }

  function brokenKimi(): ProviderQuota {
    return {
      provider: "kimi",
      label: "Kimi",
      source: "unavailable",
      windows: [],
      state: {
        status: "error",
        stale: false,
        error: "schema_invalid",
        sourcesTried: ["pi:kimi-coding"],
      },
      attempts: [
        { source: "pi:kimi-coding", status: "failed", error: "schema_invalid" },
      ],
    };
  }

  /** Declaration order interleaves every tier on purpose. */
  function fleet(): QuotaAxiResponse {
    return {
      generatedAt: GENERATED_AT,
      schemaVersion: 5,
      providers: [
        notSetUp("zai", ["pi:zai", "opencode:auth.json"]),
        claudeProvider(),
        notSetUp("agy", ["cli", "loopback"]),
        brokenKimi(),
        codexProvider(),
        notSetUp("alibaba", ["bl-cli"]),
        notSetUp("opencode-go", ["opencode:auth.json"]),
        notSetUp("commandcode"),
        notSetUp("minimax"),
        notSetUp("mimo"),
        notSetUp("deepseek"),
        notSetUp("openrouter"),
        notSetUp("elevenlabs"),
      ],
    };
  }

  function frame(
    response: QuotaAxiResponse,
    options: Parameters<typeof renderQuotaTui>[1] = {},
  ): string[] {
    return renderQuotaTui(response, {
      timeZone: "America/Los_Angeles",
      ...options,
    }).split("\n");
  }

  it("folds them into one footer line after the live and broken cards", () => {
    const lines = frame(fleet());

    expect(lines[0]).toBe(
      "  quota-axi · 2026-08-06 16:21 PDT · 2 live · 1 needs attention · 10 not set up",
    );
    expect(findLine(lines, "● claude")).toMatch(/● claude .*● codex /);
    const kimi = lines.findIndex((line) => line.includes("○ kimi"));
    const footer = lines.findIndex((line) => line.includes("○ not set up"));
    expect(kimi).toBeGreaterThan(lines.findIndex((l) => l.includes("● codex")));
    expect(footer).toBeGreaterThan(kimi);
    expect(lines.slice(footer)).toEqual([
      "  ○ not set up  zai · agy · alibaba · opencode-go · commandcode · minimax · mimo · deepseek",
      "                openrouter · elevenlabs   quota-axi auth shows where each is read",
    ]);
    // No card is drawn for a provider that is not set up.
    expect(lines.join("\n")).not.toMatch(/╭─ ○ (zai|agy|mimo|elevenlabs) /);
  });

  it("wraps the footer under a hanging indent in a narrow terminal", () => {
    const lines = frame(fleet(), { columns: 80 });
    const footer = lines.findIndex((line) => line.includes("○ not set up"));

    expect(lines.slice(footer)).toEqual([
      "  ○ not set up  zai · agy · alibaba · opencode-go · commandcode · minimax",
      "                mimo · deepseek · openrouter · elevenlabs",
      "                quota-axi auth shows where each is read",
    ]);
    for (const line of lines)
      expect(displayColumns(line)).toBeLessThanOrEqual(80);
  });

  it("draws them as full cards below a label when asked", () => {
    const lines = frame(fleet(), { showNotSetUp: true });
    const label = lines.indexOf("  ○ not set up · 10");

    expect(label).toBeGreaterThan(lines.findIndex((l) => l.includes("○ kimi")));
    expect(lines[label + 1]).toBe("");
    // The expanded group starts its own row rather than pairing with kimi.
    expect(lines[label + 2]).toMatch(/^╭─ ○ zai ─+ signed out ─╮ {2}╭─ ○ agy /);
    expect(lines.slice(label)).toContainEqual(
      expect.stringContaining("elevenlabs credential unavailable"),
    );
    expect(lines.join("\n")).not.toContain("quota-axi auth shows where");
    expect(lines[0]).toContain("2 live · 1 needs attention · 10 not set up");
  });

  it("takes presence from the caller, since redaction removes the attempts", () => {
    const complete = fleet();
    const redacted = redactedResponse(complete, false);

    // Without attempts nothing proves absence, so nothing folds.
    expect(frame(redacted)[0]).toContain("2 live · 11 need attention");
    expect(frame(redacted).join("\n")).toContain("╭─ ○ zai ");

    const presence = complete.providers.map((provider) =>
      providerPresence(provider),
    );
    const lines = frame(redacted, { presence });
    expect(lines[0]).toContain("2 live · 1 needs attention · 10 not set up");
    expect(lines.join("\n")).not.toContain("╭─ ○ zai ");
  });

  it("renders only the header and the footer when nothing is set up", () => {
    const response: QuotaAxiResponse = {
      generatedAt: GENERATED_AT,
      schemaVersion: 5,
      providers: [notSetUp("zai"), notSetUp("mimo"), notSetUp("deepseek")],
    };

    expect(frame(response)).toEqual([
      "  quota-axi · 2026-08-06 16:21 PDT · 0 live · 0 need attention · 3 not set up",
      "",
      "  ○ not set up  zai · mimo · deepseek   quota-axi auth shows where each is read",
    ]);

    const expanded = frame(response, { showNotSetUp: true });
    expect(expanded.slice(0, 4)).toEqual([
      "  quota-axi · 2026-08-06 16:21 PDT · 0 live · 0 need attention · 3 not set up",
      "",
      "  ○ not set up · 3",
      "",
    ]);
    expect(expanded[4]).toMatch(/^╭─ ○ zai .*╭─ ○ mimo /);
  });

  it("gives up the timestamp before a tier count in a narrow terminal", () => {
    const response: QuotaAxiResponse = {
      generatedAt: GENERATED_AT,
      schemaVersion: 5,
      providers: PROVIDER_IDS.map((provider) => notSetUp(provider)),
    };
    const zone = { timeZone: "Australia/Adelaide" };
    const wide = frame(response, { ...zone, columns: 120 });
    const narrow = frame(response, { ...zone, columns: 80 });

    // The unabridged header does not fit the narrowest supported terminal.
    expect(displayColumns(wide[0])).toBeGreaterThan(80);
    expect(displayColumns(narrow[0])).toBeLessThanOrEqual(80);
    // The time zone is spent to make room; every count survives.
    expect(narrow[0]).toMatch(
      new RegExp(
        `^ {2}quota-axi · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · 0 live · 0 need attention · ${PROVIDER_IDS.length} not set up$`,
      ),
    );
  });

  it("names every tier in the header, including the ones that are empty", () => {
    const lines = frame({
      generatedAt: GENERATED_AT,
      schemaVersion: 5,
      providers: [claudeProvider(), codexProvider()],
    });

    expect(lines[0]).toBe(
      "  quota-axi · 2026-08-06 16:21 PDT · 2 live · 0 need attention · 0 not set up",
    );
  });

  it("names a folded account lane by provider and account key", () => {
    const work = { ...notSetUp("codex"), accountKey: "openai-codex-work" };
    const lane = { ...notSetUp("zai"), accountKey: "default" };
    const lines = frame({
      generatedAt: GENERATED_AT,
      schemaVersion: 6,
      providers: [work, lane],
    });

    expect(findLine(lines, "○ not set up")).toContain(
      "codex/openai-codex-work · zai ",
    );
  });

  it("truncates a folded name too long for the footer instead of overflowing", () => {
    const long = {
      ...notSetUp("codex"),
      accountKey: `openai-codex-${"w".repeat(80)}`,
    };
    const lines = frame(
      {
        generatedAt: GENERATED_AT,
        schemaVersion: 6,
        providers: [long, notSetUp("zai")],
      },
      { columns: 80 },
    );
    const footer = lines.findIndex((line) => line.includes("○ not set up"));

    for (const line of lines.slice(footer)) {
      expect(displayColumns(line)).toBeLessThanOrEqual(80);
    }
    // The label never stands alone: the first name shares its line, cut to fit.
    expect(lines[footer]).toMatch(
      /^ {2}○ not set up {2}codex\/openai-codex-w+…$/,
    );
    expect(lines.slice(footer + 1)).toEqual([
      "                zai   quota-axi auth shows where each is read",
    ]);
  });

  it("keeps the --full source footers for folded providers", () => {
    const lines = frame(fleet(), { full: true });

    expect(findLine(lines, "  alibaba · tried")).toContain(
      "bl-cli (skipped: credentials_missing)",
    );
  });
});
