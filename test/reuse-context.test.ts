import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaCommand } from "../src/commands.js";
import type { QuotaAxiResponse } from "../src/types.js";

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

/** A value no real environment holds, so the cache can be searched for it */
const SELECTION_VALUE = "synthetic-selection-value";

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
    await quotaCommand(
      ["--json", "--no-credential-refresh", "--max-age", "0"],
      undefined,
    );
  } finally {
    process.env = environment;
    rmSync(root, { recursive: true, force: true });
  }
  return reads;
}

/**
 * A reusable Claude reading taken under a synthetic Linux profile, then a
 * second read after `change` edits the environment. Returns whether the
 * second read was served from the first, and the cache file it left behind.
 */
async function reusedAfter(
  change: (environment: NodeJS.ProcessEnv) => void,
): Promise<{ reused: boolean; cache: string }> {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-reuse-select-"));
  const configDir = join(root, "profile");
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "synthetic-claude-token",
        expiresAt: "2035-01-01T00:00:00.000Z",
      },
    }),
  );
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "linux",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/api/oauth/usage")
        ? new Response(
            JSON.stringify({
              limits: [
                {
                  kind: "weekly_all",
                  group: "weekly",
                  percent: 40,
                  resets_at: "2099-01-01T00:00:00Z",
                },
              ],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ account: { uuid: "fixture" } }), {
            status: 200,
          }),
    ),
  );
  process.env = {
    HOME: root,
    USERPROFILE: root,
    PATH: "",
    XDG_CACHE_HOME: join(root, "cache"),
    CLAUDE_CONFIG_DIR: configDir,
  };
  const read = async () =>
    (
      JSON.parse(
        await quotaCommand(
          [
            "--provider",
            "claude",
            "--json",
            "--no-credential-refresh",
            "--max-age",
            "90s",
          ],
          undefined,
        ),
      ) as QuotaAxiResponse
    ).providers[0]!;
  try {
    await read();
    change(process.env);
    const second = await read();
    return {
      reused: second.state.reused === true,
      cache: readFileSync(join(root, "cache", "quota-axi", "quotas.json"), {
        encoding: "utf8",
      }),
    };
  } finally {
    process.env = environment;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("fresh-reuse credential selection", () => {
  it("still reuses a reading when nothing that selects a credential changed", async () => {
    expect((await reusedAfter(() => {})).reused).toBe(true);
    expect(
      (await reusedAfter((environment) => (environment.TERM = "xterm"))).reused,
    ).toBe(true);
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "never reuses a reading across a change to any variable a provider reads on %s",
    async (os) => {
      const reads = await environmentReads(os);
      expect(reads).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      const selecting = [...reads].filter(
        (name) => !NOT_SELECTING.has(name.toUpperCase()),
      );
      const reusedAcross: string[] = [];
      for (const name of selecting) {
        const { reused, cache } = await reusedAfter(
          (environment) => (environment[name] = SELECTION_VALUE),
        );
        if (reused) reusedAcross.push(name);
        expect(cache, name).not.toContain(SELECTION_VALUE);
      }
      expect(reusedAcross).toEqual([]);
    },
  );
});
