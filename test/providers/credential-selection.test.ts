import { describe, expect, it, vi } from "vitest";
import {
  selectCredential,
  type AttemptOutcome,
  type CredentialCandidate,
} from "../../src/providers/credential-selection.js";

type Token = { token: string };

function candidate(
  source: string,
  localState: "valid" | "expired",
  token: string,
  refreshable?: boolean,
): CredentialCandidate<Token> {
  return {
    source,
    localState,
    credential: { token },
    ...(refreshable !== undefined ? { refreshable } : {}),
  };
}

function outcomes(
  map: Record<string, AttemptOutcome<string>>,
): (candidate: CredentialCandidate<Token>) => Promise<AttemptOutcome<string>> {
  return async (attempted) => {
    const outcome = map[attempted.source];
    if (!outcome) throw new Error(`unexpected attempt: ${attempted.source}`);
    return outcome;
  };
}

describe("shared credential selection", () => {
  it("probes a stored-expired credential and picks it when it is empirically live", async () => {
    const attempt = vi.fn(
      outcomes({
        primary: { kind: "rejected", error: "unauthorized" },
        secondary: { kind: "quota", result: "fresh-data" },
      }),
    );

    const selection = await selectCredential(
      [
        candidate("primary", "valid", "primary-token-fixture"),
        candidate("secondary", "expired", "expired-token-fixture", true),
      ],
      attempt,
    );

    expect(selection.outcome).toBe("quota");
    expect(selection.result).toBe("fresh-data");
    expect(selection.winner).toEqual({
      source: "secondary",
      localState: "expired",
      refreshable: true,
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(selection.results).toEqual([
      {
        source: "primary",
        localState: "valid",
        outcome: "rejected",
        error: "unauthorized",
      },
      {
        source: "secondary",
        localState: "expired",
        refreshable: true,
        outcome: "quota",
      },
    ]);
  });

  it("tries stored-valid candidates before stored-expired ones regardless of declaration order", async () => {
    const tried: string[] = [];
    const selection = await selectCredential(
      [
        candidate("expired-first", "expired", "expired-token-fixture"),
        candidate("valid-second", "valid", "valid-token-fixture"),
      ],
      async (attempted) => {
        tried.push(attempted.source);
        return attempted.source === "valid-second"
          ? { kind: "quota", result: "fresh-data" }
          : { kind: "rejected", error: "unauthorized" };
      },
    );

    expect(tried).toEqual(["valid-second"]);
    expect(selection.outcome).toBe("quota");
    expect(selection.results).toEqual([
      { source: "valid-second", localState: "valid", outcome: "quota" },
      {
        source: "expired-first",
        localState: "expired",
        outcome: "not_tried",
      },
    ]);
  });

  it("reports all-rejected with refresh-path preservation when every credential is empirically dead", async () => {
    const selection = await selectCredential(
      [
        candidate("primary", "expired", "expired-token-fixture", true),
        candidate("secondary", "expired", "other-token-fixture", false),
      ],
      outcomes({
        primary: { kind: "rejected", error: "unauthorized" },
        secondary: { kind: "rejected", error: "unauthorized" },
      }),
    );

    expect(selection.outcome).toBe("all_rejected");
    expect(selection.refreshable).toBe(true);
    expect(selection.winner).toBeUndefined();
    expect(selection.result).toBeUndefined();
  });

  it("reports all-rejected without refresh paths as hard rejection", async () => {
    const selection = await selectCredential(
      [candidate("only", "expired", "expired-token-fixture", false)],
      outcomes({ only: { kind: "rejected", error: "unauthorized" } }),
    );

    expect(selection.outcome).toBe("all_rejected");
    expect(selection.refreshable).toBe(false);
  });

  it("keeps a single stored-valid credential's behavior unchanged", async () => {
    const attempt = vi.fn(
      outcomes({ only: { kind: "quota", result: "fresh-data" } }),
    );
    const selection = await selectCredential(
      [candidate("only", "valid", "valid-token-fixture")],
      attempt,
    );

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(selection.outcome).toBe("quota");
    expect(selection.result).toBe("fresh-data");
    expect(selection.winner).toEqual({ source: "only", localState: "valid" });
  });

  it("records a live-without-quota floor and still seeks quota from later candidates", async () => {
    const tried: string[] = [];
    const selection = await selectCredential(
      [
        candidate("model-auth", "valid", "model-token-fixture"),
        candidate("session", "expired", "session-token-fixture", true),
      ],
      async (attempted) => {
        tried.push(attempted.source);
        return attempted.source === "model-auth"
          ? { kind: "live_no_quota" }
          : { kind: "quota", result: "fresh-data" };
      },
    );

    expect(tried).toEqual(["model-auth", "session"]);
    expect(selection.outcome).toBe("quota");
    expect(selection.result).toBe("fresh-data");
    expect(selection.winner?.source).toBe("session");
  });

  it("returns the live floor when no candidate can produce quota", async () => {
    const selection = await selectCredential(
      [
        candidate("model-auth", "valid", "model-token-fixture"),
        candidate("session", "expired", "session-token-fixture", true),
      ],
      outcomes({
        "model-auth": { kind: "live_no_quota" },
        session: { kind: "rejected", error: "unauthorized" },
      }),
    );

    expect(selection.outcome).toBe("live_no_quota");
    expect(selection.winner?.source).toBe("model-auth");
  });

  it("stops on a transient failure without switching credentials", async () => {
    const attempt = vi.fn(
      outcomes({
        primary: {
          kind: "transient",
          error: "timeout",
          retryAfter: "2026-01-01T00:00:00.000Z",
        },
        secondary: { kind: "quota", result: "fresh-data" },
      }),
    );
    const selection = await selectCredential(
      [
        candidate("primary", "valid", "primary-token-fixture"),
        candidate("secondary", "expired", "expired-token-fixture", true),
      ],
      attempt,
    );

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(selection.outcome).toBe("transient");
    expect(selection.transientError).toBe("timeout");
    expect(selection.retryAfter).toBe("2026-01-01T00:00:00.000Z");
    // The untried expired candidate's refresh path survives, so the
    // provider's stored soft-expiry classification can stand.
    expect(selection.refreshable).toBe(true);
    expect(selection.results[1]).toMatchObject({
      source: "secondary",
      outcome: "not_tried",
    });
  });

  it("treats an attempt crash as transient, never an auth verdict", async () => {
    const selection = await selectCredential(
      [candidate("only", "valid", "valid-token-fixture")],
      async () => {
        throw new Error("boom");
      },
    );

    expect(selection.outcome).toBe("transient");
    expect(selection.transientError).toBe("credential_attempt_failed");
  });

  it("reports no candidates when nothing is try-able", async () => {
    const attempt = vi.fn();
    const selection = await selectCredential([], attempt);

    expect(selection.outcome).toBe("no_candidates");
    expect(selection.results).toEqual([]);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("never emits credential material in any selection output", async () => {
    const fixtures = [
      "primary-token-fixture",
      "expired-token-fixture",
      "model-token-fixture",
    ];
    const selections = [
      await selectCredential(
        [
          candidate("primary", "valid", fixtures[0]),
          candidate("secondary", "expired", fixtures[1], true),
        ],
        outcomes({
          primary: { kind: "rejected", error: "unauthorized" },
          secondary: { kind: "quota", result: "fresh-data" },
        }),
      ),
      await selectCredential(
        [candidate("model-auth", "valid", fixtures[2])],
        outcomes({ "model-auth": { kind: "live_no_quota" } }),
      ),
      await selectCredential(
        [candidate("primary", "expired", fixtures[1], false)],
        outcomes({ primary: { kind: "rejected", error: "unauthorized" } }),
      ),
    ];

    for (const selection of selections) {
      const serialized = JSON.stringify(selection);
      for (const fixture of fixtures) {
        expect(serialized).not.toContain(fixture);
      }
      expect(serialized).not.toContain("credential");
    }
  });
});
