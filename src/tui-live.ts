/**
 * Live loop for the human terminal report: paint a frame, then repaint on a
 * fixed refresh interval until the operator quits with `q` or Ctrl+C. Every
 * terminal effect is injected so the loop is exercised without a real TTY, and
 * the alternate screen, cursor, and raw mode are always restored - including
 * when a refresh throws. This is presentation only; it derives nothing new.
 */

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
  /** Subscribe to terminal resize; returns the unsubscribe function. */
  onResize?(listener: () => void): () => void;
  /** Subscribe to termination signals; returns the unsubscribe function. */
  onSignal?(listener: () => void): () => void;
};

export type LiveTuiOptions<T> = {
  /** Refresh the report. Bounded by the caller, not by this loop. */
  load(): Promise<T>;
  /** Render the current snapshot at the current terminal width. */
  render(value: T): string;
  intervalMillis: number;
  io: LiveTuiIo;
};

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[H\x1b[2J";
/** `q`, plus Ctrl+C and Ctrl+D, which raw mode delivers as data, not signals. */
// eslint-disable-next-line no-control-regex
const QUIT_KEY_PATTERN = /[qQ\x03\x04]/;

type WakeReason = "tick" | "resize" | "quit";

/**
 * Run the live report until the operator quits, and return the last snapshot
 * that was painted so the caller can echo a final frame on the normal screen.
 */
export async function runLiveTui<T>({
  load,
  render,
  intervalMillis,
  io,
}: LiveTuiOptions<T>): Promise<T | undefined> {
  let quit = false;
  let wake: ((reason: WakeReason) => void) | undefined;
  // Resize bursts coalesce: every wake-up repaints at the current terminal
  // width, so an event that lands with no waiter armed is already covered by
  // the next paint rather than needing its own frame.
  const notify = (reason: WakeReason): void => {
    const pending = wake;
    wake = undefined;
    pending?.(reason);
  };
  const requestQuit = (): void => {
    quit = true;
    notify("quit");
  };
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (QUIT_KEY_PATTERN.test(text)) requestQuit();
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
  try {
    while (!quit) {
      if (value === undefined) io.stdout.write(`${CLEAR_SCREEN}\n  loading…\n`);
      value = await load();
      if (quit) break;
      const snapshot = value;
      const paint = (): void => {
        io.stdout.write(`${CLEAR_SCREEN}${render(snapshot)}\n`);
      };
      paint();

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
          if (reason !== "resize") break;
          paint();
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

/** Render a whole-unit refresh interval as "45s", "5m", or "2h". */
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
