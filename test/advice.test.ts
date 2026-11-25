import { afterEach, describe, expect, it, vi } from "vitest";
import { annotateQuotaAdvice } from "../src/advice.js";
import type { ProviderQuota } from "../src/types.js";

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

describe("quota schema versions", () => {
  it.each([
    ["single-account CNY wallet", 7, undefined],
    ["account-expanded CNY wallet", 8, "default"],
  ])("versions a %s as the DeepSeek schema", (_label, expected, accountKey) => {
    const response = annotateQuotaAdvice({
      generatedAt: "",
      providers: [
        {
          provider: "deepseek",
          ...(accountKey ? { accountKey } : {}),
          windows: [],
          credits: { remaining: 10, unit: "cny" },
          state: { status: "fresh", stale: false },
        },
      ],
    });

    expect(response.schemaVersion).toBe(expected);
  });

  it("keeps a legacy credits-unit report on the legacy schema", () => {
    const response = annotateQuotaAdvice({
      generatedAt: "",
      providers: [
        {
          provider: "deepseek",
          windows: [],
          credits: { remaining: 10, unit: "credits" },
          state: { status: "fresh", stale: false },
        },
      ],
    });

    expect(response.schemaVersion).toBe(5);
  });
});

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
