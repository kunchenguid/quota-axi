import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCopilotCliCredential } from "../../src/providers/copilot-cli-credential.js";
import { copilotCliKeychainAccessMarkerPath } from "../../src/lib/fs.js";

const options = { allowKeychainPrompt: true, refreshCredentials: false };
const token = "gho_synthetic_fixture";
const selected = { host: "https://github.com", login: "selected-user" };
function fixture(data: unknown = { lastLoggedInUser: selected }) {
  return {
    environment: {} as Record<string, string | undefined>,
    platform: "darwin" as NodeJS.Platform,
    homeDirectory: () => "/synthetic/home",
    readFile: vi.fn(async () => Buffer.from(JSON.stringify(data))),
    run: vi.fn(async () => token + "\n"),
    hasGrant: vi.fn(() => false),
    recordGrant: vi.fn(),
  };
}

// Coverage adapted from adibirzu's Copilot proposal (MIT):
// https://github.com/kunchenguid/quota-axi/pull/50
// Retains bounded/malformed config, full-line comments/URLs and selected-account
// cases, replacing its first-public-account fallback with exact selection.
describe("Copilot CLI selected Keychain item", () => {
  it("reads only the selected public user despite a second public user", async () => {
    const deps = fixture({
      lastLoggedInUser: selected,
      loggedInUsers: [selected, { ...selected, login: "other-user" }],
      copilotTokens: { "https://github.com:other-user": "must-not-use" },
    });
    const result = await resolveCopilotCliCredential(options, false, deps);
    expect(result).toMatchObject({ status: "resolved", token });
    expect(deps.run).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        "copilot-cli",
        "-a",
        "https://github.com:selected-user",
        "-w",
      ],
      60_000,
      16 * 1024,
    );
    expect(deps.recordGrant).toHaveBeenCalledWith(
      "/synthetic/home/.copilot/config.json",
      "https://github.com:selected-user",
    );
    expect(JSON.stringify(result.report)).not.toContain(token);
  });
  it("persists only a private non-secret grant, never the token or raw identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "copilot-grant-synthetic-"));
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = root;
    try {
      const deps: Partial<ReturnType<typeof fixture>> = fixture();
      delete deps.recordGrant;
      expect(
        (await resolveCopilotCliCredential(options, false, deps)).status,
      ).toBe("resolved");
      const files = readdirSync(join(root, "quota-axi"));
      expect(files).toHaveLength(1);
      const file = join(root, "quota-axi", files[0]);
      expect(readFileSync(file, "utf8")).toBe("granted\n");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(files[0]).not.toContain("selected-user");
      expect(files[0]).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves https URLs while removing full-line comments", async () => {
    const deps = fixture();
    deps.readFile.mockResolvedValue(
      Buffer.from(
        "// comment\n" + JSON.stringify({ lastLoggedInUser: selected }),
      ),
    );
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).status,
    ).toBe("resolved");
  });
  it.each([
    {},
    { lastLoggedInUser: null },
    { lastLoggedInUser: { host: "https://github.com" } },
  ])("does not fall back to an unselected user: %j", async (data) => {
    const deps = fixture({
      ...data,
      copilotTokens: { "https://github.com:other-user": token },
    });
    const report = (await resolveCopilotCliCredential(options, false, deps))
      .report;
    expect(report.error).toBe("selected_account_unconfirmed");
    expect(report.credentialPresent).toBeUndefined();
    expect(deps.run).not.toHaveBeenCalled();
  });
  it.each([
    "https://enterprise.example.test",
    "github.com",
    "https://GITHUB.COM",
    "https://github.com/",
    "https://github.com:443",
    "https://github.com@evil.example.test",
  ])("refuses unsupported host spelling %s without a lookup", async (host) => {
    const deps = fixture({ lastLoggedInUser: { ...selected, host } });
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).report.error,
    ).toBe("selected_host_unsupported");
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("does not substitute another item after stale selection cannot be reached", async () => {
    const deps = fixture();
    deps.run.mockRejectedValue({ code: 44 });
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).report.error,
    ).toBe("keychain_item_unavailable");
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.recordGrant).not.toHaveBeenCalled();
  });
  it("requires a fresh grant after an account switch and withholds an in-flight old value", async () => {
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
    const marker = copilotCliKeychainAccessMarkerPath(
      "/one/config.json",
      "copilot-cli",
      "https://github.com:selected-user",
    );
    expect(marker).not.toBe(
      copilotCliKeychainAccessMarkerPath(
        "/one/config.json",
        "copilot-cli",
        "https://github.com:other-user",
      ),
    );
    expect(marker).not.toBe(
      copilotCliKeychainAccessMarkerPath(
        "/two/config.json",
        "copilot-cli",
        "https://github.com:selected-user",
      ),
    );
    expect(marker).not.toContain("selected-user");
  });
  it("honors COPILOT_HOME for discovery but refuses unverified custom-home binding", async () => {
    const deps = fixture();
    deps.environment.COPILOT_HOME = "/custom";
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).report.error,
    ).toBe("copilot_home_unsupported");
    expect(deps.readFile).toHaveBeenCalledWith(
      "/custom/config.json",
      1024 * 1024,
    );
    expect(deps.run).not.toHaveBeenCalled();
  });
  it.each(["linux"] as const)(
    "explicitly reports unsupported %s secure storage",
    async (platform) => {
      const deps = fixture();
      deps.platform = platform;
      expect(
        (await resolveCopilotCliCredential(options, false, deps)).report.error,
      ).toBe("secure_store_unsupported");
      expect(deps.run).not.toHaveBeenCalled();
    },
  );
  it.each([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GH_HOST",
    "COPILOT_GH_HOST",
  ])(
    "refuses environment selector %s without exposing its value",
    async (name) => {
      const deps = fixture();
      deps.environment[name] = "gho_env_synthetic";
      const result = await resolveCopilotCliCredential(options, false, deps);
      expect(result.report.error).toBe("environment_selection_unsupported");
      expect(JSON.stringify(result)).not.toContain("gho_env_synthetic");
      expect(deps.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GH_HOST",
    "COPILOT_GH_HOST",
  ])(
    "lets a blank %s select nothing and keeps the stored path",
    async (name) => {
      const deps = fixture();
      deps.environment[name] = "";
      expect(
        (await resolveCopilotCliCredential(options, false, deps)).status,
      ).toBe("resolved");
    },
  );
  it("does metadata only on a plain call and ordinary auth even with a marker", async () => {
    const deps = fixture();
    const result = await resolveCopilotCliCredential(
      { ...options, allowKeychainPrompt: false },
      false,
      deps,
    );
    expect(result.report.error).toBe("keychain_prompt_required");
    expect(deps.run.mock.calls[0][1]).not.toContain("-w");
    expect(deps.recordGrant).not.toHaveBeenCalled();
    deps.hasGrant.mockReturnValue(true);
    deps.run.mockClear();
    await resolveCopilotCliCredential(options, true, deps);
    expect(deps.run.mock.calls[0][1]).not.toContain("-w");
  });
  it("reuses a scoped grant for quota only", async () => {
    const deps = fixture();
    deps.hasGrant.mockReturnValue(true);
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
      "https://github.com:selected-user",
    );
  });
  it.each([
    [{ code: 36 }, "keychain_access_denied"],
    [{ killed: true }, "keychain_prompt_timeout"],
    [
      { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      "credential_format_unsupported",
    ],
    [{ code: 44 }, "keychain_item_unavailable"],
  ])("sanitizes Keychain failure %j", async (error, reason) => {
    const deps = fixture();
    deps.run.mockRejectedValue({
      ...(error as object),
      message: token,
      stdout: token,
      stderr: token,
    });
    const result = await resolveCopilotCliCredential(options, false, deps);
    expect(result.report.error).toBe(reason);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(deps.recordGrant).not.toHaveBeenCalled();
  });
  it.each([
    "",
    '{"token":"secret"}',
    "gho_token\nextra",
    "gho_" + "a".repeat(17000),
  ])("rejects unsupported value shape without a marker", async (value) => {
    const deps = fixture();
    deps.run.mockResolvedValue(value);
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).report.error,
    ).toBe("credential_format_unsupported");
    expect(deps.recordGrant).not.toHaveBeenCalled();
  });
  it.each([
    ["ENOENT", "absent"],
    ["EACCES", "read_error"],
  ])("classifies file failure %s", async (code, status) => {
    const deps = fixture();
    deps.readFile.mockRejectedValue({ code });
    expect(
      (await resolveCopilotCliCredential(options, false, deps)).status,
    ).toBe(status);
    expect(deps.run).not.toHaveBeenCalled();
  });
  it.each([Buffer.from("{invalid"), Buffer.alloc(1024 * 1024 + 1)])(
    "refuses malformed/oversized config",
    async (value) => {
      const deps = fixture();
      deps.readFile.mockResolvedValue(value);
      expect(
        (await resolveCopilotCliCredential(options, false, deps)).status,
      ).toBe("structurally_invalid");
      expect(deps.run).not.toHaveBeenCalled();
    },
  );
});
