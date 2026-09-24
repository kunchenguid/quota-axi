import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Single-flight for vendor reads when fresh reuse is on. Processes that start
 * together on a cold cache would each miss the cache and ask the vendor; the
 * one that creates the lock file reads the vendor and caches the result, and
 * the rest wait for that reading instead.
 *
 * The lock only saves vendor calls. Every reading a waiter serves still passes
 * the cache's own reuse checks, so a lost race, a lock taken over twice, or a
 * wait that times out costs at most an extra vendor read, never a wrong one.
 */

export type FetchLock = { release(): void };

export type FetchTurn<T> =
  /** Another process's reading arrived; serve it. */
  | { kind: "answered"; value: T }
  /** This process holds the lock: read the vendor, cache, then release. */
  | { kind: "leader"; lock: FetchLock }
  /**
   * No reading within the wait, the holder released without a reusable one,
   * or no lock directory: read the vendor.
   */
  | { kind: "unlocked" };

export type FetchTurnOptions = {
  waitMs?: number;
  pollMs?: number;
  staleMs?: number;
};

/**
 * Long enough to cover a vendor request's own 15 s timeout plus process
 * start-up, short enough that a wedged holder only delays a waiter once.
 */
const WAIT_MS = 30_000;
const POLL_MS = 100;
/**
 * A lock older than this is abandoned even when its holder looks alive: the
 * holder's pid may have been reused, or it runs on another host sharing the
 * cache directory. Longer than any single read, including a Keychain prompt.
 */
const STALE_MS = 120_000;
/** A synchronous holder only rewrites one file, so it blocks briefly */
const SYNC_WAIT_MS = 5_000;
const SYNC_POLL_MS = 10;

type Holder = { pid: number; host: string; token: string };

/**
 * Take a turn at reading the vendor for the lock at `path`. `answer` is the
 * cache lookup that serves a reading another process has just written; it is
 * consulted again right after acquiring, because the previous holder may have
 * cached a reading between this process's first lookup and its acquisition.
 */
export async function takeFetchTurn<T>(
  path: string,
  answer: () => T | undefined,
  {
    waitMs = WAIT_MS,
    pollMs = POLL_MS,
    staleMs = STALE_MS,
  }: FetchTurnOptions = {},
): Promise<FetchTurn<T>> {
  // Monotonic, so a wall-clock jump (or a test's fake Date) cannot stall it
  const deadline = performance.now() + waitMs;
  let waited = false;
  for (;;) {
    const lock = tryLock(path);
    if (lock === "unavailable") return { kind: "unlocked" };
    if (lock) {
      const value = answer();
      if (value !== undefined) {
        lock.release();
        return { kind: "answered", value };
      }
      if (!waited) return { kind: "leader", lock };
      // The holder's reading was not reusable, so another turn would only
      // queue the waiters behind the same unanswerable read one at a time
      lock.release();
      return { kind: "unlocked" };
    }
    waited = true;
    const value = answer();
    if (value !== undefined) return { kind: "answered", value };
    if (performance.now() >= deadline) return { kind: "unlocked" };
    const state = settleHolder(path, staleMs);
    // A crashed or wedged holder answered nothing, so the taker leads
    if (state === "abandoned") waited = false;
    if (state === "held") await sleep(pollMs);
  }
}

/**
 * Run `fn` while holding the lock at `path`, for a critical section as short
 * as a file's read-modify-write. It waits synchronously and takes over an
 * abandoned lock as `takeFetchTurn` does; when the wait runs out, or no lock
 * can be taken here, `fn` runs unlocked.
 */
export function withLockSync<T>(
  path: string,
  fn: () => T,
  {
    waitMs = SYNC_WAIT_MS,
    pollMs = SYNC_POLL_MS,
    staleMs = STALE_MS,
  }: FetchTurnOptions = {},
): T {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const lock = tryLock(path);
    if (lock === "unavailable") return fn();
    if (lock) {
      try {
        return fn();
      } finally {
        lock.release();
      }
    }
    if (performance.now() >= deadline) return fn();
    if (settleHolder(path, staleMs) === "held") sleepSync(pollMs);
  }
}

/** The lock file for one provider under one credential selection. */
export function fetchLockPath(cacheDir: string, key: string): string {
  return join(cacheDir, "locks", `fetch-${key}.lock`);
}

/**
 * Create the lock file exclusively. `O_EXCL` creation is atomic on every
 * platform Node supports, so exactly one process wins. `undefined` means
 * another process holds it; `"unavailable"` means no lock can be taken here.
 */
function tryLock(path: string): FetchLock | "unavailable" | undefined {
  const token = randomUUID();
  let fd: number;
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    return errorCode(error) === "EEXIST" ? undefined : "unavailable";
  }
  try {
    const holder: Holder = { pid: process.pid, host: hostname(), token };
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  return { release: () => removeIfHeldBy(path, token) };
}

function readHolder(path: string): Holder | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>;
    return typeof data.pid === "number" &&
      typeof data.host === "string" &&
      typeof data.token === "string"
      ? { pid: data.pid, host: data.host, token: data.token }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lock's holder state after one wait step, with an abandoned lock
 * already removed so the next attempt can take it.
 */
function settleHolder(
  path: string,
  staleMs: number,
): "released" | "abandoned" | "held" {
  const holder = readHolder(path);
  const state = holderState(path, holder, staleMs);
  if (state === "abandoned") removeIfHeldBy(path, holder?.token);
  return state;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether the holder released the lock, crashed or wedged, or still holds it.
 * A lock whose contents are not yet written is only its creator between two
 * syscalls, so it is judged by age.
 */
function holderState(
  path: string,
  holder: Holder | undefined,
  staleMs: number,
): "released" | "abandoned" | "held" {
  let modifiedAt: number;
  try {
    modifiedAt = statSync(path).mtimeMs;
  } catch {
    return "released";
  }
  if (Math.abs(Date.now() - modifiedAt) > staleMs) return "abandoned";
  if (!holder || holder.host !== hostname()) return "held";
  // This process never waits on a lock it holds, so its own pid is a leftover
  return holder.pid === process.pid || !processAlive(holder.pid)
    ? "abandoned"
    : "held";
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by another user
    return errorCode(error) === "EPERM";
  }
}

/**
 * Remove the lock only while it still carries `token`. The read and unlink
 * are not atomic, so two processes taking over one abandoned lock can both
 * proceed; that costs one extra vendor read and nothing else.
 */
function removeIfHeldBy(path: string, token: string | undefined): void {
  try {
    if (readHolder(path)?.token !== token) return;
    unlinkSync(path);
  } catch {
    return;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
