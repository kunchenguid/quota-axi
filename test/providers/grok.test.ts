import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuota, normalizeGrokBilling } from "../../src/providers/grok.js";

const originalGrokAuthJson = process.env.GROK_AUTH_JSON;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-grok-auth-"));
  process.env.GROK_AUTH_JSON = join(tempDir, "auth.json");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.PATH = join(tempDir, "empty-bin");
  process.env.PATHEXT = ".CMD;.EXE";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalGrokAuthJson === undefined) delete process.env.GROK_AUTH_JSON;
  else process.env.GROK_AUTH_JSON = originalGrokAuthJson;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPathExt === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = originalPathExt;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function writeAuth(value: unknown): void {
  writeFileSync(process.env.GROK_AUTH_JSON!, JSON.stringify(value));
}

function writeLocalGrokPackage(version: string): void {
  const packageDir = join(tempDir!, "lib", "node_modules", "grok");
  const binDir = join(packageDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "grok", version, bin: { grok: "bin/grok" } }),
  );
  const command =
    process.platform === "win32"
      ? join(binDir, "grok.CMD")
      : join(binDir, "grok");
  writeFileSync(
    command,
    process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
  );
  chmodSync(command, 0o700);
  process.env.PATH = binDir;
}

describe("Grok quota parsing", () => {
  it("normalizes credit, on-demand, and product windows", () => {
    const result = normalizeGrokBilling(
      {
        config: {
          billingPeriodEnd: "2026-08-02T00:00:00Z",
          creditUsagePercent: 40,
          onDemandCap: { val: "1000" },
          onDemandUsed: { val: 250 },
          prepaidBalance: { val: 12.5 },
          subscriptionTier: "supergrok",
          productUsage: [
            { product: "Grok Build", usagePercent: "55" },
            { product: "Voice", usagePercent: 105 },
          ],
        },
      },
      {
        email: "person@example.invalid",
        teamId: "team_fixture",
      },
    );

    expect(result?.plan).toBe("supergrok");
    expect(result?.account).toMatchObject({
      email: "person@example.invalid",
      organization: "team_fixture",
    });
    expect(result?.credits).toEqual({ remaining: 12.5, unit: "credits" });
    expect(result?.windows).toMatchObject([
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: 40,
        percentRemaining: 60,
        resetsAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "on_demand",
        label: "on-demand credits",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
      },
      {
        id: "product:grok_build",
        label: "Grok Build",
        kind: "credits",
        percentUsed: 55,
        percentRemaining: 45,
      },
      {
        id: "product:voice",
        label: "Voice",
        kind: "credits",
        percentUsed: 100,
        percentRemaining: 0,
      },
    ]);
  });

  it("returns undefined when Grok exposes no numeric quota windows", () => {
    expect(normalizeGrokBilling({ config: {} })).toBeUndefined();
  });

  it("continues past expired entries to use later valid credentials", async () => {
    writeAuth({
      expired: {
        key: "expired-key",
        expires_at: "2020-01-01T00:00:00.000Z",
      },
      valid: {
        key: "valid-key",
        email: "person@example.invalid",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 25,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(result.account?.email).toBe("person@example.invalid");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer valid-key",
        }),
      }),
    );
  });

  it("uses the installed local Grok package version in billing requests", async () => {
    writeAuth({
      current: {
        key: "valid-key",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    writeLocalGrokPackage("9.9.9");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 25,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchQuota({ allowKeychainPrompt: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-grok-client-version": "9.9.9",
        }),
      }),
    );
  });

  it("omits the Grok client version header without a local Grok package", async () => {
    writeAuth({
      current: {
        key: "valid-key",
        expires_at: "2035-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 25,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchQuota({ allowKeychainPrompt: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          "x-grok-client-version": expect.any(String),
        }),
      }),
    );
  });
});
