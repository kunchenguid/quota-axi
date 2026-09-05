import { spawn, type ChildProcess } from "node:child_process";
import { findCommandPath } from "../lib/process.js";
import type { SourceAttempt } from "../types.js";

/**
 * Delegated credential refresh.
 *
 * quota-axi never mints or rotates an OAuth credential itself, and never
 * performs a refresh-token exchange over HTTP. The reason is empirical: the
 * refresh tokens behind these stores rotate on use. Refreshing `~/.codex/auth.json`
 * out of band was observed to replace both the access token and the refresh
 * token, which would leave the vendor's own copy holding a spent refresh token
 * and force the user to sign in again. A quota reader must never be able to
 * sign a user out of the harness it is measuring.
 *
 * So only when the same stored access token is expired, has a refresh token
 * beside it, and is empirically rejected, quota-axi runs the vendor's own
 * smallest non-interactive command - the one that already owns rotation and
 * already owns the credential store - and then re-reads the refreshed access
 * token from the store the vendor just rewrote. quota-axi
 * reads the result; the vendor performs the rotation.
 *
 * The delegate contract, enforced here:
 *
 * - fixed argv resolved through `PATH` (or an absolute provider override).
 *   Delegates are declared in code, never assembled from provider responses,
 *   configuration, or user input, and never run through a shell. Deliberately
 *   shell-free resolution means a PATH-resolved Windows `.cmd` or `.bat` shim
 *   cannot run; that delegated attempt fails and the provider falls back to
 *   its existing read-only report and advice. The no-shell guarantee is never
 *   weakened to work around this accepted platform degradation.
 * - no interactive surface: the child gets no stdin (so a vendor TUI or prompt
 *   exits instead of waiting), `TERM=dumb`, and the vendor's own documented
 *   "do not open a browser" environment variables.
 * - a bounded wall-clock budget that quota-axi waits out but never enforces
 *   with a signal. The delegated command is the vendor performing a single-use
 *   OAuth refresh-token exchange against its own credential store; killing it
 *   part way through can leave that store holding a spent token, which is the
 *   very sign-out this whole design exists to avoid. So the budget bounds how
 *   long quota-axi waits, not how long the vendor may run: on expiry quota-axi
 *   detaches and reports the refresh as unconfirmed, and the caller falls back
 *   to a read-only report rather than pretending the run either succeeded or
 *   definitively failed. The child is spawned in its own process group for the
 *   same reason, so a Ctrl+C aimed at quota-axi (a live `--tui`, most of all)
 *   cannot land on a vendor mid-exchange either.
 * - the child's output is discarded at the operating system, not read.
 *   Credentials are never parsed out of vendor output; the refreshed value only
 *   ever comes from re-reading the vendor's own store. Owning no pipe also
 *   means a detached vendor can never block on one quota-axi stopped draining.
 * - at most one delegated refresh per credential source per quota read, which
 *   each caller enforces by delegating only on its single recovery path. It is
 *   deliberately per read rather than per process, so a long-running `--tui`
 *   still recovers from a session that expires while it is up.
 *
 * Only providers whose vendor CLI has an established non-interactive rotation
 * command get a delegate. Providers without one stay read-only and keep their
 * existing honest advice.
 */

export type RefreshDelegate = {
  /** Attempt name recorded in `attempts` and `sourcesTried`. */
  source: string;
  /** Bare command resolved through `PATH`, or an absolute executable path. */
  command: string;
  /** Fixed non-interactive argv. Never built from untrusted input. */
  args: readonly string[];
  /** Wall-clock budget for how long quota-axi waits for the delegated run. */
  waitBudgetMs: number;
  /** Extra environment forced onto the child, merged last. */
  env?: Readonly<Record<string, string>>;
};

export type DelegatedRefreshRun =
  /** The vendor command completed; `exitCode` is diagnostic, not a verdict. */
  | { status: "ran"; exitCode: number | null }
  /** The vendor CLI is not installed, so there is nothing to delegate to. */
  | { status: "unavailable"; error: string }
  /** The command could not be started. */
  | { status: "failed"; error: string }
  /**
   * The vendor outran quota-axi's wait and was left running. Nothing is known
   * about the store it owns: it may have been rewritten, may be mid-exchange,
   * or may never finish. Callers must not read this as success or as a
   * definitive credential verdict.
   */
  | { status: "unconfirmed"; error: string };

