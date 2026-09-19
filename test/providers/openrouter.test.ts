import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenRouterAdapter,
  defaultOpenRouterCredentialSources,
  extractOpenRouterCredential,
  normalizeOpenRouterKey,
  opencodeAuthFilePath,
} from "../../src/providers/openrouter.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-openrouter-key-42";

const ENV_KEYS = [
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "PI_CODING_AGENT_DIR",
  "OPENROUTER_API_KEY",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-openrouter-"));
  process.env.XDG_DATA_HOME = join(tempDir, "data");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  delete process.env.OPENROUTER_API_KEY;
  if (process.platform === "win32")
    process.env.LOCALAPPDATA = join(tempDir, "local");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function writePiStore(value: unknown): void {
  const dir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(value), { mode: 0o600 });
}

function writeOpencodeAuth(value: unknown): void {
  mkdirSync(join(process.env.XDG_DATA_HOME!, "opencode"), {
    recursive: true,
  });
  writeFileSync(opencodeAuthFilePath(), JSON.stringify(value), { mode: 0o600 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenRouter provider", () => {
  it("extracts a literal key under the openrouter id", () => {
    expect(
      extractOpenRouterCredential(
        { openrouter: { type: "api", key: KEY } },
        "/auth.json",
      ),
    ).toEqual({ status: "available", apiKey: KEY, path: "/auth.json" });
    expect(
      extractOpenRouterCredential(
        { openrouter: { type: "api", api_key: KEY } },
        "/auth.json",
      ),
    ).toEqual({ status: "available", apiKey: KEY, path: "/auth.json" });
  });

  it("rejects environment, template, and command-referenced keys", () => {
    for (const unsafe of ["$OPENROUTER_API_KEY", "!command", "\u0000"]) {
      expect(
        extractOpenRouterCredential(
          { openrouter: { type: "api", key: unsafe } },
          "/auth.json",
        ).status,
      ).not.toBe("available");
    }
  });

  it("reports credits when usage and a positive limit are present", async () => {
    writeOpencodeAuth({ openrouter: { type: "api", key: KEY } });

    const request = vi.fn(async () =>
      jsonResponse({
        data: {
          label: "Openrouter test",
          usage: 12.5,
          limit: 50,
          is_free_tier: false,
        },
      }),
    );
    const report = await createOpenRouterAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://openrouter.ai/api/v1/auth/key",
    );
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
    expect(report).toMatchObject({
      provider: "openrouter",
      plan: "Openrouter test",
      windows: [
        {
          id: "credits",
          kind: "credits",
          spentUsd: 12.5,
          limitUsd: 50,
        },
      ],
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("reports usable auth with no windows when limit is null", async () => {
    writeOpencodeAuth({ openrouter: { type: "api", key: KEY } });

    const request = vi.fn(async () =>
      jsonResponse({
        data: { label: "Free key", usage: 1, limit: null },
      }),
    );
    const report = await createOpenRouterAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    expect(report).toMatchObject({
      provider: "openrouter",
      windows: [],
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
  });

  it("falls through to the Pi source when opencode has no entry", async () => {
    writeOpencodeAuth({ "some-other": { type: "api", key: KEY } });
    writePiStore({ openrouter: { type: "api_key", key: KEY } });

    const request = vi.fn(async () =>
      jsonResponse({ data: { usage: 0, limit: 10 } }),
    );
    const report = await createOpenRouterAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    expect(report).toMatchObject({
      provider: "openrouter",
      windows: [{ id: "credits", spentUsd: 0, limitUsd: 10 }],
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
  });

  it("honours OPENROUTER_API_KEY ahead of the configured stores", async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    writePiStore({ openrouter: { type: "api_key", key: "pi-store-key" } });
    writeOpencodeAuth({ openrouter: { type: "api", key: "opencode-key" } });

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    await createOpenRouterAdapter({ fetch: request }).fetchQuota(OPTIONS);

    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
  });

  it("marks a structurally invalid Pi entry as credentialPresent", async () => {
    writeOpencodeAuth({ "some-other": { type: "api", key: KEY } });
    writePiStore({ openrouter: { type: "api_key", key: "$REFERENCE" } });

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    const report = await createOpenRouterAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    const attempt = (report.attempts ?? []).find(
      (item) => item.source === "pi:openrouter",
    );
    expect(attempt?.credentialPresent).toBe(true);
    expect(report.state.status).toBe("auth_required");
  });

  it("marks a present-but-invalid opencode entry as credentialPresent", async () => {
    writeOpencodeAuth({ openrouter: { type: "api", key: "!command" } });
    writePiStore({});

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    const report = await createOpenRouterAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    const attempt = (report.attempts ?? []).find(
      (item) => item.source === "opencode:auth.json",
    );
    expect(attempt?.credentialPresent).toBe(true);
  });

  it("reports auth_required on 401 with the upstream rejection error", async () => {
    writeOpencodeAuth({ openrouter: { type: "api", key: KEY } });

    const report = await createOpenRouterAdapter({
      fetch: vi.fn(async () => new Response("nope", { status: 401 })),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
  });

  it("treats every empty credential store as missing, not as degraded", async () => {
    writeOpencodeAuth({});
    writePiStore({});

    const request = vi.fn(async () => jsonResponse({ data: {} }));
    const report = await createOpenRouterAdapter({ fetch: request }).fetchQuota(
      OPTIONS,
    );

    expect(report.state.status).toBe("auth_required");
    for (const attempt of report.attempts ?? []) {
      expect(attempt.credentialPresent).toBeUndefined();
    }
  });

  it("does not invent a window from a numeric usage without a limit", () => {
    expect(
      normalizeOpenRouterKey({ data: { usage: 5, label: "Free key" } }),
    ).toEqual({ label: "Free key", usage: 5, credits: false });
  });

  it("ignores a zero limit, so the call is treated as no-quota", () => {
    expect(normalizeOpenRouterKey({ data: { usage: 0, limit: 0 } })).toEqual({
      usage: 0,
      credits: false,
    });
  });

  it("inspects every configured source for the auth command", async () => {
    writeOpencodeAuth({ openrouter: { type: "api", key: KEY } });
    writePiStore({ "some-other": { type: "api", key: KEY } });

    const report = await createOpenRouterAdapter().inspectAuth(OPTIONS);

    expect(report.sources.map((source) => source.source)).toEqual([
      "OPENROUTER_API_KEY",
      "opencode:auth.json",
      "pi:openrouter",
    ]);
    const opencodeSource = report.sources.find(
      (source) => source.source === "opencode:auth.json",
    );
    expect(opencodeSource?.status).toBe("available");
    const piSource = report.sources.find(
      (source) => source.source === "pi:openrouter",
    );
    expect(piSource?.status).toBe("missing");
  });

  it("respects a custom credential source list, keeping its order", () => {
    expect(
      defaultOpenRouterCredentialSources().map((source) => source.name),
    ).toEqual(["opencode:auth.json", "pi:openrouter"]);
  });

  it("never logs the bearer, even when the upstream returns an error that mentions it", async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    const fetchMock = vi.fn(async () => {
      throw new Error(`upstream saw ${KEY}`);
    });
    const report = await createOpenRouterAdapter({
      fetch: fetchMock,
    }).fetchQuota(OPTIONS);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(report.state.error).not.toContain(KEY);
  });
});
