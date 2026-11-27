import { afterEach, describe, expect, it, vi } from "vitest";
import { annotateQuotaAdvice, authHelpLines } from "../src/advice.js";
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

function codexLane(
  accountKey: string,
  state: Partial<ProviderQuota["state"]>,
  attempts: SourceAttempt[],
  provider: ProviderQuota["provider"] = "codex",
): ProviderQuota {
  return {
    provider,
    accountKey,
    accountKeys: [accountKey],
    source: `pi:${accountKey}`,
    windows: [],
    state: { status: "unavailable", stale: false, ...state },
    attempts,
  };
}

function unmeasuredChatGpt(entry: string): SourceAttempt {
  return {
    source: `pi:${entry}`,
    status: "skipped",
    error: "pi_openai_chatgpt_token_unmeasured",
    credentialPresent: true,
  };
}

const CODEX_SIGN_IN_HELP_FOR_OPENAI =
  'Tell your user: Pi\'s `openai` entry is a "Sign in with ChatGPT" token for the OpenAI API, which the Codex usage endpoint does not accept, so quota-axi cannot measure it. To see Codex quota, sign in to Codex itself: run `codex login` for the Codex CLI, or run `/login` inside `pi` and pick `openai-codex`. quota-axi measures both and never signs in for you.';

describe("Codex ChatGPT sign-in lane advice", () => {
  it("names the Codex sign-in in the reason, the remedy, and one help line", () => {
    const advised = annotateQuotaAdvice({
      generatedAt: "",
      providers: [
        codexLane("openai", { error: "pi_openai_chatgpt_token_unmeasured" }, [
          unmeasuredChatGpt("openai"),
        ]),
      ],
    });

    expect(advised.providers[0]?.state).toMatchObject({
      status: "unavailable",
      error: "pi_openai_chatgpt_token_unmeasured",
      reason: "codex_sign_in_required",
      remedyCommand: "codex login",
    });
    expect(advised.help).toEqual([CODEX_SIGN_IN_HELP_FOR_OPENAI]);
  });

  it("names each sibling sign-in entry in its own help line", () => {
    const advised = annotateQuotaAdvice({
      generatedAt: "",
      providers: [
        codexLane("openai", {}, [unmeasuredChatGpt("openai")]),
        codexLane("openai-work", {}, [unmeasuredChatGpt("openai-work")]),
      ],
    });

    expect(
      advised.providers.map((provider) => provider.state.remedyCommand),
    ).toEqual(["codex login", "codex login"]);
    expect(advised.help).toEqual([
      CODEX_SIGN_IN_HELP_FOR_OPENAI,
      CODEX_SIGN_IN_HELP_FOR_OPENAI.replace(
        "`openai` entry",
        "`openai-work` entry",
      ),
    ]);
  });

  it("gives the reason to no other provider, status, or attempt", () => {
    const advise = (provider: ProviderQuota) => {
      const advised = annotateQuotaAdvice({
        generatedAt: "",
        providers: [provider],
      });
      return [
        advised.providers[0]?.state.reason,
        advised.providers[0]?.state.remedyCommand,
        advised.help,
      ];
    };
    const none = [undefined, undefined, undefined];

    expect(
      advise(
        codexLane("openai", { status: "fresh" }, [unmeasuredChatGpt("openai")]),
      ),
    ).toEqual(none);
    expect(
      advise(
        codexLane("openai-codex", {}, [
          {
            source: "pi:openai-codex",
            status: "skipped",
            error: "credentials_missing",
          },
        ]),
      ),
    ).toEqual(none);
    expect(
      advise(
        codexLane("openai", {}, [
          {
            source: "pi:openai",
            status: "failed",
            error: "pi_openai_chatgpt_token_unmeasured",
          },
        ]),
      ),
    ).toEqual(none);
    expect(
      advise(codexLane("openai", {}, [unmeasuredChatGpt("openai")], "zai")),
    ).toEqual(none);
    expect(advise(codexLane("openai", {}, []))).toEqual(none);
  });

  it("prints the same hint once per skipped sign-in under quota-axi auth", () => {
    expect(
      authHelpLines([
        {
          provider: "codex",
          accountKey: "openai-codex",
          sources: [{ source: "pi:openai-codex", status: "available" }],
        },
        {
          provider: "codex",
          accountKey: "openai",
          sources: [
            {
              source: "pi:openai",
              status: "skipped",
              error: "pi_openai_chatgpt_token_unmeasured",
            },
          ],
        },
        {
          provider: "codex",
          accountKey: "openai",
          sources: [
            {
              source: "pi:openai",
              status: "skipped",
              error: "pi_openai_chatgpt_token_unmeasured",
            },
          ],
        },
      ]),
    ).toEqual([CODEX_SIGN_IN_HELP_FOR_OPENAI]);
    expect(
      authHelpLines([
        {
          provider: "codex",
          sources: [
            {
              source: "pi:openai",
              status: "invalid",
              error: "invalid_credential",
            },
          ],
        },
      ]),
    ).toEqual([]);
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
