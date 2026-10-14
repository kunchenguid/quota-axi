import { afterEach, describe, expect, it, vi } from "vitest";
import { annotateQuotaAdvice } from "../src/advice.js";
import type { ProviderQuota, SourceAttempt } from "../src/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function claudeLane(
  locator: ProviderQuota["accountLocator"],
  state: Partial<ProviderQuota["state"]>,
): ProviderQuota {
  return {
    provider: "claude",
    accountKey: "profile:aaaaaaaaaaaaaaaaaaaaaaaa",
    ...(locator ? { accountLocator: locator } : {}),
    windows: [],
    state: { status: "unavailable", stale: false, ...state },
  };
}

const expiredRefreshable = {
  status: "unavailable" as const,
  error: "Claude access token expired",
  authStatus: "expired_refreshable" as const,
};

function remedy(provider: ProviderQuota): string | undefined {
  return annotateQuotaAdvice({ generatedAt: "", providers: [provider] })
    .providers[0]?.state.remedyCommand;
}

describe("Claude sibling profile lane advice", () => {
  it("shell-quotes a config directory with spaces or metacharacters", () => {
    expect(
      remedy(
        claudeLane(
          {
            kind: "config-dir",
            path: "/Users/jane doe/.claude-work'; rm -rf ~",
            delegateEligible: false,
          },
          expiredRefreshable,
        ),
      ),
    ).toBe(
      `CLAUDE_CONFIG_DIR='/Users/jane doe/.claude-work'\\''; rm -rf ~' claude doctor`,
    );
  });

  it("selects the default profile by unsetting CLAUDE_CONFIG_DIR", () => {
    expect(
      remedy(
        claudeLane(
          {
            kind: "config-dir",
            path: "/Users/jane/.claude",
            keychainService: "Claude Code-credentials",
            delegateEligible: false,
          },
          expiredRefreshable,
        ),
      ),
    ).toBe("env -u CLAUDE_CONFIG_DIR claude doctor");
  });

  it("unsets a secure-storage selector that would override the profile", () => {
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/elsewhere");
    expect(
      remedy(
        claudeLane(
          {
            kind: "config-dir",
            path: "/Users/jane/.claude-work",
            keychainService: "Claude Code-credentials-0123abcd",
            delegateEligible: false,
          },
          expiredRefreshable,
        ),
      ),
    ).toBe(
      "env -u CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CONFIG_DIR='/Users/jane/.claude-work' claude doctor",
    );
  });

  it("leaves the selected lane, a sign-out, and a healthy lane to the existing advice", () => {
    const sibling = {
      kind: "config-dir",
      path: "/Users/jane/.claude-work",
      delegateEligible: false,
    };
    expect(
      remedy(
        claudeLane({ ...sibling, delegateEligible: true }, expiredRefreshable),
      ),
    ).toBeUndefined();
    expect(
      remedy(
        claudeLane(sibling, {
          status: "auth_required",
          error: "Claude sign-in required",
          authStatus: "unusable",
        }),
      ),
    ).toBeUndefined();
    expect(
      remedy(claudeLane(sibling, { status: "fresh", authStatus: "usable" })),
    ).toBeUndefined();
    expect(remedy(claudeLane(undefined, expiredRefreshable))).toBeUndefined();
  });
});

describe("OpenCode Go Pi opt-in advice", () => {
  const skippedPi: SourceAttempt = {
    source: "pi:opencode-go",
    status: "skipped",
    error: "opencode_go_pi_opt_in_required",
    credentialPresent: true,
  };
  function lane(
    provider: ProviderQuota["provider"],
    status: ProviderQuota["state"]["status"],
    attempts: SourceAttempt[] = [skippedPi],
  ): ProviderQuota {
    return {
      provider,
      windows: [],
      state: {
        status,
        stale: false,
        error: "opencode_go_credential_unavailable",
      },
      attempts,
    };
  }

  it.each(["linux", "darwin"] as const)(
    "names the flag in the reason, a POSIX remedy, and one help line on %s",
    (platform) => {
      const advised = annotateQuotaAdvice(
        { generatedAt: "", providers: [lane("opencode-go", "auth_required")] },
        platform,
      );
      expect(advised.providers[0]?.state).toMatchObject({
        status: "auth_required",
        reason: "opencode_go_pi_opt_in_required",
        remedyCommand:
          "QUOTA_AXI_OPENCODE_GO_PI_AUTH=1 quota-axi --provider opencode-go",
      });
      expect(advised.help).toEqual([
        "Tell your user: Pi holds an OpenCode Go key that quota-axi reads only on opt-in, and the opencode store has none. Run `QUOTA_AXI_OPENCODE_GO_PI_AUTH=1 quota-axi --provider opencode-go` to read it, or export QUOTA_AXI_OPENCODE_GO_PI_AUTH=1 for every read. quota-axi never launches Pi or opencode and never copies the key.",
      ]);
    },
  );

  it("names the PowerShell remedy and the cmd.exe form on win32", () => {
    const advised = annotateQuotaAdvice(
      { generatedAt: "", providers: [lane("opencode-go", "auth_required")] },
      "win32",
    );
    expect(advised.providers[0]?.state).toMatchObject({
      status: "auth_required",
      reason: "opencode_go_pi_opt_in_required",
      remedyCommand:
        "$env:QUOTA_AXI_OPENCODE_GO_PI_AUTH='1'; quota-axi --provider opencode-go",
    });
    expect(advised.help).toEqual([
      "Tell your user: Pi holds an OpenCode Go key that quota-axi reads only on opt-in, and the opencode store has none. Run `$env:QUOTA_AXI_OPENCODE_GO_PI_AUTH='1'; quota-axi --provider opencode-go` to read it, or set it for every read in PowerShell with `$env:QUOTA_AXI_OPENCODE_GO_PI_AUTH='1'` or in cmd.exe with `set QUOTA_AXI_OPENCODE_GO_PI_AUTH=1`. quota-axi never launches Pi or opencode and never copies the key.",
    ]);
  });

  it("gives the reason to no other provider, status, or attempt shape", () => {
    const reasons = (provider: ProviderQuota) => {
      const advised = annotateQuotaAdvice({
        generatedAt: "",
        providers: [provider],
      });
      return [advised.providers[0]?.state.reason, advised.help];
    };
    expect(reasons(lane("zai", "auth_required"))).toEqual([
      undefined,
      undefined,
    ]);
    expect(reasons(lane("opencode-go", "error"))).toEqual([
      undefined,
      undefined,
    ]);
    expect(
      reasons(
        lane("opencode-go", "auth_required", [
          { ...skippedPi, error: "opencode_go_credential_unavailable" },
        ]),
      ),
    ).toEqual([undefined, undefined]);
    expect(reasons(lane("opencode-go", "auth_required", []))).toEqual([
      undefined,
      undefined,
    ]);
  });
});
