import { describe, expect, it } from "vitest";
import { annotateQuotaAdvice } from "../src/advice.js";
import type { ProviderQuota } from "../src/types.js";

function siblingClaudeLane(status: ProviderQuota["state"]["status"]): {
  providers: ProviderQuota[];
} {
  const primary: ProviderQuota = {
    provider: "claude",
    accountKey: "profile:0815bf696589c0b68b8fcb23",
    accountLocator: {
      kind: "config-dir",
      path: "/home/.claude",
      delegateEligible: true,
    },
    windows: [],
    state: { status: "fresh", stale: false },
  };
  const sibling: ProviderQuota = {
    provider: "claude",
    accountKey: "profile:058fe0d1cc643c7a9aff685f",
    accountLocator: {
      kind: "config-dir",
      path: "/home/.claude-teohcapital",
    },
    windows: [],
    state: { status, stale: false, error: "Claude sign-in required" },
  };
  return { providers: [primary, sibling] };
}

describe("Claude sibling-lane re-auth advice", () => {
  it("advises claude doctor for a sibling lane requiring sign-in", () => {
    const annotated = annotateQuotaAdvice(siblingClaudeLane("auth_required"));
    const sibling = annotated.providers[1];

    expect(sibling?.state.reason).toBe("credentials_expired");
    expect(sibling?.state.remedyCommand).toBe(
      "CLAUDE_CONFIG_DIR='/home/.claude-teohcapital' claude doctor",
    );
    expect(annotated.help).toContain(
      "Tell your user: this Claude account (profile:058fe0d1cc643c7a9aff685f) is a sibling lane quota-axi never auto-refreshes, so run `CLAUDE_CONFIG_DIR='/home/.claude-teohcapital' claude doctor` once to have Claude Code rotate its own session.",
    );
  });

  it("does not annotate a healthy sibling lane", () => {
    const annotated = annotateQuotaAdvice(siblingClaudeLane("fresh"));
    const sibling = annotated.providers[1];

    expect(sibling?.state.reason).toBeUndefined();
    expect(sibling?.state.remedyCommand).toBeUndefined();
  });

  it("does not advise a delegate-eligible (process-selected) lane requiring sign-in, since its own read already attempted the delegate", () => {
    const annotated = annotateQuotaAdvice(siblingClaudeLane("auth_required"));
    const primary = annotated.providers[0];

    expect(primary?.state.reason).toBeUndefined();
    expect(primary?.state.remedyCommand).toBeUndefined();
  });

  it("shell-quotes a config directory containing spaces or metacharacters", () => {
    const annotated = annotateQuotaAdvice({
      providers: [
        {
          provider: "claude",
          accountKey: "profile:aaaa",
          accountLocator: {
            kind: "config-dir",
            path: "/Users/jane doe/.claude-work; rm -rf ~",
          },
          windows: [],
          state: {
            status: "auth_required",
            stale: false,
            error: "Claude sign-in required",
          },
        },
      ],
    });

    expect(annotated.providers[0]?.state.remedyCommand).toBe(
      "CLAUDE_CONFIG_DIR='/Users/jane doe/.claude-work; rm -rf ~' claude doctor",
    );
  });

  it("does not annotate a non-sibling (single-lane) Claude report", () => {
    const solo: ProviderQuota = {
      provider: "claude",
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: "Claude sign-in required",
      },
    };
    const annotated = annotateQuotaAdvice({ providers: [solo] });

    expect(annotated.providers[0]?.state.reason).toBeUndefined();
    expect(annotated.providers[0]?.state.remedyCommand).toBeUndefined();
  });
});