export const REFRESH_COMMAND_NOT_FOUND = "refresh_command_not_found";
export const REFRESH_SPAWN_FAILED = "refresh_spawn_failed";
export const REFRESH_TIMED_OUT = "refresh_timed_out";
export const REFRESH_EXIT_STATUS = "refresh_exit_status";
/** A live vendor process already owns refreshing its own credential store. */
export const REFRESH_LIVE_VENDOR_PROCESS = "refresh_live_vendor_process";
/** quota-axi could not tell whether the vendor is already running. */
export const REFRESH_VENDOR_UNKNOWN = "refresh_vendor_processes_unknown";

/**
 * Environment forced onto every delegated run. `NO_COLOR` and `TERM=dumb` keep
 * vendor output plain, and the remaining entries are the vendors' own opt-outs
 * for opening a browser. Combined with a closed stdin this keeps the delegated
 * command to a non-interactive rotation, never a sign-in flow.
 */
const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  TERM: "dumb",
  NO_BROWSER: "1",
  NO_OPEN_BROWSER: "1",
};

export async function runRefreshDelegate(
  delegate: RefreshDelegate,
): Promise<DelegatedRefreshRun> {
  const executable = await findCommandPath(delegate.command);
  if (!executable) {
    return { status: "unavailable", error: REFRESH_COMMAND_NOT_FOUND };
  }
  return new Promise<DelegatedRefreshRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...delegate.args], {
        // No stdin: a vendor command that would prompt exits instead of hanging.
        // No pipes either: vendor output is never a credential source, and a
        // child quota-axi has stopped waiting for must not block writing to a
        // pipe nobody drains.
        stdio: ["ignore", "ignore", "ignore"],
        // Its own process group, so a signal sent to quota-axi's group - the
        // Ctrl+C that quits a live `--tui` - cannot interrupt a token exchange.
        detached: true,
        env: { ...process.env, ...NON_INTERACTIVE_ENV, ...delegate.env },
      });
    } catch {
      resolve({ status: "failed", error: REFRESH_SPAWN_FAILED });
      return;
    }

    let settled = false;
    const settle = (run: DelegatedRefreshRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      // Deliberately no signal. The vendor may be part way through a
      // single-use refresh-token exchange, and quota-axi is a reader: it stops
      // waiting and lets the process that owns the store finish on its own.
      child.unref();
      settle({ status: "unconfirmed", error: REFRESH_TIMED_OUT });
    }, delegate.waitBudgetMs);

    child.on("error", () =>
      settle({ status: "failed", error: REFRESH_SPAWN_FAILED }),
    );
    child.on("close", (exitCode) => settle({ status: "ran", exitCode }));
  });
}

/**
 * Run a delegate and re-read the vendor store it owns.
 *
 * The re-read happens whenever the command actually ran, including on a
 * non-zero exit: a vendor CLI can rotate its token and still exit non-zero for
 * an unrelated reason, and the re-read plus the caller's own retry is what
 * decides the outcome. The attempt record stays diagnostic.
 */
export async function delegateCredentialRefresh<S>(args: {
  delegate: RefreshDelegate;
  reread: () => S | Promise<S>;
}): Promise<{ attempt: SourceAttempt; state?: S }> {
  const run = await runRefreshDelegate(args.delegate);
  const attempt = refreshDelegateAttempt(args.delegate, run);
  if (run.status !== "ran") return { attempt };
  return { attempt, state: await args.reread() };
}

export function refreshDelegateAttempt(
  delegate: RefreshDelegate,
  run: DelegatedRefreshRun,
): SourceAttempt {
  if (run.status === "unavailable") {
    return { source: delegate.source, status: "skipped", error: run.error };
  }
  if (run.status === "failed" || run.status === "unconfirmed") {
    return {
      source: delegate.source,
      status: "failed",
      error: run.error,
      degraded: false,
    };
  }
  if (run.exitCode === 0) return { source: delegate.source, status: "success" };
  return {
    source: delegate.source,
    status: "failed",
    error: REFRESH_EXIT_STATUS,
    degraded: false,
  };
}
