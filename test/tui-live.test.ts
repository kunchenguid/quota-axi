import { describe, expect, it } from "vitest";
import { formatInterval, runLiveTui, type LiveTuiIo } from "../src/tui-live.js";
import { renderTuiHintLine } from "../src/tui.js";
import { scrollFrame, scrollHint } from "../src/tui-viewport.js";

const ENTER_SCREEN = "\x1b[?1049h";
const LEAVE_SCREEN = "\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[H\x1b[2J";
const HINT = "Press r to refresh · q to quit · refreshing every 5m";

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
  setRows(rows: number | undefined): void;
  resize(rows?: number): void;
  frame(): string;
  physicalRows(columns: number): number;
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
  let rows: number | undefined;

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
    rows: () => rows,
    columns: () => 80,
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
    setRows: (next) => {
      rows = next;
    },
    resize: (next) => {
      if (next !== undefined) rows = next;
      for (const listener of [...resizeListeners]) listener();
    },
    frame: () => {
      const painted = [...writes]
        .reverse()
        .find((chunk) => chunk.startsWith(CLEAR_SCREEN));
      return (painted ?? "").slice(CLEAR_SCREEN.length);
    },
    physicalRows: (columns) =>
      terminalRows(
        [...writes]
          .reverse()
          .find((chunk) => chunk.startsWith(CLEAR_SCREEN))
          ?.slice(CLEAR_SCREEN.length) ?? "",
        columns,
      ),
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

