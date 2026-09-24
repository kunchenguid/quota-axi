import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

/**
 * The local files one provider reading was derived from. Fresh reuse serves a
 * cached reading only while every one of them is unchanged, so a login that
 * rewrites a credential store or a configuration that now names another
 * deployment is read again instead of answering with the previous account.
 *
 * Only files quota-axi opens itself are traced. A store read through a vendor
 * tool (the macOS Keychain, Cursor's SQLite database, a vendor CLI) is
 * identified by the environment selection that names it, exactly as the
 * stale-cache credential context identifies it.
 */
const trace = new AsyncLocalStorage<Map<string, string>>();

export type TracedInputs = {
  /** Every traced path, sorted. */
  paths: string[];
  /** {@link inputsDigest} of those paths as they were when last read. */
  digest: string;
};

/**
 * Record that the current reading is about to consult `path`, present or not.
 * Its state is captured now, before the read, so a store rewritten while the
 * reading is still in flight can never be vouched for by that reading.
 */
export function traceInput(path: string): void {
  trace.getStore()?.set(path, inputState(path));
}

/** Run `read` and return what it produced plus every input it traced. */
export async function withInputTrace<T>(
  read: () => Promise<T>,
): Promise<{ value: T; inputs: TracedInputs }> {
  const states = new Map<string, string>();
  const value = await trace.run(states, read);
  const paths = [...states.keys()].sort();
  return {
    value,
    inputs: {
      paths,
      digest: digestStates(paths.map((path) => states.get(path) as string)),
    },
  };
}

/**
 * A one-way digest of the current state of `paths`: identity, size, and
 * modification times, or absence. Contents are never read, so a credential
 * file's bytes never enter it.
 */
export function inputsDigest(paths: readonly string[]): string {
  return digestStates(paths.map(inputState));
}

function digestStates(states: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["inputs-v1", states]))
    .digest("hex");
}

function inputState(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return [
      path,
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(":");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unreadable";
    return `${path}:${code}`;
  }
}
