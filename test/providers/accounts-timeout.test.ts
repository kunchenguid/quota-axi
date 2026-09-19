import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAccountQuotas,
  inspectAccountAuth,
} from "../../src/providers/accounts.js";
import type { ProviderAdapter, ProviderOptions } from "../../src/types.js";

const options: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
  probeTimeoutMs: 5_000,
};

afterEach(() => vi.useRealTimers());

describe("provider probe bounds", () => {
  it("turns an unresponsive credential probe into an unavailable reading", async () => {
    vi.useFakeTimers();
    const adapter: ProviderAdapter = {
      id: "claude",
      label: "Claude",
      fetchQuota: () => new Promise(() => {}),
      async inspectAuth() {
        return { provider: "claude", sources: [] };
      },
    };

    const pending = fetchAccountQuotas(adapter, options);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending)[0]?.state).toMatchObject({
      status: "unavailable",
      error: "provider_probe_timeout",
    });
  });

  it("bounds credential discovery while a healthy provider still renders", async () => {
    vi.useFakeTimers();
    const blocked: ProviderAdapter = {
      id: "claude",
      label: "Claude",
      discoverAccounts: () => new Promise(() => {}),
      fetchQuota: () => new Promise(() => {}),
      inspectAuth: () => new Promise(() => {}),
    };
    const healthy: ProviderAdapter = {
      id: "codex",
      label: "Codex",
      async fetchQuota() {
        return {
          provider: "codex",
          label: "Codex",
          source: "cli-rpc",
          windows: [],
          state: { status: "fresh", stale: false, sourcesTried: ["cli-rpc"] },
        };
      },
      async inspectAuth() {
        return { provider: "codex", sources: [] };
      },
    };

    const readings = Promise.all([
      fetchAccountQuotas(blocked, options),
      fetchAccountQuotas(healthy, options),
      inspectAccountAuth(blocked, options),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    const [timedOut, live, auth] = await readings;
    expect(timedOut[0].state.error).toBe("provider_probe_timeout");
    expect(live[0].state.status).toBe("fresh");
    expect(auth[0].sources[0]).toMatchObject({
      source: "provider-probe",
      error: "provider_probe_timeout",
    });
  });
});
