import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuota, inspectAuth } from "../../src/providers/copilot.js";
import {
  resolveCopilotCliCredential,
  COPILOT_CLI_SOURCE,
} from "../../src/providers/copilot-cli-credential.js";
import { resolveGhCliCredential } from "../../src/providers/gh-cli-credential.js";
import { readBoundedFile, readJsonFileResult } from "../../src/lib/fs.js";
import { providerFetch } from "../../src/lib/http.js";
import { readCachedProvider } from "../../src/cache.js";
import { degradedSources } from "../../src/lib/source-attempts.js";
vi.mock("../../src/providers/copilot-cli-credential.js", async (actual) => ({
  ...(await actual<
    typeof import("../../src/providers/copilot-cli-credential.js")
  >()),
  COPILOT_CLI_SOURCE: "copilot-cli:keychain",
  resolveCopilotCliCredential: vi.fn(),
}));
vi.mock("../../src/providers/gh-cli-credential.js", () => ({
  GH_CLI_CREDENTIAL_SOURCE: "gh:hosts.yml",
  resolveGhCliCredential: vi.fn(),
}));
vi.mock("../../src/lib/http.js", () => ({ providerFetch: vi.fn() }));
vi.mock("../../src/cache.js", () => ({ readCachedProvider: vi.fn() }));
vi.mock("../../src/lib/fs.js", async (actual) => ({
  ...(await actual<typeof import("../../src/lib/fs.js")>()),
  readJsonFileResult: vi.fn(),
  readBoundedFile: vi.fn(),
}));
const options = { allowKeychainPrompt: false, refreshCredentials: false };
const nativeToken = "gho_native_synthetic";
const body = {
  copilot_plan: "individual",
  quota_snapshots: { chat: { percent_remaining: 80 } },
};
function response(status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}
const selectedAccountConfig = Buffer.from(
  JSON.stringify({
    lastLoggedInUser: { host: "https://github.com", login: "octocat" },
  }),
);
function nativeUnavailable(error: string, credentialPresent = true) {
  vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
    status: "unsupported",
    silent: [
      "secure_store_unsupported",
      "keychain_prompt_required",
      "selected_account_unconfirmed",
    ].includes(error),
    report: {
      source: COPILOT_CLI_SOURCE,
      status: "skipped",
      error,
      ...(credentialPresent ? { credentialPresent: true } : {}),
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COPILOT_HOME", "/synthetic/copilot");
  vi.mocked(readBoundedFile).mockResolvedValue(selectedAccountConfig);
  vi.mocked(readJsonFileResult).mockReturnValue({ status: "missing" });
  vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
    status: "resolved",
    token: nativeToken,
    silent: false,
    report: { source: COPILOT_CLI_SOURCE, status: "available" },
  });
  vi.mocked(resolveGhCliCredential).mockResolvedValue({
    status: "resolved",
    path: "/synthetic/gh/hosts.yml",
    token: "gho_gh_synthetic",
  });
  vi.mocked(providerFetch).mockImplementation(async () => response());
  vi.mocked(readCachedProvider).mockReturnValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("Copilot secure-source integration", () => {
  it.each([
    ["selects an account", false],
    ["selects no account", true],
    ["absent", true],
    ["unreadable", false],
  ] as const)(
    "allows legacy cache after apps transport failure only when the native source could not have answered: %s",
    async (config, stale) => {
      vi.mocked(readJsonFileResult).mockReturnValue({
        status: "success",
        value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
      });
      const cached = await fetchQuota(options);
      vi.mocked(readCachedProvider).mockReturnValue(cached);
      vi.mocked(readBoundedFile).mockClear();
      if (config === "selects an account")
        vi.mocked(readBoundedFile).mockResolvedValue(selectedAccountConfig);
      else if (config === "selects no account")
        vi.mocked(readBoundedFile).mockResolvedValue(
          Buffer.from(JSON.stringify({ theme: "dark" })),
        );
      else
        vi.mocked(readBoundedFile).mockRejectedValue(
          Object.assign(new Error(), {
            code: config === "absent" ? "ENOENT" : "EACCES",
          }),
        );
      vi.mocked(providerFetch)
        .mockClear()
        .mockRejectedValue(new Error("network failed"));
      if (config === "selects no account")
        nativeUnavailable("selected_account_unconfirmed", false);
      else if (config === "absent")
        vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
          status: "absent",
          silent: true,
          report: { source: COPILOT_CLI_SOURCE, status: "missing" },
        });
      else if (config === "unreadable")
        vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
          status: "read_error",
          silent: false,
          report: {
            source: COPILOT_CLI_SOURCE,
            status: "error",
            error: "file_read_error",
          },
        });
      const result = await fetchQuota(options);
      expect(result.state.stale).toBe(stale);
      expect(result.windows).toEqual(stale ? cached.windows : []);
      expect(readBoundedFile).not.toHaveBeenCalled();
      expect(providerFetch).toHaveBeenCalledOnce();
      expect(resolveCopilotCliCredential).toHaveBeenCalledOnce();
      expect(resolveGhCliCredential).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy cache after apps transport failure on a platform with no secure store", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    const cached = await fetchQuota(options);
    vi.mocked(readCachedProvider).mockReturnValue(cached);
    vi.mocked(providerFetch)
      .mockClear()
      .mockRejectedValue(new Error("network failed"));
    nativeUnavailable("secure_store_unsupported");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      const result = await fetchQuota(options);
      expect(result.state.stale).toBe(true);
      expect(result.windows).toEqual(cached.windows);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(resolveCopilotCliCredential).toHaveBeenCalledOnce();
  });

  it("keeps a sibling gh rejection from speaking for the native store", async () => {
    nativeUnavailable("environment_selection_unsupported");
    vi.mocked(providerFetch).mockResolvedValue(response(403));
    const result = await fetchQuota(options);
    expect(result.state).toMatchObject({
      status: "unavailable",
      error: "environment_selection_unsupported",
    });
  });

  it("keeps sign-in required when no secure store could ever answer", async () => {
    nativeUnavailable("secure_store_unsupported");
    vi.mocked(providerFetch).mockResolvedValue(response(403));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      expect((await fetchQuota(options)).state).toMatchObject({
        status: "auth_required",
        error: "GitHub Copilot sign-in required",
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("keeps sign-in required when the native config selects no account", async () => {
    nativeUnavailable("selected_account_unconfirmed");
    vi.mocked(readBoundedFile).mockResolvedValue(
      Buffer.from(JSON.stringify({ theme: "dark" })),
    );
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    expect((await fetchQuota(options)).state).toMatchObject({
      status: "auth_required",
      error: "GitHub Copilot sign-in required",
    });
  });

  it.each([
    "secure_store_unsupported",
    "keychain_prompt_required",
    "selected_account_unconfirmed",
  ])(
    "does not call a structural native non-answer degraded: %s",
    async (reason) => {
      nativeUnavailable(reason, reason !== "selected_account_unconfirmed");
      const result = await fetchQuota(options);
      expect(result.state.status).toBe("fresh");
      expect(degradedSources(result.attempts)).toEqual([]);
    },
  );

  it("names a broken native store as degraded when a sibling answers", async () => {
    vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
      status: "read_error",
      silent: false,
      report: {
        source: COPILOT_CLI_SOURCE,
        status: "error",
        error: "keychain_item_unavailable",
        credentialPresent: true,
      },
    });
    const result = await fetchQuota(options);
    expect(result.state.status).toBe("fresh");
    expect(degradedSources(result.attempts)).toEqual([
      { source: COPILOT_CLI_SOURCE, error: "keychain_item_unavailable" },
    ]);
  });

  it("keeps apps precedence and never even resolves the secure source when apps works", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(resolveCopilotCliCredential).not.toHaveBeenCalled();
    expect(resolveGhCliCredential).not.toHaveBeenCalled();
  });
  it("hands rejected apps to native and rejected native to gh in order", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    vi.mocked(providerFetch)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response());
    const result = await fetchQuota(options);
    expect(result.state.status).toBe("fresh");
    expect(result.attempts?.map((a) => a.source)).toEqual([
      "api",
      COPILOT_CLI_SOURCE,
      "gh:hosts.yml",
    ]);
    expect(
      vi
        .mocked(providerFetch)
        .mock.calls.map((c) => new Headers(c[1]?.headers).get("authorization")),
    ).toEqual([
      "Bearer gho_apps_synthetic",
      `Bearer ${nativeToken}`,
      "Bearer gho_gh_synthetic",
    ]);
    expect(JSON.stringify(result)).not.toContain(nativeToken);
  });
  it("reports native provenance and numeric quota, with no redirects", async () => {
    const result = await fetchQuota(options);
    expect(result).toMatchObject({
      source: "cli",
      windows: [{ id: "chat", percentRemaining: 80 }],
    });
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/user",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(resolveGhCliCredential).not.toHaveBeenCalled();
  });
  it("still reports sign-in required when every source is rejected", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    vi.mocked(providerFetch).mockResolvedValue(response(401));
    const result = await fetchQuota(options);
    expect(result.state).toMatchObject({
      status: "auth_required",
      error: "GitHub Copilot sign-in required",
    });
  });

  it("preserves a native local failure after a rejected apps token", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    nativeUnavailable("keychain_item_unavailable");
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    vi.mocked(providerFetch).mockResolvedValue(response(401));

    expect((await fetchQuota(options)).state).toMatchObject({
      status: "unavailable",
      error: "keychain_item_unavailable",
    });
  });

  it("still reports sign-in required when the native platform has no secure store", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    nativeUnavailable("secure_store_unsupported");
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    vi.mocked(providerFetch).mockResolvedValue(response(401));
    expect((await fetchQuota(options)).state).toMatchObject({
      status: "auth_required",
      error: "GitHub Copilot sign-in required",
    });
  });

  it("withholds a legacy snapshot when the native source still names an account", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    const cached = await fetchQuota(options);
    vi.mocked(readJsonFileResult).mockReturnValue({ status: "missing" });
    vi.mocked(readCachedProvider).mockReturnValue(cached);
    nativeUnavailable("keychain_prompt_required");
    vi.mocked(providerFetch).mockClear().mockResolvedValue(response(500));
    const result = await fetchQuota(options);
    expect(result.state.stale).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.state.reason).toBe("keychain_access_required");
  });

  it("keeps legacy stale cache when the platform has no native secure store", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    const cached = await fetchQuota(options);
    vi.mocked(readJsonFileResult).mockReturnValue({ status: "missing" });
    vi.mocked(readCachedProvider).mockReturnValue(cached);
    nativeUnavailable("secure_store_unsupported");
    vi.mocked(providerFetch).mockClear().mockResolvedValue(response(500));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      const result = await fetchQuota(options);
      expect(result.state.stale).toBe(true);
      expect(result.windows).toEqual(cached.windows);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("keeps entitlement without numeric quota distinct from source failure", async () => {
    vi.mocked(providerFetch).mockResolvedValue(
      new Response(JSON.stringify({ copilot_plan: "individual" })),
    );
    expect(await fetchQuota(options)).toMatchObject({
      windows: [],
      state: { status: "fresh" },
    });
  });
  it.each([
    [401, undefined],
    [403, undefined],
  ] as const)(
    "hands native HTTP %s rejection to gh without assuming entitlement",
    async (status) => {
      vi.mocked(providerFetch).mockResolvedValueOnce(response(status));
      expect((await fetchQuota(options)).state.status).toBe("fresh");
      expect(resolveGhCliCredential).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [429, {}, "rate_limited"],
    [500, {}, "error"],
  ] as const)("stops on native HTTP %s", async (status, headers, expected) => {
    vi.mocked(providerFetch).mockResolvedValueOnce(response(status, headers));
    expect((await fetchQuota(options)).state.status).toBe(expected);
    expect(resolveGhCliCredential).not.toHaveBeenCalled();
  });
  it.each(["network", "decode"])(
    "sanitizes %s failure and stops handover",
    async (kind) => {
      if (kind === "network")
        vi.mocked(providerFetch).mockRejectedValueOnce(new Error(nativeToken));
      else
        vi.mocked(providerFetch).mockResolvedValueOnce(
          new Response(nativeToken),
        );
      const result = await fetchQuota(options);
      expect(result.state.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain(nativeToken);
      expect(resolveGhCliCredential).not.toHaveBeenCalled();
    },
  );
  it.each([
    "copilot_home_unsupported",
    "keychain_access_denied",
    "keychain_prompt_timeout",
    "keychain_item_unavailable",
    "credential_not_found",
    "credential_logon_session_unavailable",
    "credential_access_denied",
    "credential_binding_mismatch",
    "credential_format_unsupported",
    "credential_read_timeout",
    "credential_read_failed",
  ])("does not call an unmeasured source a sign-out: %s", async (reason) => {
    nativeUnavailable(reason);
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    const result = await fetchQuota(options);
    expect(result.state).toMatchObject({
      status: "unavailable",
      error: reason,
    });
    expect(result.state.remedyCommand).toBeUndefined();
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("offers a prompt remedy only for a prompt-gated item", async () => {
    nativeUnavailable("keychain_prompt_required");
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    expect((await fetchQuota(options)).state).toMatchObject({
      status: "unavailable",
      error: "keychain_prompt_required",
      reason: "keychain_access_required",
    });
    await inspectAuth(options);
    expect(resolveCopilotCliCredential).toHaveBeenLastCalledWith(options, true);
  });
  it("does not reuse a native account's cache after source or account change", async () => {
    const cached = await fetchQuota(options);
    vi.mocked(readCachedProvider).mockReturnValue(cached);
    vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
      status: "absent",
      silent: true,
      report: { source: COPILOT_CLI_SOURCE, status: "missing" },
    });
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    expect((await fetchQuota(options)).state.stale).toBe(false);
    nativeUnavailable("selected_account_changed");
    expect((await fetchQuota(options)).state.status).toBe("unavailable");
  });
});
