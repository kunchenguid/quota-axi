import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isClaudeEnvProfileScopeDenial,
  normalizeClaudeApiUsage,
  normalizeClaudeProfile,
} from "../../src/providers/claude.js";

const fixtureDir = join(import.meta.dirname, "..", "fixtures", "claude");

describe("Claude quota parsing", () => {
  it("normalizes OAuth usage windows and extra usage", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth.json"), "utf8"),
    ) as unknown;
    const result = normalizeClaudeApiUsage(raw, "Pro");

    expect(result?.plan).toBe("Pro");
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        kind: "session",
        percentUsed: 18,
        percentRemaining: 82,
        resetsAt: "2026-07-06T22:15:00Z",
        windowSeconds: 18_000,
      },
      {
        id: "seven_day",
        kind: "weekly",
        percentUsed: 36,
        percentRemaining: 64,
        resetsAt: "2026-07-10T16:00:00Z",
        windowSeconds: 604_800,
      },
      {
        id: "seven_day_opus",
        kind: "model",
        percentUsed: 7,
        percentRemaining: 93,
        windowSeconds: 604_800,
      },
      {
        id: "extra_usage",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        spentUsd: 5,
        limitUsd: 20,
      },
    ]);
    expect(
      result?.windows.find((window) => window.id === "extra_usage")
        ?.windowSeconds,
    ).toBeUndefined();
  });

  it("treats extra-usage utilization as percent used", () => {
    const result = normalizeClaudeApiUsage({
      extra_usage: {
        is_enabled: true,
        utilization: 42,
      },
    });

    expect(result?.windows).toMatchObject([
      {
        id: "extra_usage",
        percentUsed: 42,
        percentRemaining: 58,
      },
    ]);
  });

  it("prefers the scoped `limits` array and surfaces model-scoped windows like Fable", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-scoped-limits.json"), "utf8"),
    ) as unknown;
    const result = normalizeClaudeApiUsage(raw, "Max");

    expect(result?.plan).toBe("Max");
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        kind: "session",
        percentUsed: 22,
        percentRemaining: 78,
        resetsAt: "2026-07-06T22:15:00.317709+00:00",
        windowSeconds: 18_000,
      },
      {
        id: "seven_day",
        kind: "weekly",
        percentUsed: 41,
        percentRemaining: 59,
        resetsAt: "2026-07-10T16:00:00.317732+00:00",
        windowSeconds: 604_800,
      },
      {
        id: "model:fable",
        label: "Fable week",
        kind: "model",
        percentUsed: 63,
        percentRemaining: 37,
        resetsAt: "2026-07-11T09:30:00.318030+00:00",
        windowSeconds: 604_800,
      },
      {
        id: "extra_usage",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        spentUsd: 5,
        limitUsd: 20,
      },
    ]);
  });
});

describe("Claude OAuth profile parsing", () => {
  it("normalizes the stable account UUID and non-secret full-output fields", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-profile.json"), "utf8"),
    ) as unknown;

    expect(normalizeClaudeProfile(raw)).toEqual({
      accountId: "11111111-2222-4333-8444-555555555555",
      email: "person@example.invalid",
      organization: "Fixture Organization",
      identityStatus: "verified",
    });
  });

  it("does not invent an identity from email or organization UUID", () => {
    expect(
      normalizeClaudeProfile({
        email_address: "person@example.invalid",
        organization: {
          uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        },
      }),
    ).toBeUndefined();
  });

  it("does not treat cached camelCase account metadata as an authoritative profile", () => {
    expect(
      normalizeClaudeProfile({
        accountUuid: "11111111-2222-4333-8444-555555555555",
        emailAddress: "person@example.invalid",
      }),
    ).toBeUndefined();
  });
});

describe("Claude usage 403 classification", () => {
  it.each([
    [
      true,
      {
        type: "error",
        error: {
          type: "permission_error",
          message: "OAuth token does not meet scope requirement user:profile",
          detail: "SYNTHETIC_SECRET_MUST_NOT_ESCAPE",
        },
      },
    ],
    [
      false,
      {
        error: {
          code: "oauth_scope_insufficient",
          message: "SYNTHETIC_SECRET_MUST_NOT_ESCAPE",
        },
      },
    ],
    [
      false,
      {
        error: {
          type: "permission_error",
          message: "OAuth token does not meet scope requirement user:inference",
        },
      },
    ],
    [
      false,
      {
        error: {
          type: "permission_error",
          message: "A generic message mentions user:profile but proves nothing",
        },
      },
    ],
  ])(
    "recognizes only the exact user:profile denial (%s)",
    async (expected, body) => {
      await expect(
        isClaudeEnvProfileScopeDenial(Response.json(body, { status: 403 })),
      ).resolves.toBe(expected);
    },
  );

  it("does not recognize malformed or oversized bodies", async () => {
    await expect(
      isClaudeEnvProfileScopeDenial(new Response("not-json", { status: 403 })),
    ).resolves.toBe(false);
    await expect(
      isClaudeEnvProfileScopeDenial(
        new Response("x".repeat(129), { status: 403 }),
        { maxBytes: 128 },
      ),
    ).resolves.toBe(false);
  });

  it("does not recognize a response body that never completes", async () => {
    const body = new ReadableStream({
      pull: () => new Promise(() => undefined),
    });

    await expect(
      isClaudeEnvProfileScopeDenial(new Response(body, { status: 403 }), {
        deadlineMs: 5,
      }),
    ).resolves.toBe(false);
  });
});
