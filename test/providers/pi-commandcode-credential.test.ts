import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiCommandCodeCredentialBroker,
  credentialFromPiEntry,
} from "../../src/providers/pi-commandcode-credential.js";

const AUTH_FILE_LIMIT_BYTES = 64 * 1024;
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Pi Command Code credential broker", () => {
  it("reads a literal OAuth-shaped API key and ignores expiry", async () => {
    const broker = brokerWithStore({
      commandcode: {
        type: "oauth",
        access: "pi-commandcode-literal",
        expires: Date.now() - 1,
      },
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "resolved",
      credential: "pi-commandcode-literal",
    });
    await expect(broker.inspect()).resolves.toMatchObject({
      status: "available",
    });
  });

  it("reads a literal api_key entry", async () => {
    const broker = brokerWithStore({
      commandcode: { type: "api_key", key: "pi-commandcode-api-key" },
    });

    await expect(broker.resolve()).resolves.toEqual({
      status: "resolved",
      credential: "pi-commandcode-api-key",
    });
  });

  it("treats an absent commandcode property as absent, not invalid", async () => {
    const broker = brokerWithStore({ other: { type: "oauth" } });
    await expect(broker.resolve()).resolves.toEqual({ status: "absent" });
  });

  it("treats a present non-object entry as invalid", async () => {
    const broker = brokerWithStore({ commandcode: "token" });
    await expect(broker.resolve()).resolves.toEqual({
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    });
  });

  it("rejects templates, empty values, and control characters", async () => {
    for (const value of ["$SECRET", "${SECRET}", "!command", "", "bad\nkey"]) {
      expect(
        credentialFromPiEntry({ type: "oauth", access: value }),
        value,
      ).toEqual({
        status: "structurally_invalid",
        error: "commandcode_credential_invalid",
      });
    }
  });

  it("never reads the refresh field", () => {
    const entry: Record<string, unknown> = {
      type: "oauth",
      access: "pi-commandcode-literal",
    };
    Object.defineProperty(entry, "refresh", {
      get() {
        throw new Error("refresh field must not be read");
      },
    });
    expect(credentialFromPiEntry(entry)).toEqual({
      status: "resolved",
      credential: "pi-commandcode-literal",
    });
  });

  it("marks unknown credential types unsupported", () => {
    expect(
      credentialFromPiEntry({ type: "totally-unknown", access: "x" }),
    ).toEqual({ status: "unsupported" });
  });

  it("rejects an oversized auth file without sending its contents", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-commandcode-pi-"));
    const path = join(tempDir, "auth.json");
    writeFileSync(path, "x".repeat(AUTH_FILE_LIMIT_BYTES + 2));
    const broker = createPiCommandCodeCredentialBroker({
      environment: { PI_CODING_AGENT_DIR: tempDir },
      homeDirectory: () => tempDir!,
      readFile: async () => Buffer.alloc(AUTH_FILE_LIMIT_BYTES + 1),
    });
    await expect(broker.resolve()).resolves.toEqual({
      status: "structurally_invalid",
      error: "commandcode_credential_invalid",
    });
  });
});

function brokerWithStore(store: unknown) {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-commandcode-pi-"));
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, "auth.json"), JSON.stringify(store), {
    mode: 0o600,
  });
  return createPiCommandCodeCredentialBroker({
    environment: { PI_CODING_AGENT_DIR: tempDir },
    homeDirectory: () => tempDir!,
  });
}
