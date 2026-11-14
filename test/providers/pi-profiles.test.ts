import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaAxiResponse } from "../../src/types.js";

/**
 * Opt-in Pi directory lanes (`QUOTA_AXI_PI_PROFILES`) and the per-lane manual
 * reset count, exercised through the public commands against synthetic Pi
 * stores, a synthetic native Codex home, and a stubbed vendor. No real
 * credential, Pi install, Codex CLI, or network is touched.
 */

vi.mock("../../src/lib/process.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/process.js")>();
  return { ...actual, findCommandPath: vi.fn(async () => undefined) };
});

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESETS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

type Seat = {
  account: string;
  used: number;
  /** The reset-credits answer: a count, a failure, or a malformed body. */
  resets?: number | "fail" | "malformed";
};

let root: string;
/** Which vendor seat each synthetic bearer belongs to. */
let seats: Map<string, Seat>;
let requests: { url: string; bearer: string; account: string | null }[];

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), "quota-axi-pi-profiles-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("CODEX_HOME", join(root, "codex-home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "pi-agent"));
  vi.stubEnv("QUOTA_AXI_PI_PROFILES", undefined);
  vi.stubEnv("QUOTA_AXI_MAX_AGE", undefined);
  vi.stubEnv("QUOTA_AXI_SNAPSHOT", undefined);
  seats = new Map();
  requests = [];
  vi.stubGlobal("fetch", vi.fn(vendor));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("QUOTA_AXI_PI_PROFILES", () => {
  it("reports each listed Pi directory as its own Codex lane beside the native login", async () => {
    writeNativeCodex("native-token", "acct-native");
    seats.set("native-token", { account: "acct-native", used: 10 });
    const radka = piDir("pi-radka", {
      "openai-codex": codexEntry("radka-token", "acct-radka"),
    });
    const aventic = piDir("pi-aventic", {
      "openai-codex": codexEntry("aventic-token", "acct-aventic"),
    });
    seats.set("radka-token", { account: "acct-radka", used: 40 });
    seats.set("aventic-token", { account: "acct-aventic", used: 70 });
    listProfiles(radka, aventic);

    const providers = await readCodex("--full");

    expect(providers).toHaveLength(3);
    const [native, first, second] = providers;
    expect(native).toMatchObject({
      accountKey: "codex-home",
      source: "oauth",
      windows: [{ percentUsed: 10 }],
    });
    expect(native?.accountLocator).toBeUndefined();
    expect(first).toMatchObject({
      accountKey: expect.stringMatching(/^pi-profile:[0-9a-f]{24}$/),
      accountLocator: {
        kind: "pi-agent-dir",
        path: radka,
        delegateEligible: false,
      },
      source: "pi:openai-codex",
      account: { accountId: "acct-radka" },
      windows: [{ percentUsed: 40 }],
    });
    expect(second).toMatchObject({
      accountLocator: { kind: "pi-agent-dir", path: aventic },
      account: { accountId: "acct-aventic" },
      windows: [{ percentUsed: 70 }],
    });
    expect(first?.accountKey).not.toBe(second?.accountKey);
    // A profile row covers only its own lane, never the selected store's ids.
    expect(first?.accountKeys).toEqual([first?.accountKey]);
    expect(second?.accountKeys).toEqual([second?.accountKey]);
    // Each bearer was sent only with its own account header.
    for (const request of requests) {
      expect(seats.get(request.bearer)?.account).toBe(request.account);
    }
    expect(JSON.stringify(providers)).not.toMatch(
      /native-token|radka-token|aventic-token|fixture-refresh/,
    );
  });

  it("keeps the lane key stable and the locator out of default output", async () => {
    const radka = piDir("pi-radka", {
      "openai-codex": codexEntry("radka-token", "acct-radka"),
    });
    const aventic = piDir("pi-aventic", {
      "openai-codex": codexEntry("aventic-token", "acct-aventic"),
    });
    seats.set("radka-token", { account: "acct-radka", used: 40 });
    seats.set("aventic-token", { account: "acct-aventic", used: 70 });
    listProfiles(radka, aventic);
    const before = (await readCodex()).map((row) => row.accountKey);

    listProfiles(aventic, radka);
    const after = await readCodex();

    expect(after.map((row) => row.accountKey)).toEqual([...before].reverse());
    expect(after.every((row) => row.accountLocator === undefined)).toBe(true);
  });

  it("reports a directory with only Pi's openai sign-in as unmeasurable, not signed out", async () => {
    const dir = piDir("pi-signin", {
      openai: {
        type: "oauth",
        access: "sign-in-token",
        refresh: "fixture-refresh",
        expires: Date.now() + 3_600_000,
        clientId: "fixture-client",
        scopes: ["chatgpt.tokens.use.direct"],
      },
    });
    listProfiles(dir);

    const [row] = await readCodex("--full");

    expect(row).toMatchObject({
      source: "unavailable",
      windows: [],
      state: {
        status: "unavailable",
        error: "Pi openai OAuth token cannot read ChatGPT usage",
        sourcesTried: ["pi:openai"],
      },
      attempts: [
        {
          source: "pi:openai",
          status: "skipped",
          error: "unsupported_credential_type",
          credentialPresent: true,
        },
      ],
    });
    expect(row?.state.status).not.toBe("auth_required");
    expect(requests).toEqual([]);
    expect(JSON.stringify(row)).not.toContain("sign-in-token");
  });

  it("reads the openai-codex entry when the directory also holds the openai sign-in", async () => {
    const dir = piDir("pi-both", {
      openai: { type: "oauth", access: "sign-in-token" },
      "openai-codex": codexEntry("codex-token", "acct-both"),
    });
    seats.set("codex-token", { account: "acct-both", used: 25 });
    listProfiles(dir);

    const [row] = await readCodex("--full");

    expect(row).toMatchObject({
      source: "pi:openai-codex",
      state: { status: "fresh", sourcesTried: ["pi:openai-codex"] },
      windows: [{ percentUsed: 25 }],
    });
    expect(requests.map((request) => request.bearer)).not.toContain(
      "sign-in-token",
    );
  });

  it("keeps a listed directory without a Codex login visible as its own lane", async () => {
    writeNativeCodex("native-token", "acct-native");
    seats.set("native-token", { account: "acct-native", used: 10 });
    const empty = join(root, "pi-empty");
    mkdirSync(empty);
    listProfiles(empty);

    const providers = await readCodex("--full");

    expect(providers).toHaveLength(2);
    expect(providers[1]).toMatchObject({
      accountLocator: { path: empty },
      state: { status: "auth_required", error: "Codex sign-in required" },
    });
  });

  it("does not read the selected Pi directory twice", async () => {
    writeNativeCodex("native-token", "acct-native");
    seats.set("native-token", { account: "acct-native", used: 10 });
    const selected = piDir("pi-agent", {
      "openai-codex": codexEntry("selected-token", "acct-selected"),
    });
    seats.set("selected-token", { account: "acct-selected", used: 50 });
    const other = piDir("pi-other", {
      "openai-codex": codexEntry("other-token", "acct-other"),
    });
    seats.set("other-token", { account: "acct-other", used: 60 });
    listProfiles(selected, other, other);

    const providers = await readCodex("--full");

    expect(providers.map((row) => row.accountLocator?.path)).toEqual([
      undefined,
      undefined,
      other,
    ]);
    expect(providers.map((row) => row.accountKey).slice(0, 2)).toEqual([
      "codex-home",
      "openai-codex",
    ]);
  });

  it("reads the selected Pi directory as a listed lane when it holds only the openai sign-in", async () => {
    const selected = piDir("pi-agent", {
      openai: { type: "oauth", access: "sign-in-token" },
    });
    const other = piDir("pi-other", {
      "openai-codex": codexEntry("other-token", "acct-other"),
    });
    seats.set("other-token", { account: "acct-other", used: 60 });
    listProfiles(selected, other);

    const providers = await readCodex("--full");

    expect(providers.map((row) => row.accountLocator?.path)).toEqual([
      selected,
      other,
    ]);
    expect(providers[0]).toMatchObject({
      source: "unavailable",
      state: {
        status: "unavailable",
        error: "Pi openai OAuth token cannot read ChatGPT usage",
      },
      attempts: [
        {
          source: "pi:openai",
          status: "skipped",
          error: "unsupported_credential_type",
          credentialPresent: true,
        },
      ],
    });
    expect(requests.map((request) => request.bearer)).not.toContain(
      "sign-in-token",
    );
  });

  it("rejects a relative entry before any credential is read", async () => {
    vi.stubEnv(
      "QUOTA_AXI_PI_PROFILES",
      [join(root, "pi-radka"), "relative/pi"].join(delimiter),
    );
    const { quotaCommand } = await import("../../src/commands.js");

    await expect(
      quotaCommand(["--provider", "codex", "--json"], undefined),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(requests).toEqual([]);
  });

  it("ignores the variable for --profile-only", async () => {
    writeNativeCodex("native-token", "acct-native");
    seats.set("native-token", { account: "acct-native", used: 10 });
    vi.stubEnv("QUOTA_AXI_PI_PROFILES", "relative/pi");

    const providers = await readCodex("--profile-only", "--full");

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ source: "oauth" });
  });

  it("lists the openai sign-in as an unsupported auth source", async () => {
    const dir = piDir("pi-both", {
      openai: { type: "oauth", access: "sign-in-token" },
      "openai-codex": codexEntry("codex-token", "acct-both"),
    });
    const second = piDir("pi-second", {
      "openai-codex": codexEntry("second-token", "acct-second"),
    });
    listProfiles(dir, second);
    const { authCommand } = await import("../../src/commands.js");

    const output = JSON.parse(
      await authCommand(["--provider", "codex", "--json"], undefined),
    ) as { auth: { sources: { source: string; status: string }[] }[] };

    expect(output.auth[0]?.sources).toEqual([
      expect.objectContaining({
        source: "pi:openai-codex",
        status: "available",
      }),
      expect.objectContaining({
        source: "pi:openai",
        status: "invalid",
        error: "unsupported_credential_type",
      }),
    ]);
    expect(JSON.stringify(output)).not.toMatch(/sign-in-token|codex-token/);
  });
});

