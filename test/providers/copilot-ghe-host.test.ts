import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copilotCacheContextId,
  readCachedCopilotProvider,
  writeCachedProviders,
} from "../../src/cache.js";
import { providerFetch } from "../../src/lib/http.js";
import { fetchQuota } from "../../src/providers/copilot.js";

vi.mock("../../src/lib/http.js", () => ({ providerFetch: vi.fn() }));

const options = { allowKeychainPrompt: false, refreshCredentials: false };
let home: string;

function response() {
  return new Response(
    JSON.stringify({
      copilot_plan: "enterprise",
      quota_snapshots: { chat: { percent_remaining: 80 } },
    }),
    { status: 200 },
  );
}

function writeApps(entries: Record<string, unknown>) {
  writeFileSync(join(home, "apps.json"), JSON.stringify(entries));
}

function writeHosts(text: string) {
  mkdirSync(join(home, "gh"), { recursive: true });
  writeFileSync(join(home, "gh/hosts.yml"), text);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "quota-copilot-ghe-"));
  vi.stubEnv("COPILOT_HOME", join(home, ".copilot"));
  vi.stubEnv("GITHUB_COPILOT_APPS_JSON", join(home, "apps.json"));
  vi.stubEnv("GH_CONFIG_DIR", join(home, "gh"));
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  for (const name of [
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_GH_HOST",
    "GH_HOST",
    "QUOTA_AXI_COPILOT_HOST",
  ])
    vi.stubEnv(name, undefined);
  vi.mocked(providerFetch).mockImplementation(async () => response());
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("Copilot on a GitHub Enterprise Cloud host", () => {
  it("queries api.<host> with the gh login for that host", async () => {
    vi.stubEnv("QUOTA_AXI_COPILOT_HOST", "acme.ghe.com");
    writeHosts(
      "github.com:\n  oauth_token: gho_public\nacme.ghe.com:\n  oauth_token: gho_enterprise\n",
    );

    const result = await fetchQuota(options);

    expect(result.state.status).toBe("fresh");
    const [url, init] = vi.mocked(providerFetch).mock.calls[0];
    expect(url).toBe("https://api.acme.ghe.com/copilot_internal/user");
    expect(JSON.stringify(init)).toContain("gho_enterprise");
    expect(JSON.stringify(init)).not.toContain("gho_public");
  });

  it("accepts an apps.json token recorded for the enterprise host only", async () => {
    vi.stubEnv("QUOTA_AXI_COPILOT_HOST", "acme.ghe.com");
    writeApps({
      "github.com:app": { user: "pub", oauth_token: "gho_public_apps" },
      "acme.ghe.com:app": { user: "ent", oauth_token: "gho_ent_apps" },
    });

    await fetchQuota(options);

    const [url, init] = vi.mocked(providerFetch).mock.calls[0];
    expect(url).toBe("https://api.acme.ghe.com/copilot_internal/user");
    expect(JSON.stringify(init)).toContain("gho_ent_apps");
  });

  it("never sends a github.com apps.json token to the enterprise host", async () => {
    vi.stubEnv("QUOTA_AXI_COPILOT_HOST", "acme.ghe.com");
    writeApps({ "github.com:app": { user: "pub", oauth_token: "gho_public" } });

    await fetchQuota(options);

    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("keeps api.github.com and ignores enterprise tokens without the opt-in", async () => {
    writeHosts("acme.ghe.com:\n  oauth_token: gho_enterprise\n");
    await fetchQuota(options);
    expect(providerFetch).not.toHaveBeenCalled();

    writeHosts("github.com:\n  oauth_token: gho_public\n");
    await fetchQuota(options);
    expect(vi.mocked(providerFetch).mock.calls[0][0]).toBe(
      "https://api.github.com/copilot_internal/user",
    );
  });

  it("falls back to api.github.com when the override is not a ghe.com host", async () => {
    vi.stubEnv("QUOTA_AXI_COPILOT_HOST", "evil.example.com");
    writeHosts(
      "evil.example.com:\n  oauth_token: gho_evil\ngithub.com:\n  oauth_token: gho_public\n",
    );

    await fetchQuota(options);

    const [url, init] = vi.mocked(providerFetch).mock.calls[0];
    expect(url).toBe("https://api.github.com/copilot_internal/user");
    expect(JSON.stringify(init)).not.toContain("gho_evil");
  });

  it("does not send a host-less apps.json token to an enterprise host", async () => {
    vi.stubEnv("QUOTA_AXI_COPILOT_HOST", "acme.ghe.com");
    writeApps({ legacy: { user: "pub", oauth_token: "gho_no_host" } });

    await fetchQuota(options);

    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("still uses a host-less apps.json token for github.com", async () => {
    writeApps({ legacy: { user: "pub", oauth_token: "gho_no_host" } });

    await fetchQuota(options);

    expect(vi.mocked(providerFetch).mock.calls[0][0]).toBe(
      "https://api.github.com/copilot_internal/user",
    );
  });

  describe("cached readings", () => {
    async function cacheReadingFor(host: string | undefined) {
      vi.stubEnv("QUOTA_AXI_COPILOT_HOST", host);
      writeApps({
        "github.com:a": { user: "pub", oauth_token: "gho_public" },
        "acme.ghe.com:a": { user: "ent", oauth_token: "gho_ent" },
      });
      writeCachedProviders([await fetchQuota(options)]);
    }

    async function failingFetchUnder(host: string | undefined) {
      vi.stubEnv("QUOTA_AXI_COPILOT_HOST", host);
      vi.mocked(providerFetch).mockImplementation(
        async () => new Response("boom", { status: 500 }),
      );
      return fetchQuota(options);
    }

    it("never serves a github.com reading as enterprise quota", async () => {
      await cacheReadingFor(undefined);
      const result = await failingFetchUnder("acme.ghe.com");
      expect(result.state.status).not.toBe("stale");
    });

    it("never serves an enterprise reading as github.com quota", async () => {
      await cacheReadingFor("acme.ghe.com");
      const result = await failingFetchUnder(undefined);
      expect(result.state.status).not.toBe("stale");
    });

    it("keys a cached reading to its own host", async () => {
      await cacheReadingFor("acme.ghe.com");
      expect(
        readCachedCopilotProvider(copilotCacheContextId("acme.ghe.com")),
      ).toBeDefined();
      expect(
        readCachedCopilotProvider(copilotCacheContextId("github.com")),
      ).toBeUndefined();
    });
  });
});
