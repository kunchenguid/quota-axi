import { describe, expect, it } from "vitest";
import { renderQuotaTui } from "../src/tui.js";
import { scrollFrame, scrollHint } from "../src/tui-viewport.js";
import { fixtureResponse } from "./fixtures/tui-response.js";

const HINT = "Press q to quit · refreshing every 5m";

/** The report exactly as the live loop renders it, at a fixed width. */
function reportBody(): string {
  return renderQuotaTui(fixtureResponse(), {
    timeZone: "America/Los_Angeles",
    columns: 100,
  });
}

function status(): (state: {
  scrollable: boolean;
  offset: number;
  maxOffset: number;
}) => string {
  return (state) => `  ${scrollHint(state, HINT)}`;
}

function frameLines(body: string, rows?: number, offset = 0): string[] {
  return scrollFrame(body, {
    ...(rows === undefined ? {} : { rows }),
    offset,
    status: status(),
  }).text.split("\n");
}

/** Every line the operator can bring on screen by scrolling through the report. */
function reachableLines(body: string, rows: number): Set<string> {
  const reached = new Set<string>();
  let offset = 0;
  for (;;) {
    const frame = scrollFrame(body, { rows, offset, status: status() });
    for (const line of frame.text.split("\n")) reached.add(line);
    if (!frame.scrollable || frame.offset >= frame.maxOffset) return reached;
    offset = frame.offset + frame.pageLines;
  }
}

