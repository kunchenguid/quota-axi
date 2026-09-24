/**
 * Viewport for the live human report. `renderQuotaTui` is height-independent by
 * design: it lays the cards out for the terminal's width and returns however
 * many lines that takes. The live loop paints into the alternate screen, which
 * has no scrollback, so a frame taller than the terminal scrolls its own header
 * and first cards into nothing. This module windows that frame onto the rows
 * actually available and reports what is off-screen, so the report stays
 * within the viewport. Pure string math - no terminal I/O, no derivation.
 */

import {
  sanitizeTerminalText,
  terminalTextUnits,
  terminalUnitWidth,
} from "./tui.js";

/** Rows below which the report header stops being pinned to make room. */
const STICKY_HEADER_MIN_ROWS = 5;

export type ScrollStatus = {
  /** True when the report is taller than the viewport and is being windowed. */
  scrollable: boolean;
  /** Report lines hidden above the window. */
  offset: number;
  /** Largest offset that still fills the window; the bottom of the report. */
  maxOffset: number;
};

export type ScrolledFrame = {
  /** The lines to paint, already limited to the viewport height. */
  text: string;
  /** `offset` clamped to the report's real bounds. */
  offset: number;
  maxOffset: number;
  scrollable: boolean;
  /** Report lines inside the scrolling region; the page-key step. */
  pageLines: number;
  status: ScrollStatus;
};

export type ScrollFrameOptions = {
  /** Terminal height. Unknown or non-positive means no windowing at all. */
  rows?: number;
  /** Terminal width. Unknown means logical rows are used as-is. */
  columns?: number;
  offset?: number;
  /**
   * Closing line, rendered by the caller so it can carry the report's styling.
   * Omitted entirely when absent, which is what the plain loop tests exercise.
   */
  status?: (status: ScrollStatus) => string;
};

/**
 * Window `body` onto `rows` terminal rows. When the whole report plus its
 * closing line already fits, the frame is the report exactly as it renders at
 * full height. When it does not, the first line stays pinned at practical
 * heights, the last row carries the closing line when space permits, and the
 * rest scrolls. At tiny heights, report content takes priority over both.
 */
export function scrollFrame(
  body: string,
  options: ScrollFrameOptions = {},
): ScrolledFrame {
  // A frame is painted without a trailing newline. Treat line breaks at the
  // end of renderer output as separators, not as an extra visible row.
  const normalizedBody = body.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const bodyLines = normalizedBody === "" ? [] : normalizedBody.split("\n");
  const rows = options.rows;
  const columns = options.columns;
  const resting = restingFrame(bodyLines, options.status);
  if (rows === undefined || !Number.isFinite(rows) || rows <= 0) return resting;
  if (
    bodyLines.length + (options.status ? 2 : 0) <= rows &&
    (columns === undefined ||
      !Number.isFinite(columns) ||
      columns <= 0 ||
      physicalRows(resting.text.split("\n"), columns) <= rows)
  ) {
    return resting;
  }

  let headerRows =
    rows >= STICKY_HEADER_MIN_ROWS && bodyLines.length > 0 ? 1 : 0;
  let statusRows = options.status ? 1 : 0;
  // Content wins the last rows: drop the closing line, then the pinned header,
  // rather than ever painting a frame taller than the terminal.
  if (rows - headerRows - statusRows < 1) statusRows = 0;
  if (rows - headerRows - statusRows < 1) headerRows = 0;
  let pageLines = rows - headerRows - statusRows;

  const scrolling = bodyLines.slice(headerRows);
  let maxOffset = Math.max(0, scrolling.length - pageLines);
  let offset = clamp(Math.trunc(options.offset ?? 0), 0, maxOffset);
  const status: ScrollStatus = { scrollable: true, offset, maxOffset };
  let lines = visibleLines(bodyLines, scrolling, headerRows, offset, pageLines);
  if (columns !== undefined && Number.isFinite(columns) && columns > 0) {
    while (pageLines > 1 && physicalRows(lines, columns) > rows) {
      pageLines -= 1;
      maxOffset = Math.max(0, scrolling.length - pageLines);
      offset = clamp(Math.trunc(options.offset ?? 0), 0, maxOffset);
      status.offset = offset;
      status.maxOffset = maxOffset;
      lines = visibleLines(bodyLines, scrolling, headerRows, offset, pageLines);
    }
  }
  // Size the content first. The hint must describe these final bounds, and
  // only then can we decide whether its own wrapped text fits.
  const statusLine = statusRows === 1 ? options.status?.(status) : undefined;
  if (
    statusLine !== undefined &&
    columns !== undefined &&
    Number.isFinite(columns) &&
    columns > 0 &&
    physicalRows([...lines, statusLine], columns) > rows
  ) {
    statusRows = 0;
    pageLines = rows - headerRows;
    maxOffset = Math.max(0, scrolling.length - pageLines);
    offset = clamp(Math.trunc(options.offset ?? 0), 0, maxOffset);
    status.offset = offset;
    status.maxOffset = maxOffset;
    lines = visibleLines(bodyLines, scrolling, headerRows, offset, pageLines);
    while (pageLines > 1 && physicalRows(lines, columns) > rows) {
      pageLines -= 1;
      maxOffset = Math.max(0, scrolling.length - pageLines);
      offset = clamp(Math.trunc(options.offset ?? 0), 0, maxOffset);
      status.offset = offset;
      status.maxOffset = maxOffset;
      lines = visibleLines(bodyLines, scrolling, headerRows, offset, pageLines);
    }
  }
  if (columns !== undefined && Number.isFinite(columns) && columns > 0) {
    const contentRows = rows - (statusRows === 1 ? 1 : 0);
    lines = limitPhysicalRows(lines, contentRows, columns);
  }
  if (statusRows === 1 && statusLine !== undefined) lines.push(statusLine);
  return {
    text: lines.join("\n"),
    offset,
    maxOffset,
    scrollable: true,
    pageLines,
    status,
  };
}