function terminalRows(text: string, columns: number): number {
  let rows = 1;
  let column = 0;
  let wrapPending = false;
  for (const character of text) {
    if (character === "\n") {
      rows += 1;
      column = 0;
      wrapPending = false;
      continue;
    }
    if (wrapPending) {
      rows += 1;
      column = 0;
      wrapPending = false;
    }
    column += 1;
    if (column === columns) wrapPending = true;
  }
  return rows;
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

  it("refreshes immediately on r", async () => {
    const io = harness();
    const source = counting();

    const run = runLiveTui<number>({
      load: source.load,
      render: (value) => `frame ${value}`,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();

    io.press("r");
    await flush();
    expect(source.calls()).toBe(2);
    expect(io.frame()).toBe("frame 2");
    expect(io.pendingTimers()).toBe(1);

    io.press("q");
    await run;
  });

  it("refreshes immediately after a pending scroll repaint", async () => {
    const io = harness();
    const source = counting();

    const run = runLiveTui<number>({
      load: source.load,
      render: (value) => `frame ${value}`,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();

    io.press("j");
    io.press("r");
    await flush();
    expect(source.calls()).toBe(2);
    expect(io.frame()).toBe("frame 2");

    io.press("q");
    await run;
  });

  it("keeps an r pressed while a refresh is in flight and reads again after the paint", async () => {
    const io = harness();
    let calls = 0;
    const releases: Array<() => void> = [];
    const run = runLiveTui<number>({
      load: async () => {
        calls += 1;
        const call = calls;
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return call;
      },
      render: (value) => `frame ${value}`,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();
    expect(calls).toBe(1);

    io.press("r");
    await flush();
    expect(calls).toBe(1);

    releases[0]?.();
    await flush();
    expect(io.output()).toContain("frame 1");
    expect(calls).toBe(2);

    releases[1]?.();
    await flush();
    expect(io.frame()).toBe("frame 2");
    expect(calls).toBe(2);
    expect(io.pendingTimers()).toBe(1);

    io.press("q");
    await expect(run).resolves.toBe(2);
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

  it("runs a caller key's action and repaints without refetching", async () => {
    const io = harness();
    const source = counting();
    let expanded = false;
    const pressed: string[] = [];

    const run = runLiveTui<number>({
      load: source.load,
      render: (value) => `frame ${value} ${expanded ? "open" : "folded"}`,
      keys: {
        a: () => {
          expanded = !expanded;
          pressed.push("a");
        },
        q: () => pressed.push("q"),
      },
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();
    const armed = io.pendingTimers();
    expect(io.frame()).toBe("frame 1 folded");

    io.press("a");
    await flush();
    expect(io.frame()).toBe("frame 1 open");
    io.press("za");
    await flush();
    expect(io.frame()).toBe("frame 1 folded");
    expect(source.calls()).toBe(1);
    expect(io.pendingTimers()).toBe(armed);

    // A key the loop owns keeps its meaning.
    io.press("q");
    await expect(run).resolves.toBe(1);
    expect(pressed).toEqual(["a", "a"]);
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

describe("live terminal report at short heights", () => {
  const BODY = Array.from({ length: 40 }, (_, index) => `line ${index}`).join(
    "\n",
  );

  type Live = { io: Harness; run: Promise<unknown> };

  async function start(rows: number | undefined): Promise<Live> {
    const io = harness();
    io.setRows(rows);
    const run = runLiveTui<number>({
      load: async () => 1,
      render: () => BODY,
      status: (scroll) => `  ${scrollHint(scroll, HINT)}`,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();
    return { io, run };
  }

  async function press(live: Live, ...keys: string[]): Promise<string[]> {
    for (const key of keys) live.io.press(key);
    await flush();
    return live.io.frame().split("\n");
  }

  async function stop(live: Live): Promise<void> {
    live.io.press("q");
    await live.run;
  }

  it("does not scroll a frame away when it exactly fills the terminal", async () => {
    const io = harness();
    io.setRows(4);
    const body = "line 0\r\nline 1\r\nline 2\r\n";
    const run = runLiveTui<number>({
      load: async () => 1,
      render: () => body,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();

    const expected = body.replace(/\r\n$/, "").replaceAll("\r\n", "\n");
    expect(io.frame()).toBe(expected);
    expect(io.writes.at(-1)).toBe(`${CLEAR_SCREEN}${expected}`);
    expect(io.writes.at(-1)).not.toMatch(/\n$/);
    await stop({ io, run });
  });

  it("keeps a full-width first visible line and hint within the height budget", async () => {
    const io = harness();
    io.setRows(3);
    const fullWidthLine = "x".repeat(80);
    const body = `header\n${fullWidthLine}\nline 2\nline 3`;
    const run = runLiveTui<number>({
      load: async () => 1,
      render: () => body,
      status: (scroll) =>
        renderTuiHintLine(scrollHint(scroll, HINT), {
          columns: 80,
          colorDepth: "none",
        }),
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();

    io.press("j");
    await flush();

    const lines = io.frame().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(fullWidthLine);
    expect(lines[1]).toBe("line 2");
    expect(lines[2]).toContain("q quit");
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(io.physicalRows(80)).toBe(3);
    await stop({ io, run });
  });

  it("resets ANSI styling when truncating an oversized line", () => {
    const frame = scrollFrame(`\x1b[0;31m${"x".repeat(160)}\x1b[0m`, {
      rows: 1,
      columns: 80,
    });

    expect(frame.text).toBe(`\x1b[0;31m${"x".repeat(80)}\x1b[0m`);
  });

  it("paints the top of the report and an affordance at startup", async () => {
    const live = await start(10);
    const lines = live.io.frame().split("\n");

    expect(lines.length).toBe(10);
    expect(lines[0]).toBe("line 0");
    expect(lines[1]).toBe("line 1");
    expect(lines.at(-1)).toContain("↓ 31 more");
    expect(lines.at(-1)).toContain("j/k PgUp/PgDn g/G scroll");
    expect(lines.at(-1)).toContain("q quit");
    await stop(live);
  });

  it("scrolls line by line and clamps at the top", async () => {
    const live = await start(10);

    expect((await press(live, "j"))[1]).toBe("line 2");
    expect((await press(live, "j"))[1]).toBe("line 3");
    expect((await press(live, "k"))[1]).toBe("line 2");

    const clamped = await press(live, "k", "k", "k", "k", "k");
    expect(clamped[1]).toBe("line 1");
    expect(clamped.at(-1)).not.toContain("↑");
    await stop(live);
  });

  it("reaches the last line of the report and clamps at the bottom", async () => {
    const live = await start(10);

    const bottom = await press(live, "G");
    expect(bottom.at(-2)).toBe("line 39");
    expect(bottom.at(-1)).toContain("↑ 31 more");
    expect(bottom.at(-1)).not.toContain("↓");

    expect(await press(live, "j", "j", "j")).toEqual(bottom);
    expect((await press(live, "g"))[1]).toBe("line 1");
    await stop(live);
  });

  it("steps by the visible window on the page keys", async () => {
    const live = await start(12);
    const page = 10;

    expect((await press(live, "\x1b[6~"))[1]).toBe(`line ${1 + page}`);
    expect((await press(live, "\x1b[6~"))[1]).toBe(`line ${1 + page * 2}`);
    expect((await press(live, "\x1b[5~"))[1]).toBe(`line ${1 + page}`);
    await stop(live);
  });

  it("accepts arrow keys as well as the vi keys", async () => {
    const live = await start(10);

    expect((await press(live, "\x1b[B"))[1]).toBe("line 2");
    expect((await press(live, "\x1b[B"))[1]).toBe("line 3");
    expect((await press(live, "\x1b[A"))[1]).toBe("line 2");
    expect((await press(live, "\x1b[F")).at(-2)).toBe("line 39");
    expect((await press(live, "\x1b[H"))[1]).toBe("line 1");
    await stop(live);
  });

  it("accepts escape keys split across input chunks", async () => {
    const live = await start(10);

    expect((await press(live, "\x1b", "[", "B"))[1]).toBe("line 2");
    expect((await press(live, "\x1b[6", "~"))[1]).toBe("line 10");
    await stop(live);
  });

  it("windows on shrink and restores the whole report on growth", async () => {
    const live = await start(60);
    expect(live.io.frame()).toBe(`${BODY}\n\n  ${HINT}`);

    live.io.resize(12);
    await flush();
    const short = live.io.frame().split("\n");
    expect(short.length).toBe(12);
    expect(short.at(-1)).toContain("↓");

    await press(live, "G");
    live.io.resize(60);
    await flush();
    expect(live.io.frame()).toBe(`${BODY}\n\n  ${HINT}`);
    await stop(live);
  });

  it("keeps the scroll position across a refresh", async () => {
    const live = await start(10);
    await press(live, "j", "j", "j");

    live.io.tick();
    await flush();
    expect(live.io.frame().split("\n")[1]).toBe("line 4");
    await stop(live);
  });

  it("applies scroll input to fresh bounds after a resize during refresh", async () => {
    const io = harness();
    io.setRows(60);
    let calls = 0;
    let releaseRefresh: (() => void) | undefined;
    const run = runLiveTui<number>({
      load: async () => {
        calls += 1;
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
        }
        return calls;
      },
      render: () => BODY,
      status: (scroll) => `  ${scrollHint(scroll, HINT)}`,
      intervalMillis: 300_000,
      io: io.io,
    });
    await flush();
    expect(io.frame()).toBe(`${BODY}\n\n  ${HINT}`);

    io.tick();
    await flush();
    io.resize(10);
    io.press("G");
    releaseRefresh?.();
    await flush();

    const frame = io.frame().split("\n");
    expect(frame).toHaveLength(10);
    expect(frame.at(-2)).toBe("line 39");
    expect(frame.at(-1)).toContain("↑ 31 more");

    io.press("q");
    await run;
  });

  it("paints the report unwindowed when the height is unknown", async () => {
    const live = await start(undefined);
    expect(live.io.frame()).toBe(`${BODY}\n\n  ${HINT}`);
    expect(await press(live, "j")).toEqual(live.io.frame().split("\n"));
    await stop(live);
  });

  it("still quits on q and Ctrl+C while scrolled", async () => {
    const live = await start(8);
    await press(live, "G");
    live.io.press(String.fromCharCode(3));
    await expect(live.run).resolves.toBe(1);
    expect(live.io.writes.at(-1)).toContain(LEAVE_SCREEN);
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
