import { describe, expect, it } from "vitest";
import { formatInterval, runLiveTui, type LiveTuiIo } from "../src/tui-live.js";

const ENTER_SCREEN = "\x1b[?1049h";
const LEAVE_SCREEN = "\x1b[?1049l";

type Harness = {
  io: LiveTuiIo;
  writes: string[];
  output(): string;
  rawModes: boolean[];
  resumes(): number;
  pauses(): number;
  subscriptions(): number;
  pendingTimers(): number;
  press(key: string): void;
  resize(): void;
  signal(): void;
  tick(): void;
};

function harness(): Harness {
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  const dataListeners = new Set<(chunk: Buffer | string) => void>();
  const resizeListeners = new Set<() => void>();
  const signalListeners = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let resumes = 0;
  let pauses = 0;

  const io: LiveTuiIo = {
    stdout: {
      write: (chunk) => {
        writes.push(chunk);
        return true;
      },
    },
    stdin: {
      setRawMode: (mode) => rawModes.push(mode),
      resume: () => {
        resumes += 1;
      },
      pause: () => {
        pauses += 1;
      },
      on: (_event, listener) => dataListeners.add(listener),
      off: (_event, listener) => dataListeners.delete(listener),
    },
    setTimer: (callback) => {
      const handle = nextTimer++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    onResize: (listener) => {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    onSignal: (listener) => {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    },
  };

  return {
    io,
    writes,
    output: () => writes.join(""),
    rawModes,
    resumes: () => resumes,
    pauses: () => pauses,
    subscriptions: () =>
      dataListeners.size + resizeListeners.size + signalListeners.size,
    pendingTimers: () => timers.size,
    press: (key) => {
      for (const listener of [...dataListeners]) listener(Buffer.from(key));
    },
    resize: () => {
      for (const listener of [...resizeListeners]) listener();
    },
    signal: () => {
      for (const listener of [...signalListeners]) listener();
    },
    tick: () => {
      const [handle, callback] = [...timers.entries()].at(-1) ?? [];
      if (handle === undefined || !callback) throw new Error("no timer armed");
      timers.delete(handle);
      callback();
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function counting(): { load: () => Promise<number>; calls: () => number } {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      return calls;
    },
    calls: () => calls,
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("live terminal report loop", () => {
  it("paints a frame per refresh and quits on q with the last snapshot", async () => {
    const io = harness();
    const source = counting();

    const run = runLiveTui<number>({
      load: source.load,
      render: (value) => `frame ${value}`,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();

    expect(io.writes[0]).toContain(ENTER_SCREEN);
    expect(io.output()).toContain("frame 1");
    expect(io.rawModes).toEqual([true]);
    expect(io.resumes()).toBe(1);

    io.tick();
    await flush();
    expect(io.output()).toContain("frame 2");
    expect(source.calls()).toBe(2);

    io.press("q");
    await expect(run).resolves.toBe(2);
    expect(io.writes.at(-1)).toContain(LEAVE_SCREEN);
    expect(io.rawModes).toEqual([true, false]);
    expect(io.pauses()).toBe(1);
    expect(io.subscriptions()).toBe(0);
    expect(io.pendingTimers()).toBe(0);
  });

  it("repaints on resize without refetching or resetting the interval", async () => {
    const io = harness();
    const source = counting();

    const run = runLiveTui<number>({
      load: source.load,
      render: (value) => `frame ${value}`,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();
    const armed = io.pendingTimers();

    io.resize();
    await flush();
    expect(occurrences(io.output(), "frame 1")).toBe(2);

    // A burst within one tick coalesces into a single correctly sized frame.
    io.resize();
    io.resize();
    await flush();
    expect(occurrences(io.output(), "frame 1")).toBe(3);

    expect(source.calls()).toBe(1);
    expect(io.pendingTimers()).toBe(armed);

    io.press("q");
    await run;
  });

  it("quits on the raw-mode Ctrl+C byte and on a termination signal", async () => {
    for (const quit of [
      (io: Harness) => io.press(String.fromCharCode(3)),
      (io: Harness) => io.signal(),
    ]) {
      const io = harness();
      const run = runLiveTui<number>({
        load: counting().load,
        render: () => "frame",
        intervalMillis: 300_000,
        io: io.io,
      });
      await flush();

      quit(io);
      await expect(run).resolves.toBe(1);
      expect(io.writes.at(-1)).toContain(LEAVE_SCREEN);
      expect(io.subscriptions()).toBe(0);
    }
  });

  it("skips the frame when a quit lands while a refresh is in flight", async () => {
    const io = harness();
    let release: (() => void) | undefined;
    const run = runLiveTui<string>({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "loaded";
      },
      render: () => "frame",
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();

    io.press("q");
    release?.();

    await expect(run).resolves.toBe("loaded");
    expect(io.output()).not.toContain("frame");
    expect(io.writes.at(-1)).toContain(LEAVE_SCREEN);
    expect(io.rawModes).toEqual([true, false]);
  });

  it("restores the terminal when a refresh throws", async () => {
    const io = harness();

    await expect(
      runLiveTui<number>({
        load: async () => {
          throw new Error("provider exploded");
        },
        render: () => "frame",
        intervalMillis: 300_000,
        io: io.io,
      }),
    ).rejects.toThrow("provider exploded");

    expect(io.writes.at(-1)).toContain(LEAVE_SCREEN);
    expect(io.rawModes).toEqual([true, false]);
    expect(io.pauses()).toBe(1);
    expect(io.subscriptions()).toBe(0);
  });
});

describe("refresh interval formatting", () => {
  it("renders whole units", () => {
    expect(formatInterval(45)).toBe("45s");
    expect(formatInterval(90)).toBe("90s");
    expect(formatInterval(300)).toBe("5m");
    expect(formatInterval(3600)).toBe("1h");
    expect(formatInterval(7200)).toBe("2h");
  });
});
