import { describe, expect, it } from "vitest";
import {
  degradedSources,
  isDegradedSourceAttempt,
  providerPresence,
} from "../../src/lib/source-attempts.js";
import {
  AGY_CLI_NOT_INSTALLED,
  AGY_NOT_RUNNING,
  agyAdapter,
} from "../../src/providers/agy.js";
import { copilotAdapter } from "../../src/providers/copilot.js";
import type { ProviderQuota, SourceAttempt } from "../../src/types.js";

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

  it("clears a source after explicit non-degraded recovery", () => {
    expect(
      degradedSources([
        { source: "web", status: "failed", error: "provider_auth_rejected" },
        {
          source: "web",
          status: "skipped",
          error: "model_auth_probe_live",
          credentialPresent: true,
          degraded: false,
        },
        { source: "pi:xai", status: "success", credentialPresent: true },
      ]),
    ).toEqual([]);
  });

  it("reports no degraded source for a report with no attempts", () => {
    expect(degradedSources(undefined)).toEqual([]);
  });
});

describe("provider presence classification", () => {
  function reading(
    status: ProviderQuota["state"]["status"],
    attempts?: SourceAttempt[],
  ): Pick<ProviderQuota, "state" | "attempts"> {
    return {
      state: { status, stale: status === "stale" },
      ...(attempts ? { attempts } : {}),
    };
  }

  const absent: SourceAttempt = {
    source: "env:MIMO_API_KEY",
    status: "skipped",
    error: "mimo_credential_unavailable",
  };

  it("counts any reading, fresh or stale, as live", () => {
    expect(providerPresence(reading("fresh", [absent]))).toBe("live");
    expect(providerPresence(reading("stale", [absent]))).toBe("live");
  });

  it("reads a provider as not set up when every source was skipped as absent, whatever the adapter calls it", () => {
    // The attempts real adapters record on a machine with none of these set
    // up: a CLI that is not installed, an app that is not running, and a key
    // missing from every source. Each adapter words absence its own way.
    const agy: SourceAttempt[] = [
      {
        source: "cli",
        status: "skipped",
        error: AGY_CLI_NOT_INSTALLED,
        degraded: false,
      },
      {
        source: "loopback",
        status: "skipped",
        error: AGY_NOT_RUNNING,
        degraded: false,
      },
    ];
    const alibaba: SourceAttempt[] = [
      { source: "bl-cli", status: "skipped", error: "bl_cli_unavailable" },
    ];
    const commandcode: SourceAttempt[] = [
      "pi:commandcode",
      "env:COMMAND_CODE_API_KEY",
      "env:COMMANDCODE_API_KEY",
      "commandcode-cli",
      "omp:commandcode",
    ].map((source) => ({
      source,
      status: "skipped",
      error: "commandcode_sign_in_required",
    }));

    expect(providerPresence(reading("unavailable", agy), agyAdapter)).toBe(
      "absent",
    );
    expect(providerPresence(reading("unavailable", alibaba))).toBe("absent");
    expect(providerPresence(reading("auth_required", commandcode))).toBe(
      "absent",
    );
    expect(
      providerPresence(
        reading("auth_required", [
          absent,
          {
            source: "pi:mimo",
            status: "skipped",
            error: "credentials_missing",
          },
        ]),
      ),
    ).toBe("absent");
  });

  it("keeps a provider whose credential exists in view, however it failed", () => {
    for (const attempt of [
      // Present behind a Keychain prompt, expired, or unreadable.
      {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
      {
        source: "apps-json",
        status: "skipped",
        error: "credentials_read_error",
        degraded: true,
      },
      // Rejected, rate limited, or unparseable after a request.
      { source: "env:DEEPSEEK_API_KEY", status: "failed", error: "401" },
      // An installed tool that failed is still the user's tool.
      { source: "cli", status: "failed", error: "timeout", degraded: false },
    ] satisfies SourceAttempt[]) {
      expect(
        providerPresence(reading("auth_required", [absent, attempt])),
      ).toBe("attention");
    }
  });

  it("never folds a provider whose absence was not shown", () => {
    expect(providerPresence(reading("error"))).toBe("attention");
    expect(providerPresence(reading("error", []))).toBe("attention");
  });

  it("keeps a skip the adapter declares uncertain in view", () => {
    for (const error of [
      "selected_account_unconfirmed",
      "secure_store_unsupported",
    ]) {
      const unconfirmed = reading("auth_required", [
        {
          source: "apps-json",
          status: "skipped",
          error: "credentials_missing",
        },
        {
          source: "copilot-cli:keychain",
          status: "skipped",
          error,
          degraded: false,
        },
      ]);

      expect(providerPresence(unconfirmed, copilotAdapter)).toBe("attention");
      // Only the adapter that owns the word can say it is uncertain.
      expect(providerPresence(unconfirmed)).toBe("absent");
    }
  });

  it("keeps Antigravity in view whenever a skip is not one of its two absences", () => {
    const notInstalled: SourceAttempt = {
      source: "cli",
      status: "skipped",
      error: AGY_CLI_NOT_INSTALLED,
      degraded: false,
    };
    const notRunning: SourceAttempt = {
      source: "loopback",
      status: "skipped",
      error: AGY_NOT_RUNNING,
      degraded: false,
    };

    // An installed CLI that timed out, and a discovered endpoint that would
    // not answer: both are recorded as skipped, neither shows absence.
    for (const [cli, loopback] of [
      [
        { ...notInstalled, error: "Antigravity CLI /quota timed out" },
        notRunning,
      ],
      [
        notInstalled,
        {
          ...notRunning,
          error: "Antigravity loopback unavailable (ECONNREFUSED)",
        },
      ],
    ] satisfies [SourceAttempt, SourceAttempt][]) {
      expect(
        providerPresence(reading("unavailable", [cli, loopback]), agyAdapter),
      ).toBe("attention");
    }

    expect(
      providerPresence(
        reading("unavailable", [notInstalled, notRunning]),
        agyAdapter,
      ),
    ).toBe("absent");
  });

  it("ignores a sibling tool's login, but not a request through it that failed transiently", () => {
    const declarations = copilotAdapter;
    const absentApps: SourceAttempt = {
      source: "apps-json",
      status: "skipped",
      error: "credentials_missing",
    };
    const keyringGh: SourceAttempt = {
      source: "gh:hosts.yml",
      status: "skipped",
      error: "credentials_keyring_storage",
      credentialPresent: true,
    };
    const failedGh: SourceAttempt = {
      source: "gh:hosts.yml",
      status: "failed",
      error: "GitHub Copilot sign-in required",
    };

    expect(
      providerPresence(
        reading("auth_required", [absentApps, keyringGh]),
        declarations,
      ),
    ).toBe("absent");
    // Copilot refused the gh token: a definitive answer, not Copilot use.
    expect(
      providerPresence(
        reading("auth_required", [absentApps, failedGh]),
        declarations,
      ),
    ).toBe("absent");
    // A server failure or rate limit proves nothing about access.
    for (const status of ["error", "rate_limited"] as const) {
      expect(
        providerPresence(
          reading(status, [absentApps, { ...failedGh, error: "HTTP 500" }]),
          declarations,
        ),
      ).toBe("attention");
    }
    // A store that exists but could not be read establishes nothing about
    // the sibling login either, so it is not evidence of absence.
    expect(
      providerPresence(
        reading("auth_required", [
          absentApps,
          {
            source: "gh:hosts.yml",
            status: "skipped",
            error: "credentials_read_error",
            degraded: true,
          },
        ]),
        declarations,
      ),
    ).toBe("attention");
    // Undeclared, the same login is ordinary evidence of the provider.
    expect(
      providerPresence(reading("auth_required", [absentApps, keyringGh])),
    ).toBe("attention");
  });
});
