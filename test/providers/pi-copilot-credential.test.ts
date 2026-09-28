import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  credentialFromPiEntry,
  resolvePiCopilotCredential,
} from "../../src/providers/pi-copilot-credential.js";

const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

function storeReader(store: unknown, calls: string[] = []) {
  return async (path: string, maxBytes: number) => {
    calls.push(path);
    expect(maxBytes).toBe(AUTH_FILE_LIMIT_BYTES);
    return Buffer.from(
      typeof store === "string" ? store : JSON.stringify(store),
    );
  };
}

function resolveWith(
  store: unknown,
  environment: Record<string, string | undefined> = {
    PI_CODING_AGENT_DIR: "/synthetic/pi",
  },
  calls: string[] = [],
) {
  return resolvePiCopilotCredential({
    environment,
    homeDirectory: () => "/synthetic/home",
    readFile: storeReader(store, calls),
  });
}

describe("Pi GitHub Copilot credential", () => {
  it("reads the GitHub OAuth token Pi keeps in refresh", async () => {
    await expect(
      resolveWith({
        "github-copilot": {
          type: "oauth",
          refresh: "ghu_synthetic",
          access: "tid=synthetic",
          expires: 1,
        },
      }),
    ).resolves.toEqual({
      status: "resolved",
      path: join("/synthetic/pi", "auth.json"),
      token: "ghu_synthetic",
    });
  });

  it("follows PI_CODING_AGENT_DIR and defaults to ~/.pi/agent", async () => {
    const calls: string[] = [];
    await resolveWith({}, { PI_CODING_AGENT_DIR: "~/custom-pi" }, calls);
    await resolveWith({}, {}, calls);
    expect(calls).toEqual([
      join("/synthetic/home", "custom-pi", "auth.json"),
      join("/synthetic/home", ".pi", "agent", "auth.json"),
    ]);
  });

  function guarded(
    fields: Record<string, unknown>,
    forbidden: string[],
  ): Record<string, unknown> {
    const entry = { ...fields };
    for (const field of forbidden) {
      Object.defineProperty(entry, field, {
        enumerable: true,
        get() {
          throw new Error(`${field} must not be read`);
        },
      });
    }
    return entry;
  }

  it("never reads Pi's Copilot session token, its expiry, or its model list", () => {
    expect(
      credentialFromPiEntry(
        guarded({ type: "oauth", refresh: "ghu_synthetic" }, [
          "access",
          "expires",
          "availableModelIds",
        ]),
        "/synthetic/pi/auth.json",
      ),
    ).toEqual({
      status: "resolved",
      path: "/synthetic/pi/auth.json",
      token: "ghu_synthetic",
    });
  });

  it("does not read the token of a GitHub Enterprise login", () => {
    expect(
      credentialFromPiEntry(
        guarded({ type: "oauth", enterpriseUrl: "ghe.example.test" }, [
          "refresh",
        ]),
        "/synthetic/pi/auth.json",
      ),
    ).toEqual({
      status: "unsupported",
      path: "/synthetic/pi/auth.json",
      error: "selected_host_unsupported",
    });
  });

  it("classifies a missing store, a missing entry, and a read failure distinctly", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    for (const [error, status] of [
      [missing, "absent"],
      [denied, "read_error"],
    ] as const) {
      await expect(
        resolvePiCopilotCredential({
          environment: { PI_CODING_AGENT_DIR: "/synthetic/pi" },
          readFile: async () => {
            throw error;
          },
        }),
      ).resolves.toMatchObject({ status });
    }
    await expect(
      resolveWith({ "openai-codex": { type: "oauth" } }),
    ).resolves.toMatchObject({ status: "absent" });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an array store", "[]"],
    ["an oversized store", "x".repeat(AUTH_FILE_LIMIT_BYTES + 1)],
    ["a scalar entry", { "github-copilot": "ghu_synthetic" }],
    ["no type", { "github-copilot": { refresh: "ghu_synthetic" } }],
    ["no token", { "github-copilot": { type: "oauth", access: "tid=x" } }],
    ["a command", { "github-copilot": { type: "oauth", refresh: "!gh auth" } }],
    [
      "a control byte",
      { "github-copilot": { type: "oauth", refresh: "ghu_\nsynthetic" } },
    ],
    [
      "a non-string enterprise URL",
      {
        "github-copilot": {
          type: "oauth",
          refresh: "ghu_synthetic",
          enterpriseUrl: 1,
        },
      },
    ],
  ])("treats %s as structurally invalid", async (_label, store) => {
    await expect(resolveWith(store)).resolves.toMatchObject({
      status: "structurally_invalid",
    });
  });

  it("treats a non-OAuth entry as unsupported", async () => {
    await expect(
      resolveWith({ "github-copilot": { type: "api_key", key: "synthetic" } }),
    ).resolves.toMatchObject({
      status: "unsupported",
      error: "unsupported_credential_type",
    });
  });
});
