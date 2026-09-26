import { describe, expect, it, vi } from "vitest";
import { resolveCopilotCliCredential } from "../../src/providers/copilot-cli-credential.js";
import type { WindowsCredentialResult } from "../../src/lib/windows-credential.js";

const token = "gho_windows_synthetic_fixture";
const account = "https://github.com:selected-user";
const selected = { host: "https://github.com", login: "selected-user" };
const options = { allowKeychainPrompt: true, refreshCredentials: false };

function fixture() {
  return {
    platform: "win32" as NodeJS.Platform,
    environment: { SystemRoot: "C:\\Windows" } as Record<
      string,
      string | undefined
    >,
    homeDirectory: () => "/synthetic/home",
    readFile: vi.fn(async () =>
      Buffer.from(
        JSON.stringify({
          lastLoggedInUser: selected,
          loggedInUsers: [selected, { ...selected, login: "other-user" }],
          copilotTokens: { [account]: "must-not-read-plaintext" },
        }),
      ),
    ),
    run: vi.fn(),
    readWindows: vi.fn(
      async (): Promise<WindowsCredentialResult> => ({
        status: "resolved",
        value: token,
      }),
    ),
    hasGrant: vi.fn(() => false),
    recordGrant: vi.fn(),
  };
}

describe("Copilot Windows selected secure credential", () => {
  it("reads only the observed selected target and username after opt-in", async () => {
    const deps = fixture();
    const result = await resolveCopilotCliCredential(options, false, deps);
    expect(result).toMatchObject({
      status: "resolved",
      token,
      report: { source: "copilot-cli:keychain", status: "available" },
    });
    expect(deps.readWindows).toHaveBeenCalledExactlyOnceWith(
      { target: `${account}.copilot-cli`, username: account },
      { run: deps.run, systemRoot: "C:\\Windows" },
    );
    expect(deps.readFile).toHaveBeenCalledTimes(2);
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.recordGrant).toHaveBeenCalledWith(
      "/synthetic/home/.copilot/config.json",
      account,
    );
    expect(JSON.stringify(result.report)).not.toContain(token);
  });

  it("never calls CredRead or a process before consent", async () => {
    const deps = fixture();
    expect(
      (
        await resolveCopilotCliCredential(
          { ...options, allowKeychainPrompt: false },
          false,
          deps,
        )
      ).report.error,
    ).toBe("keychain_prompt_required");
    expect(deps.readWindows).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.recordGrant).not.toHaveBeenCalled();
  });

  it("keeps ordinary auth metadata-only even with an existing grant", async () => {
    const deps = fixture();
    deps.hasGrant.mockReturnValue(true);
    expect(
      (await resolveCopilotCliCredential(options, true, deps)).report.error,
    ).toBe("keychain_prompt_required");
    expect(deps.readWindows).not.toHaveBeenCalled();
    expect(deps.hasGrant).not.toHaveBeenCalled();
  });

  it("reuses only the selected account's grant for quota", async () => {
    const deps = fixture();
    deps.hasGrant.mockImplementation(
      (_path, selectedAccount) => selectedAccount === account,
    );
    expect(
      (
        await resolveCopilotCliCredential(
          { ...options, allowKeychainPrompt: false },
          false,
          deps,
        )
      ).status,
    ).toBe("resolved");
    expect(deps.hasGrant).toHaveBeenCalledWith(
      "/synthetic/home/.copilot/config.json",
      account,
    );
    expect(deps.readWindows).toHaveBeenCalledTimes(1);
  });

  it("withholds a value when the selected account changes during the read", async () => {
    const deps = fixture();
    deps.readFile
      .mockResolvedValueOnce(
        Buffer.from(JSON.stringify({ lastLoggedInUser: selected })),
      )
      .mockResolvedValueOnce(
        Buffer.from(
          JSON.stringify({
            lastLoggedInUser: { ...selected, login: "other-user" },
          }),
        ),
      );
    const result = await resolveCopilotCliCredential(options, false, deps);
    expect(result.report.error).toBe("selected_account_changed");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(deps.recordGrant).not.toHaveBeenCalled();
  });

  it.each([
    "credential_not_found",
    "credential_logon_session_unavailable",
    "credential_access_denied",
    "credential_binding_mismatch",
    "credential_format_unsupported",
    "credential_read_timeout",
    "credential_read_failed",
  ] as const)(
    "reports %s without selecting another item or recording a grant",
    async (reason) => {
      const deps = fixture();
      deps.readWindows.mockResolvedValue({ status: "unavailable", reason });
      const result = await resolveCopilotCliCredential(options, false, deps);
      expect(result).toMatchObject({
        status:
          reason === "credential_format_unsupported"
            ? "structurally_invalid"
            : "read_error",
        report: { error: reason, credentialPresent: true },
      });
      expect(deps.readWindows).toHaveBeenCalledTimes(1);
      expect(deps.recordGrant).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(token);
    },
  );

  it.each([
    "",
    '{"token":"gho_not_a_literal"}',
    "ghp_unsupported",
    "gho_valid but extra",
    "gho_" + "a".repeat(17000),
  ])("rejects nonliteral or unsupported tokens", async (value) => {
    const deps = fixture();
    deps.readWindows.mockResolvedValue({ status: "resolved", value });
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).report.error,
    ).toBe("credential_format_unsupported");
    expect(deps.recordGrant).not.toHaveBeenCalled();
  });

  it.each([
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_GH_HOST",
    "GH_HOST",
  ])("refuses %s without exposing its value", async (name) => {
    const deps = fixture();
    deps.environment[name] = "gho_env_synthetic";
    const result = await resolveCopilotCliCredential(options, false, deps);
    expect(result.report.error).toBe("environment_selection_unsupported");
    expect(JSON.stringify(result)).not.toContain("gho_env_synthetic");
    expect(deps.readWindows).not.toHaveBeenCalled();
  });

  it.each([
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_GH_HOST",
    "GH_HOST",
  ])("lets a blank %s select nothing", async (name) => {
    const deps = fixture();
    deps.environment[name] = "";
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).status,
    ).toBe("resolved");
  });

  it("refuses unverified custom homes", async () => {
    const deps = fixture();
    deps.environment.COPILOT_HOME = "/other/home";
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).report.error,
    ).toBe("copilot_home_unsupported");
    expect(deps.readWindows).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { host: "https://enterprise.example", login: "selected-user" },
    { host: "github.com", login: "selected-user" },
    { host: "https://github.com", login: "bad\nlogin" },
  ])("never looks up an unsupported selection", async (identity) => {
    const deps = fixture();
    deps.readFile.mockResolvedValue(
      Buffer.from(JSON.stringify({ lastLoggedInUser: identity })),
    );
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).status,
    ).toBe("unsupported");
    expect(deps.readWindows).not.toHaveBeenCalled();
  });
});