describe("live report viewport", () => {
  it("leaves a report that fits exactly as it renders, plus its hint", () => {
    const body = reportBody();
    const bodyLines = body.split("\n");
    const frame = scrollFrame(body, {
      rows: bodyLines.length + 2,
      status: status(),
    });

    expect(frame.scrollable).toBe(false);
    expect(frame.offset).toBe(0);
    expect(frame.text.split("\n")).toEqual([...bodyLines, "", `  ${HINT}`]);
  });

  it("windows a report taller than the terminal without exceeding it", () => {
    const body = reportBody();
    for (const rows of [5, 8, 10, 14, 24, 30]) {
      const lines = frameLines(body, rows);
      expect(lines.length, `rows=${rows}`).toBeLessThanOrEqual(rows);
      expect(lines.length, `rows=${rows}`).toBeGreaterThan(0);
    }
  });

  it("keeps the report header pinned and the hint on the last row", () => {
    const body = reportBody();
    const header = body.split("\n")[0];
    for (const rows of [8, 12, 20]) {
      for (const offset of [0, 3, 500]) {
        const lines = frameLines(body, rows, offset);
        expect(lines[0], `rows=${rows} offset=${offset}`).toBe(header);
        expect(lines.at(-1)).toContain("scroll");
        expect(lines.at(-1)).toContain("q quit");
      }
    }
  });

  it("reaches every line of a report by scrolling, at every short height", () => {
    // Distinct lines so reachability is counted per line, not per repeated
    // blank or border row that the real report shares between cards.
    const body = Array.from({ length: 60 }, (_, index) => `line ${index}`).join(
      "\n",
    );
    for (const rows of [3, 5, 9, 12, 20, 33]) {
      const reached = reachableLines(body, rows);
      const missing = body.split("\n").filter((line) => !reached.has(line));
      expect(missing, `rows=${rows} never showed these lines`).toEqual([]);
    }
  });

  it("brings every provider card on screen at short heights", () => {
    const body = reportBody();
    const titles = body
      .split("\n")
      .flatMap((line) => line.match(/[●○] \w+/g) ?? []);
    expect(titles.length).toBeGreaterThanOrEqual(6);

    for (const rows of [6, 9, 12, 20]) {
      const reached = [...reachableLines(body, rows)].join("\n");
      for (const title of titles) {
        expect(reached, `rows=${rows} never showed ${title}`).toContain(title);
      }
    }
  });

  it("clamps the offset to the ends of the report", () => {
    const body = reportBody();
    const top = scrollFrame(body, { rows: 12, offset: -50, status: status() });
    const bottom = scrollFrame(body, {
      rows: 12,
      offset: 10_000,
      status: status(),
    });

    expect(top.offset).toBe(0);
    expect(top.text).toBe(
      scrollFrame(body, { rows: 12, offset: 0, status: status() }).text,
    );
    expect(bottom.offset).toBe(bottom.maxOffset);
    expect(bottom.text.split("\n").at(-2)).toBe(body.split("\n").at(-1));
  });

  it("announces how much is off screen in each direction", () => {
    const body = reportBody();
    const top = scrollFrame(body, { rows: 12, offset: 0, status: status() });
    const middle = scrollFrame(body, { rows: 12, offset: 4, status: status() });
    const bottom = scrollFrame(body, {
      rows: 12,
      offset: 10_000,
      status: status(),
    });

    expect(top.text).toContain(`↓ ${top.maxOffset} more`);
    expect(top.text).not.toContain("↑");
    expect(middle.text).toContain("↑ 4 more");
    expect(middle.text).toContain(`↓ ${middle.maxOffset - 4} more`);
    expect(bottom.text).toContain(`↑ ${bottom.maxOffset} more`);
    expect(bottom.text).not.toContain("↓");
  });

  it("grows the visible window back as the terminal grows", () => {
    const body = reportBody();
    const heights = [8, 12, 20, 30];
    const visible = heights.map(
      (rows) => scrollFrame(body, { rows, status: status() }).pageLines,
    );
    expect(visible).toEqual([...visible].sort((a, b) => a - b));
    expect(new Set(visible).size).toBe(heights.length);

    const tall = scrollFrame(body, {
      rows: body.split("\n").length + 40,
      offset: 12,
      status: status(),
    });
    expect(tall.scrollable).toBe(false);
    expect(tall.offset).toBe(0);
    expect(tall.text.split("\n")[0]).toBe(body.split("\n")[0]);
  });

  it("gives content the last rows when the terminal is tiny", () => {
    const body = reportBody();
    for (const rows of [1, 2, 3, 4]) {
      const frame = scrollFrame(body, { rows, status: status() });
      const lines = frame.text.split("\n");
      expect(lines.length, `rows=${rows}`).toBeLessThanOrEqual(rows);
      expect(frame.pageLines, `rows=${rows}`).toBeGreaterThanOrEqual(1);
    }
    expect(reachableLines(body, 3).size).toBeGreaterThan(3);
  });

  it("paints unwindowed when the terminal height is unknown", () => {
    const body = reportBody();
    const bodyLines = body.split("\n");
    for (const rows of [undefined, 0, Number.NaN]) {
      const frame = scrollFrame(body, {
        ...(rows === undefined ? {} : { rows }),
        offset: 7,
        status: status(),
      });
      expect(frame.scrollable).toBe(false);
      expect(frame.text.split("\n")).toEqual([...bodyLines, "", `  ${HINT}`]);
    }
  });

  it("omits the closing line entirely when the caller supplies none", () => {
    const body = reportBody();
    expect(scrollFrame(body).text).toBe(body);
    const windowed = scrollFrame(body, { rows: 9 });
    expect(windowed.text.split("\n").length).toBe(9);
    expect(windowed.text).not.toContain("q quit");
  });

  it("preserves meaningful trailing blank rows", () => {
    expect(scrollFrame("a\n\n").text).toBe("a\n");
  });

  it("counts repeated lines when protecting the physical row budget", () => {
    const frame = scrollFrame("x\nx\nx", {
      rows: 3,
      columns: 1,
      status: () => "x",
    });
    expect(frame.text).toBe("x\nx\nx");
  });

  it("protects the physical row budget without a closing line", () => {
    const frame = scrollFrame(`${"x".repeat(160)}\ny`, {
      rows: 3,
      columns: 80,
    });
    expect(frame.text).toBe(`${"x".repeat(160)}\ny`);
    expect(frame.pageLines).toBe(2);
  });

  it("counts wide graphemes when checking physical rows", () => {
    const frame = scrollFrame(`${"a".repeat(79)}界`, {
      rows: 1,
      columns: 80,
    });
    expect(frame.scrollable).toBe(true);
  });

  it("does not count combining graphemes as extra cells", () => {
    const frame = scrollFrame(`${"a".repeat(80)}\u0301`, {
      rows: 1,
      columns: 80,
    });
    expect(frame.scrollable).toBe(false);
  });

  it("counts a wide grapheme that exceeds a narrow terminal", () => {
    const frame = scrollFrame("界", {
      rows: 1,
      columns: 1,
    });
    expect(frame.scrollable).toBe(true);
  });

  it("clips a logical line that exceeds the physical viewport", () => {
    const frame = scrollFrame("x".repeat(160), {
      rows: 1,
      columns: 80,
    });
    expect(frame.text).toBe("x".repeat(80));
  });

  it("counts a full-width line break as one physical row", () => {
    const frame = scrollFrame(`${"x".repeat(80)}\ny`, {
      rows: 2,
      columns: 80,
    });
    expect(frame.scrollable).toBe(false);
    expect(frame.text).toBe(`${"x".repeat(80)}\ny`);
  });

  it("keeps the resting hint verbatim and swaps it for scroll help", () => {
    expect(
      scrollHint({ scrollable: false, offset: 0, maxOffset: 0 }, HINT),
    ).toBe(HINT);
    const scrolling = scrollHint(
      { scrollable: true, offset: 2, maxOffset: 9 },
      HINT,
    );
    expect(scrolling).toContain("↑ 2 more");
    expect(scrolling).toContain("↓ 7 more");
    expect(scrolling).toContain("r refresh");
    expect(scrolling).not.toContain(HINT);
  });

  it("keeps the caller's own keys in the scroll help", () => {
    expect(
      scrollHint({ scrollable: true, offset: 0, maxOffset: 4 }, HINT, [
        "a show not set up",
      ]),
    ).toBe(
      "↓ 4 more · j/k PgUp/PgDn g/G scroll · r refresh · a show not set up · q quit",
    );
    expect(
      scrollHint({ scrollable: false, offset: 0, maxOffset: 0 }, HINT, [
        "a show not set up",
      ]),
    ).toBe(HINT);
  });
});