function visibleLines(
  bodyLines: string[],
  scrolling: string[],
  headerRows: number,
  offset: number,
  pageLines: number,
  statusLine?: string,
): string[] {
  const lines = [
    ...bodyLines.slice(0, headerRows),
    ...scrolling.slice(offset, offset + pageLines),
  ];
  if (statusLine !== undefined) lines.push(statusLine);
  return lines;
}

function physicalRows(lines: string[], columns: number): number {
  const ansiEscape = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    "g",
  );
  let rows = 1;
  let column = 0;
  let wrapPending = false;
  for (const [index, line] of lines.entries()) {
    const plainLine = sanitizeTerminalText(line.replace(ansiEscape, ""));
    for (const unit of terminalTextUnits(plainLine)) {
      const unitWidth = terminalUnitWidth(unit);
      if (unitWidth === 0) continue;
      if (wrapPending) {
        rows += 1;
        column = 0;
      }
      const totalWidth = column + unitWidth;
      if (totalWidth > columns) {
        // A grapheme wider than the terminal still occupies all the cells it
        // needs; account for every physical row rather than leaving an
        // impossible column value that never triggers wrapping.
        rows += Math.floor((totalWidth - 1) / columns);
        column = totalWidth % columns;
        wrapPending = column === 0;
      } else {
        column = totalWidth;
        wrapPending = column === columns;
      }
    }
    if (index < lines.length - 1) {
      rows += 1;
      column = 0;
      wrapPending = false;
    }
  }
  return rows;
}

function limitPhysicalRows(
  lines: string[],
  rows: number,
  columns: number,
): string[] {
  const limited: string[] = [];
  let remainingRows = rows;
  for (const line of lines) {
    if (remainingRows <= 0) break;
    const lineRows = physicalRows([line], columns);
    const allowedRows = Math.min(remainingRows, lineRows);
    limited.push(
      lineRows > allowedRows
        ? truncateTerminalWidth(line, allowedRows * columns)
        : line,
    );
    remainingRows -= Math.min(lineRows, allowedRows);
  }
  return limited;
}

function truncateTerminalWidth(line: string, width: number): string {
  if (width <= 0) return "";
  const ansiEscape = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    "g",
  );
  let result = "";
  let used = 0;
  let cursor = 0;
  let activeSgr = false;
  for (const match of line.matchAll(ansiEscape)) {
    const plain = line.slice(cursor, match.index);
    const portion = truncateUnits(plain, width - used);
    result += portion;
    used += displayWidth(portion);
    if (portion.length < plain.length) {
      return result + (activeSgr ? "\x1b[0m" : "");
    }
    result += match[0];
    const sgr = match[0].match(
      new RegExp(`^${String.fromCharCode(27)}\\[([0-9;]*)m$`),
    );
    if (sgr) {
      for (const parameter of sgr[1].split(";")) {
        activeSgr = parameter === "0" || parameter === "" ? false : true;
      }
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  const tail = truncateUnits(line.slice(cursor), width - used);
  if (tail.length < line.length - cursor) {
    return result + tail + (activeSgr ? "\x1b[0m" : "");
  }
  return result + tail;
}

function truncateUnits(text: string, width: number): string {
  if (width <= 0) return "";
  let result = "";
  let used = 0;
  for (const unit of terminalTextUnits(sanitizeTerminalText(text))) {
    const unitWidth = terminalUnitWidth(unit);
    if (used + unitWidth > width) break;
    result += unit;
    used += unitWidth;
  }
  return result;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const unit of terminalTextUnits(sanitizeTerminalText(text))) {
    width += terminalUnitWidth(unit);
  }
  return width;
}

function restingFrame(
  bodyLines: string[],
  status?: (status: ScrollStatus) => string,
): ScrolledFrame {
  const resting: ScrollStatus = { scrollable: false, offset: 0, maxOffset: 0 };
  const lines = [...bodyLines];
  if (status) lines.push("", status(resting));
  return {
    text: lines.join("\n"),
    offset: 0,
    maxOffset: 0,
    scrollable: false,
    pageLines: Math.max(1, bodyLines.length),
    status: resting,
  };
}

/**
 * Closing-line text: the caller's resting hint while everything fits, and the
 * scroll affordance - how much is off-screen in each direction, plus the keys
 * that move it - once the report is being windowed. `keyHints` names the
 * caller's own keys so the scroll affordance does not hide them.
 */
export function scrollHint(
  status: ScrollStatus,
  restingHint: string,
  keyHints: readonly string[] = [],
): string {
  if (!status.scrollable) return restingHint;
  const above = status.offset;
  const below = status.maxOffset - status.offset;
  const parts: string[] = [];
  if (above > 0) parts.push(`↑ ${above} more`);
  if (below > 0) parts.push(`↓ ${below} more`);
  parts.push("j/k PgUp/PgDn g/G scroll", "r refresh", ...keyHints, "q quit");
  return parts.join(" · ");
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