describe("Codex manual resets", () => {
  it("publishes the vendor's available reset count per lane", async () => {
    writeNativeCodex("native-token", "acct-native");
    seats.set("native-token", { account: "acct-native", used: 10, resets: 2 });
    const dir = piDir("pi-radka", {
      "openai-codex": codexEntry("radka-token", "acct-radka"),
    });
    seats.set("radka-token", { account: "acct-radka", used: 40, resets: 0 });
    listProfiles(dir);

    const providers = await readCodex();

    expect(providers.map((row) => row.resetsAvailable)).toEqual([2, 0]);
    const resetRequests = requests.filter(({ url }) => url === RESETS_URL);
    expect(resetRequests).toEqual([
      { url: RESETS_URL, bearer: "native-token", account: "acct-native" },
      { url: RESETS_URL, bearer: "radka-token", account: "acct-radka" },
    ]);
  });

  it("names only a positive count in the default report", async () => {
    writeNativeCodex("native-token", "acct-native");
    seats.set("native-token", { account: "acct-native", used: 10, resets: 3 });
    const { quotaCommand } = await import("../../src/commands.js");

    const toon = await quotaCommand(["--provider", "codex"], undefined);

    expect(toon).toMatch(/codex,all,resets,available 3/);

    seats.set("native-token", { account: "acct-native", used: 10, resets: 0 });
    const zero = await quotaCommand(["--provider", "codex"], undefined);
    expect(zero).not.toMatch(/,resets,/);
  });

  it.each(["fail", "malformed"] as const)(
    "leaves the count unknown and the reading fresh when the reset read is %s",
    async (resets) => {
      writeNativeCodex("native-token", "acct-native");
      seats.set("native-token", { account: "acct-native", used: 10, resets });

      const [row] = await readCodex();

      expect(row?.state.status).toBe("fresh");
      expect(row?.windows).toMatchObject([{ percentRemaining: 90 }]);
      expect(row).not.toHaveProperty("resetsAvailable");
    },
  );

  it("restores the count with a cached snapshot", async () => {
    writeNativeCodex("native-token", "acct-native");
    seats.set("native-token", { account: "acct-native", used: 10, resets: 1 });
    await readCodex();
    seats.set("native-token", {
      account: "acct-native",
      used: 10,
      resets: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    const [row] = await readCodex();

    expect(row?.state.stale).toBe(true);
    expect(row?.resetsAvailable).toBe(1);
  });
});

async function readCodex(
  ...flags: string[]
): Promise<QuotaAxiResponse["providers"]> {
  const { quotaCommand } = await import("../../src/commands.js");
  const output = await quotaCommand(
    ["--provider", "codex", "--json", "--no-credential-refresh", ...flags],
    undefined,
  );
  return (JSON.parse(output) as QuotaAxiResponse).providers;
}

function listProfiles(...dirs: string[]): void {
  vi.stubEnv("QUOTA_AXI_PI_PROFILES", dirs.join(delimiter));
}

function piDir(name: string, store: Record<string, unknown>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(store), {
    mode: 0o600,
  });
  return dir;
}

function codexEntry(access: string, accountId: string) {
  return {
    type: "oauth",
    access,
    refresh: "fixture-refresh",
    expires: Date.now() + 3_600_000,
    accountId,
  };
}

function writeNativeCodex(accessToken: string, accountId: string): void {
  const home = process.env.CODEX_HOME!;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      tokens: { access_token: accessToken, account_id: accountId },
    }),
    { mode: 0o600 },
  );
}

async function vendor(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const account = headers.get("ChatGPT-Account-Id");
  requests.push({ url, bearer, account });
  const seat = seats.get(bearer);
  if (!seat || seat.account !== account) {
    return new Response("unauthorized", { status: 401 });
  }
  if (url === RESETS_URL) {
    if (seat.resets === undefined || seat.resets === "fail")
      return new Response("unavailable", { status: 503 });
    if (seat.resets === "malformed")
      return Response.json({ credits: [], available_count: -1 });
    return Response.json({ credits: [], available_count: seat.resets });
  }
  if (url !== USAGE_URL) return new Response("not found", { status: 404 });
  return Response.json({
    plan_type: "plus",
    account_id: seat.account,
    rate_limit: {
      primary_window: {
        used_percent: seat.used,
        limit_window_seconds: 604_800,
        reset_after_seconds: 86_400,
      },
    },
  });
}
