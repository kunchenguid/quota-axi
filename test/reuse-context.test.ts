import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQuota } from "../src/commands.js";
import {
  CREDENTIAL_SELECTION_ENV,
  reuseContextId,
} from "../src/lib/reuse-context.js";
import { PROVIDER_IDS } from "../src/types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = () => {
    throw new Error("no vendor process may start in this test");
  };
  return { ...actual, spawn: refuse, execFile: refuse };
});

/**
 * Environment variables that never choose which credential, profile, store,
 * or deployment a provider reads, so fresh reuse ignores them.
 */
const NOT_SELECTING = new Set([
  // Executable lookup; the store a CLI opens is chosen by its own variables
  "PATH",
  // Proxy routing for the same request to the same vendor
  "ALL_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  // quota-axi's own cache location, which already separates the cache itself
  "XDG_CACHE_HOME",
  // Names a snapshot file that answers instead of every provider
  "QUOTA_AXI_SNAPSHOT",
]);

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const environment = process.env;

afterEach(() => {
  process.env = environment;
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * Every environment variable name a full read of every provider consults on
 * `os`, against an empty synthetic home where every vendor refuses the
 * request. Windows variable names are case-insensitive, so they are compared
 * in upper case there.
 */
async function environmentReads(os: NodeJS.Platform): Promise<Set<string>> {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-reuse-env-"));
  // Native lookups such as os.homedir() see the real environment
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 401 })),
  );
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: os,
  });
  const reads = new Set<string>();
  const record = (key: string | symbol) => {
    if (typeof key === "string")
      reads.add(os === "win32" ? key.toUpperCase() : key);
  };
  process.env = new Proxy<NodeJS.ProcessEnv>(
    {
      HOME: root,
      USERPROFILE: root,
      PATH: "",
      XDG_CACHE_HOME: join(root, "cache"),
    },
    {
      get: (target, key) => (record(key), Reflect.get(target, key)),
      has: (target, key) => (record(key), Reflect.has(target, key)),
    },
  );
  try {
    await fetchQuota([...PROVIDER_IDS], { refreshCredentials: false });
  } finally {
    process.env = environment;
    rmSync(root, { recursive: true, force: true });
  }
  return reads;
}

describe("fresh-reuse credential selection", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "covers every environment variable a provider reads on %s",
    async (os) => {
      const reads = await environmentReads(os);
      expect(reads).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      const listed = new Set<string>(CREDENTIAL_SELECTION_ENV);
      const unclassified = [...reads].filter(
        (name) => !listed.has(name) && !NOT_SELECTING.has(name.toUpperCase()),
      );
      expect(unclassified).toEqual([]);
    },
  );

  it("changes with any selecting variable and hides every value", () => {
    const base = { HOME: "/synthetic/home" };
    const id = reuseContextId(base);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(reuseContextId({ ...base })).toBe(id);
    expect(reuseContextId({ ...base, TERM: "xterm" })).toBe(id);
    for (const name of CREDENTIAL_SELECTION_ENV) {
      if (name === "HOME") continue;
      expect(reuseContextId({ ...base, [name]: "synthetic" }), name).not.toBe(
        id,
      );
    }
    expect(reuseContextId({ ...base, ELEVENLABS_API_KEY: "sk-a" })).not.toBe(
      reuseContextId({ ...base, ELEVENLABS_API_KEY: "sk-b" }),
    );
  });
});
