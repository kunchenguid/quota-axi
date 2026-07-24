import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchQuota, inspectAuth } from "../../src/providers/tokenrouter.js";

const originalKey = process.env.TOKENROUTER_MGMT_KEY;
const originalCacheHome = process.env.XDG_CACHE_HOME;
let cacheHome: string;

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "quota-axi-tokenrouter-test-"));
  process.env.XDG_CACHE_HOME = cacheHome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.TOKENROUTER_MGMT_KEY;
  else process.env.TOKENROUTER_MGMT_KEY = originalKey;
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  rmSync(cacheHome, { recursive: true, force: true });
});

describe("TokenRouter provider", () => {
  it("reports wallet balance and credit-pool usage without exposing the key", async () => {
    process.env.TOKENROUTER_MGMT_KEY = "secret-test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            topUpBalance: 100,
            voucherEfficientAmount: 20,
            toppedUpSpent: 50,
            voucherSpent: 30,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });
    expect(result.state.status).toBe("fresh");
    expect(result.credits).toEqual({ remaining: 120, unit: "usd" });
    expect(result.windows[0]).toMatchObject({
      id: "credit_pool",
      percentUsed: 40,
      percentRemaining: 60,
    });
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tokenrouter.com/api/management/self/wallet",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret-test-key",
        }),
      }),
    );
  });

  it("reports missing management credentials without making a request", async () => {
    delete process.env.TOKENROUTER_MGMT_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });
    expect(result.state.status).toBe("auth_required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await inspectAuth({ allowKeychainPrompt: false })).toEqual({
      provider: "tokenrouter",
      sources: [
        { source: "env", status: "missing", credentialPresent: false },
        {
          source: "keychain",
          status: "skipped",
          credentialPresent: false,
          error: "keychain_prompt_required",
        },
      ],
    });
  });
});
