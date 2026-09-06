import { describe, expect, it } from "vitest";
import {
  degradedSources,
  isDegradedSourceAttempt,
} from "../../src/lib/source-attempts.js";

describe("degraded source classification", () => {
  it("treats a tried-and-failed source as degraded", () => {
    expect(
      isDegradedSourceAttempt({
        source: "oauth",
        status: "failed",
        error: "HTTP 401",
      }),
    ).toBe(true);
  });

  it("treats a skipped source that still holds a credential as degraded", () => {
    expect(
      isDegradedSourceAttempt({
        source: "oauth",
        status: "skipped",
        error: "credentials_expired",
        credentialPresent: true,
      }),
    ).toBe(true);
  });

  it("does not treat an absent source as degraded", () => {
    expect(
      isDegradedSourceAttempt({
        source: "pi:openai-codex",
        status: "skipped",
        error: "credentials_missing",
      }),
    ).toBe(false);
  });

  it("lets a provider override the derivation for a non-credential attempt", () => {
    expect(
      isDegradedSourceAttempt({
        source: "web",
        status: "skipped",
        error: "model_auth_probe_live",
        credentialPresent: true,
        degraded: false,
      }),
    ).toBe(false);
  });

  it("names each degraded source once, in the order it was consulted", () => {
    expect(
      degradedSources([
        {
          source: "oauth",
          status: "skipped",
          error: "a",
          credentialPresent: true,
        },
        { source: "oauth", status: "failed", error: "b" },
        { source: "pi:openai-codex", status: "failed", error: "c" },
        { source: "cli-rpc", status: "success" },
      ]),
    ).toEqual([
      { source: "oauth", error: "a" },
      { source: "pi:openai-codex", error: "c" },
    ]);
  });

  it("clears a source that ultimately answered after an earlier failure", () => {
    expect(
      degradedSources([
        { source: "web", status: "failed", error: "credentials_expired" },
        { source: "web", status: "success" },
      ]),
    ).toEqual([]);
  });

  it("reports no degraded source for a report with no attempts", () => {
    expect(degradedSources(undefined)).toEqual([]);
  });
});
