import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCachedProvider,
  readCachedProvider,
  readReusableProviders,
  retireCachedSlot,
  writeCachedProviders,
} from "../src/cache.js";
import { main } from "../src/cli.js";
import { authCommand, quotaCommand } from "../src/commands.js";
import { cacheFilePath } from "../src/lib/fs.js";
import { inputsDigest } from "../src/lib/input-trace.js";
import { reuseContextId } from "../src/lib/reuse-context.js";
import { PROVIDERS } from "../src/providers/index.js";
import { PROVIDER_IDS, type ProviderQuota } from "../src/types.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(() => {
    throw new Error("subprocess prohibited");
  }),
  spawn: vi.fn(() => {
    throw new Error("subprocess prohibited");
  }),
}));
const KEY = "synthetic-ollama-cli-key";
const modern = JSON.parse(
  readFileSync(
    new URL("./fixtures/ollama/modern.json", import.meta.url),
    "utf8",
  ),
);
const legacy = JSON.parse(
  readFileSync(
    new URL("./fixtures/ollama/legacy.json", import.meta.url),
    "utf8",
  ),
);
let root: string;
const originals = { ...PROVIDERS };
let requests: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quota-axi-ollama-cli-"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("OLLAMA_API_KEY", KEY);
  vi.stubEnv("QUOTA_AXI_SNAPSHOT", "");
  vi.stubEnv("QUOTA_AXI_THEME", "dark");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  requests = vi.fn(async () => new Response(JSON.stringify(modern)));
  vi.stubGlobal("fetch", requests);
});
afterEach(() => {
  expect(execFile).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  Object.assign(PROVIDERS, originals);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});
const capture = async (argv: string[]) => {
  let output = "";
  await main({
    argv,
    binPath: "quota-axi",
    stdout: {
      write: (text) => {
        output += text;
      },
    },
  });
  return output;
};
const report = async (args: string[] = []) =>
  JSON.parse(
    await quotaCommand(["--provider", "ollama", "--json", ...args], undefined),
  );
const fresh = (): ProviderQuota => ({
  provider: "ollama",
  source: "api",
  label: "Ollama Cloud",
  windows: [
    {
      id: "included_month",
      label: "Included monthly credits",
      kind: "monthly",
      percentUsed: 27.5,
      percentRemaining: 72.5,
      startsAt: "2026-10-01T00:00:00Z",
      resetsAt: "2026-11-01T00:00:00Z",
    },
  ],
  state: {
    status: "fresh",
    stale: false,
    refreshedAt: "2026-10-09T12:00:00Z",
    sourcesTried: ["env:OLLAMA_API_KEY"],
  },
  credits: { remaining: 12.5, unit: "usd" },
});
function seedCache(): string {
  mkdirSync(dirname(cacheFilePath()), { recursive: true });
  const reuse = {
    context: reuseContextId(),
    inputs: [],
    inputsDigest: inputsDigest([]),
    readingAt: new Date().toISOString(),
    lanes: 1,
    lane: 0,
  };
  const serialized = JSON.stringify({
    schemaVersion: 3,
    providers: [
      { ...fresh(), reuse },
      { ...fresh(), provider: "deepseek", reuse },
    ],
  });
  writeFileSync(cacheFilePath(), serialized, { mode: 0o600 });
  return serialized;
}

