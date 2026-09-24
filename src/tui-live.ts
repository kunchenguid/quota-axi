/**
 * Live loop for the human terminal report: paint a frame, then repaint on a
 * fixed refresh interval until the operator quits with `q` or Ctrl+C; `r`
 * refreshes immediately. Every terminal effect is injected so the loop is
 * exercised without a real TTY, and the alternate screen, cursor, and raw mode
 * are always restored - including when a refresh throws. This is presentation
 * only; it derives nothing new.
 *
 * The loop owns the viewport: the report renders at whatever height its cards
 * need, and `scrollFrame` windows it onto the terminal's actual rows. Scroll
 * keys move that window, so a terminal too short for the whole report still
 * reaches every line instead of losing the top to the alternate screen. The
 * caller can add its own single-character keys; each runs its action and
 * repaints the current snapshot without refetching.
 */

import { scrollFrame, type ScrollStatus } from "./tui-viewport.js";

export type LiveTuiWriter = { write(chunk: string): unknown };

export type LiveTuiInput = {
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export type LiveTuiIo = {
  stdout: LiveTuiWriter;
  stdin: LiveTuiInput;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(handle: unknown): void;
  /** Current terminal height; absent or unknown means paint unwindowed. */
  rows?(): number | undefined;
  /** Current terminal width; absent or unknown means use logical rows. */
  columns?(): number | undefined;
  /** Subscribe to terminal resize; returns the unsubscribe function. */
  onResize?(listener: () => void): () => void;
  /** Subscribe to termination signals; returns the unsubscribe function. */
  onSignal?(listener: () => void): () => void;
};

export type LiveTuiOptions<T> = {
  /**
   * Refresh the report. Bounded by the caller, not by this loop. `trigger`
   * says why: the first frame, the interval elapsing, or the operator's `r`.
   */
  load(trigger: LoadTrigger): Promise<T>;
  /** Render the current snapshot at the current terminal width. */
  render(value: T): string;
  /** Closing line pinned to the last row when height permits. */
  status?(status: ScrollStatus): string;
  /**
   * Extra single-character keys. Each action runs, then the current snapshot
   * repaints without a refetch. A key the loop already owns (quit and scroll)
   * keeps its built-in meaning.
   */
  keys?: Readonly<Record<string, () => void>>;
  intervalMillis: number;
  io: LiveTuiIo;
};

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[H\x1b[2J";

type ScrollCommand = "up" | "down" | "page-up" | "page-down" | "top" | "bottom";

type LiveCommand = ScrollCommand | "quit" | "refresh";

/** Escape sequences, longest first so `\x1b[1~` never matches as `\x1b[1`. */
const ESCAPE_KEYS: ReadonlyArray<readonly [string, ScrollCommand]> = [
  ["\x1b[5~", "page-up"],
  ["\x1b[6~", "page-down"],
  ["\x1b[1~", "top"],
  ["\x1b[4~", "bottom"],
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[H", "top"],
  ["\x1bOH", "top"],
  ["\x1b[F", "bottom"],
  ["\x1bOF", "bottom"],
];

/** `q`, plus Ctrl+C and Ctrl+D, which raw mode delivers as data, not signals. */
const CHARACTER_KEYS: Readonly<Record<string, LiveCommand>> = {
  q: "quit",
  r: "refresh",
  Q: "quit",
  "\x03": "quit",
  "\x04": "quit",
  j: "down",
  k: "up",
  "\x05": "down",
  "\x19": "up",
  " ": "page-down",
  f: "page-down",
  b: "page-up",
  "\x06": "page-down",
  "\x02": "page-up",
  g: "top",
  G: "bottom",
};

type KeyCommand = LiveCommand | { action: string };

export type LoadTrigger = "start" | "tick" | "refresh";

type WakeReason = "tick" | "resize" | "scroll" | "key" | "refresh" | "quit";

/**
 * Run the live report until the operator quits, and return the last snapshot
 * that was painted so the caller can echo a final frame on the normal screen.
 */
export async function runLiveTui<T>({
  load,
  render,
  status,
  keys = {},
  intervalMillis,
  io,
}: LiveTuiOptions<T>): Promise<T | undefined> {
  let quit = false;
  let wake: ((reason: WakeReason) => void) | undefined;
  // Resize and scroll bursts coalesce: every wake-up repaints from the current
  // terminal size and scroll offset, so an event that lands with no waiter
  // armed is already covered by the next paint rather than needing its own.
  const notify = (reason: WakeReason): void => {
    const pending = wake;
    wake = undefined;
    pending?.(reason);
  };
  const requestQuit = (): void => {
    quit = true;
    notify("quit");
  };

  // Scroll state outlives each refresh, so a repaint keeps the operator where
  // they were. Commands are applied only while painting, against that paint's
  // current rows and frame bounds. In particular, input received while load()
  // is pending must not be clamped against stale pre-resize bounds.
  let offset = 0;
  const pendingScrollCommands: ScrollCommand[] = [];
  let refreshRequested = false;
  let pendingKeyInput = "";
  const onData = (chunk: Buffer | string): void => {
    const text = pendingKeyInput + chunk.toString();
    const parsed = parseKeys(text, keys);
    pendingKeyInput = parsed.remainder;
    let scrolled = false;
    let acted = false;
    for (const command of parsed.commands) {
      if (command === "quit") {
        requestQuit();
        return;
      }
      if (command === "refresh") {
        refreshRequested = true;
        notify("refresh");
        continue;
      }
      if (typeof command === "object") {
        keys[command.action]?.();
        acted = true;
        continue;
      }
      pendingScrollCommands.push(command);
      scrolled = true;
    }
    if (scrolled) notify("scroll");
    else if (acted) notify("key");
  };

  const stopResize = io.onResize?.(() => {
    notify("resize");
  });
  const stopSignal = io.onSignal?.(requestQuit);
  io.stdin.on("data", onData);
  io.stdin.setRawMode?.(true);
  io.stdin.resume?.();
  io.stdout.write(ENTER_SCREEN);

  let value: T | undefined;
  let trigger: LoadTrigger = "start";
  try {
    while (!quit) {
      if (value === undefined) io.stdout.write(`${CLEAR_SCREEN}\n  loading…\n`);
      value = await load(trigger);
      trigger = "tick";
      if (quit) break;
      const snapshot = value;
      const paint = (): void => {
        const body = render(snapshot);
        const options = {
          rows: io.rows?.(),
          columns: io.columns?.(),
          offset,
          ...(status === undefined ? {} : { status }),
        };
        let frame = scrollFrame(body, options);
        let nextOffset = frame.offset;
        for (const command of pendingScrollCommands) {
          const pageLines = Math.max(1, frame.pageLines);
          const step = {
            up: -1,
            down: 1,
            "page-up": -pageLines,
            "page-down": pageLines,
            top: -Infinity,
            bottom: Infinity,
          }[command];
          nextOffset = Math.min(
            Math.max(nextOffset + step, 0),
            frame.maxOffset,
          );
        }
        if (pendingScrollCommands.length > 0) {
          frame = scrollFrame(body, { ...options, offset: nextOffset });
          pendingScrollCommands.length = 0;
        }
        offset = frame.offset;
        // No trailing newline: a frame that exactly fills the terminal would
        // otherwise push its own first row off the alternate screen.
        io.stdout.write(`${CLEAR_SCREEN}${frame.text}`);
      };
      paint();
      if (refreshRequested) {
        refreshRequested = false;
        trigger = "refresh";
        continue;
      }

      let ticked = false;
      const handle = io.setTimer(() => {
        ticked = true;
        notify("tick");
      }, intervalMillis);
      try {
        while (!quit && !ticked) {
          const reason = await new Promise<WakeReason>((resolve) => {
            wake = resolve;
          });
          if (reason === "refresh" || refreshRequested) {
            refreshRequested = false;
            trigger = "refresh";
            break;
          }
          if (reason === "tick" || reason === "quit") break;
          paint();
          if (refreshRequested) {
            refreshRequested = false;
            trigger = "refresh";
            break;
          }
        }
      } finally {
        wake = undefined;
        io.clearTimer(handle);
      }
    }
  } finally {
    io.stdout.write(LEAVE_SCREEN);
    io.stdin.off("data", onData);
    io.stdin.setRawMode?.(false);
    io.stdin.pause?.();
    stopResize?.();
    stopSignal?.();
  }
  return value;
}

/** Decode raw-mode input into commands while retaining a split escape suffix. */
function parseKeys(
  text: string,
  actions: Readonly<Record<string, () => void>>,
): {
  commands: KeyCommand[];
  remainder: string;
} {
  const commands: KeyCommand[] = [];
  let index = 0;
  while (index < text.length) {
    const escape = ESCAPE_KEYS.find(([sequence]) =>
      text.startsWith(sequence, index),
    );
    if (escape) {
      commands.push(escape[1]);
      index += escape[0].length;
      continue;
    }
    const suffix = text.slice(index);
    if (
      suffix.startsWith("\x1b") &&
      ESCAPE_KEYS.some(([sequence]) => sequence.startsWith(suffix))
    ) {
      return { commands, remainder: suffix };
    }
    const character = text[index];
    const command = CHARACTER_KEYS[character];
    if (command) commands.push(command);
    else if (Object.hasOwn(actions, character)) {
      commands.push({ action: character });
    }
    index += 1;
  }
  return { commands, remainder: "" };
}

/** Render a whole-unit refresh interval as "45s", "5m", or "2h". */
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