describe("registered Ollama CLI/TUI and first-release cache boundary", () => {
  it("selects Ollama in declaration order and exposes it in help without a model catalog", async () => {
    expect(PROVIDER_IDS.at(-1)).toBe("ollama");
    const help = await capture(["--help"]);
    expect(help).toContain("higgsfield,ollama");
    expect(help).toContain("OLLAMA_API_KEY");
    expect(help).toContain("https://ollama.com/api/balance");
    expect(requests).not.toHaveBeenCalled();
    expect(await capture(["models", "--provider", "ollama"])).toContain(
      "VALIDATION_ERROR",
    );
    expect(requests).not.toHaveBeenCalled();
  });
  it("publishes full/default JSON, TOON and purchased-only credit labels", async () => {
    const compact = await report();
    const full = await report(["--full"]);
    expect(compact.providers[0]).toMatchObject({
      provider: "ollama",
      state: { status: "fresh" },
      credits: { remaining: 12.5, unit: "usd" },
    });
    expect(compact.providers[0].attempts).toBeUndefined();
    expect(full.providers[0]).toMatchObject({
      label: "Ollama Cloud",
      source: "api",
      attempts: [{ source: "env:OLLAMA_API_KEY", status: "success" }],
      quotaSemantics: {
        effectiveAvailability: [
          { scope: "included_credits", effectivePercentRemaining: 72.5 },
        ],
      },
    });
    const toon = await capture(["--provider", "ollama"]);
    expect(toon).toContain("included_credits");
    expect(toon).toContain("purchased remaining 12.5 usd");
    for (const output of [JSON.stringify(compact), JSON.stringify(full), toon])
      expect(output).not.toContain(KEY);
  });
  it.each(["dark", "light"])(
    "renders %s TUI palette and used/remaining direction with separate purchased credits",
    async (theme) => {
      const remaining = await capture([
        "--provider",
        "ollama",
        "--tui",
        "--once",
        "--theme",
        theme,
      ]);
      expect(remaining).toContain("ollama");
      expect(remaining).toContain("73%");
      expect(remaining).toContain("purchased 12.5 usd remaining");
      mkdirSync(join(root, "config", "quota-axi"), { recursive: true });
      writeFileSync(
        join(root, "config", "quota-axi", "config.json"),
        JSON.stringify({ tui: { show: "used" } }),
      );
      const used = await capture([
        "--provider",
        "ollama",
        "--tui",
        "--once",
        "--theme",
        theme,
      ]);
      expect(used).toContain("28%");
      expect(used).toContain("used");
      expect((await report()).providers[0].windows[0].percentRemaining).toBe(
        72.5,
      );
    },
  );
  it("renders legacy raw readings without a minimum headline or purchased aggregation", async () => {
    requests.mockImplementation(
      async () => new Response(JSON.stringify(legacy)),
    );
    const json = await report();
    const toon = await capture(["--provider", "ollama", "--full"]);
    const tui = await capture(["--provider", "ollama", "--tui", "--once"]);
    expect(json.providers[0].quotaSemantics.effectiveAvailability).toEqual([]);
    expect(toon).toContain("75");
    expect(toon).toContain("60");
    expect(toon).not.toContain("included_credits");
    expect(tui).toContain("no combined bound");
    expect(tui).toContain("purchased 0 usd remaining");
  });
  it.each(["modern", "legacy"] as const)(
    "renders unknown included headroom beside purchased credits after %s expiry",
    async (family) => {
      const payload = JSON.parse(
        JSON.stringify(family === "modern" ? modern : legacy),
      );
      if (family === "modern") {
        payload.included.period.until = "2026-10-09T11:59:59Z";
      } else {
        payload.included.session.resets_at = "2026-10-09T11:59:59Z";
        payload.included.weekly.resets_at = "2026-10-09T11:59:59Z";
      }
      requests.mockImplementation(
        async () => new Response(JSON.stringify(payload)),
      );
      const tui = await capture(["--provider", "ollama", "--tui", "--once"]);
      expect(tui).toContain(
        family === "modern"
          ? "purchased 12.5 usd remaining"
          : "purchased 0 usd remaining",
      );
      expect(tui).toContain("included headroom unknown");
    },
  );
  it("local auth is network-free and missing env folds only in an unscoped human report", async () => {
    const auth = await authCommand(
      ["--provider", "ollama", "--json"],
      undefined,
    );
    expect(auth).toContain("env:OLLAMA_API_KEY");
    expect(auth).not.toContain(KEY);
    expect(requests).not.toHaveBeenCalled();
    vi.stubEnv("OLLAMA_API_KEY", "");
    for (const id of PROVIDER_IDS)
      if (id !== "ollama")
        PROVIDERS[id] = {
          id,
          label: id,
          inspectAuth: async () => ({ provider: id, sources: [] }),
          fetchQuota: async () => ({
            provider: id,
            windows: [],
            state: { status: "fresh", stale: false },
          }),
        };
    expect(await capture([])).toContain("not set up");
    expect(
      JSON.parse(await capture(["--json"])).providers.find(
        (p: ProviderQuota) => p.provider === "ollama",
      ).notSetUp,
    ).toBe(true);
    expect(await capture(["--provider", "ollama"])).toContain(
      "ollama_credential_unavailable",
    );
    expect(requests).not.toHaveBeenCalled();
  });
  it("does not create a cache, even with explicit max-age or host reuse preference", async () => {
    vi.stubEnv("QUOTA_AXI_MAX_AGE", "1h");
    await report();
    await report(["--max-age", "1h"]);
    expect(requests).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "cache"))).toBe(false);
    writeCachedProviders([fresh()]);
    expect(existsSync(join(root, "cache"))).toBe(false);
  });
  it("cannot read, reuse, clear, retire, or overwrite an unrelated Ollama snapshot", async () => {
    const previous = seedCache();
    expect(readCachedProvider("ollama")).toBeUndefined();
    expect(readReusableProviders("ollama", 3600)).toBeUndefined();
    expect(readCachedProvider("deepseek")).toBeDefined();
    // The sibling's identical stamp is usable: Ollama is deliberately excluded,
    // not accidentally failing because the synthetic cache record is malformed.
    expect(readReusableProviders("deepseek", 3600)).toHaveLength(1);
    writeCachedProviders([fresh(), { ...fresh(), windows: [] }]);
    deleteCachedProvider("ollama");
    retireCachedSlot("ollama");
    await report(["--max-age", "1h"]);
    await report(["--max-age", "1h"]);
    expect(requests).toHaveBeenCalledTimes(2);
    expect(readFileSync(cacheFilePath(), "utf8")).toBe(previous);
    expect(previous).not.toContain(KEY);
  });
  it("does not reuse an Ollama snapshot before account binding", async () => {
    const previous = seedCache();
    vi.stubEnv("QUOTA_AXI_SNAPSHOT", cacheFilePath());
    const output = await report();
    expect(output.providers[0]).toMatchObject({
      windows: [],
      state: { status: "unavailable", error: "not_in_snapshot" },
    });
    expect(requests).not.toHaveBeenCalled();
    expect(readFileSync(cacheFilePath(), "utf8")).toBe(previous);
  });

  it.each([401, 403, 429, 503, "network", "schema", "missing"])(
    "failure %s cannot fallback to or retire an existing snapshot, and leaks no secret to any surface/log",
    async (failure) => {
      const previous = seedCache();
      const log = vi.spyOn(console, "log");
      const error = vi.spyOn(console, "error");
      const warn = vi.spyOn(console, "warn");
      if (failure === "missing") vi.stubEnv("OLLAMA_API_KEY", "");
      else
        requests.mockImplementation(async () => {
          if (failure === "network") throw new Error(KEY);
          return failure === "schema"
            ? new Response(JSON.stringify({ key: KEY }))
            : new Response(KEY, { status: failure as number });
        });
      const outputs = [
        await report(["--full", "--max-age", "1h"]),
        await capture(["--provider", "ollama"]),
        await capture(["--provider", "ollama", "--tui", "--once"]),
        await authCommand(["--provider", "ollama", "--json"], undefined),
      ];
      expect(
        (outputs[0] as { providers: ProviderQuota[] }).providers[0].windows,
      ).toEqual([]);
      expect(
        (outputs[0] as { providers: ProviderQuota[] }).providers[0].state.stale,
      ).toBe(false);
      expect(JSON.stringify(outputs)).not.toContain(KEY);
      expect(readFileSync(cacheFilePath(), "utf8")).toBe(previous);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
