import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiAnthropicCredentialBroker } from "../../src/providers/pi-anthropic-credential.js";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 3_600_000;
const SECRET = "fixture-anthropic-access-never-render";
const REFRESH = "fixture-anthropic-refresh-never-render";
let directories: string[] = [];

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe("Pi Anthropic credential broker", () => {
  it("resolves the Anthropic OAuth entry as pi:anthropic without changing the store", async () => {
    const { path, before } = fixture({
      anthropic: {
        type: "oauth",
        access: SECRET,
        refresh: REFRESH,
        expires: FUTURE,
      },
    });
    const broker = brokerFor(path);

    await expect(broker.resolve()).resolves.toEqual({
      status: "available",
      credentials: { accessToken: SECRET, expiresAtMs: FUTURE },
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("reports absent, malformed, and wrong-type entries without throwing", async () => {
    const absent = fixture({ unrelated: { type: "oauth", access: "other" } });
    await expect(brokerFor(absent.path).resolve()).resolves.toEqual({
      status: "missing",
    });

    const malformed = fixtureText("{not-json");
    await expect(brokerFor(malformed.path).resolve()).resolves.toEqual({
      status: "invalid",
    });

    const wrongType = fixture({
      anthropic: { type: "api_key", key: "must-not-be-used" },
    });
    await expect(brokerFor(wrongType.path).resolve()).resolves.toEqual({
      status: "unsupported",
    });
  });

  it("reports expired OAuth and refresh presence without reading or exchanging it", async () => {
    const { path } = fixture({
      anthropic: {
        type: "oauth",
        access: SECRET,
        refresh: REFRESH,
        expires: NOW - 1,
      },
    });
    const broker = brokerFor(path);

    await expect(broker.resolve()).resolves.toEqual({
      status: "expired",
      refreshable: true,
      credentials: { accessToken: SECRET, expiresAtMs: NOW - 1 },
    });
  });

  it.each([
    [FUTURE / 1000, FUTURE],
    [String(FUTURE), FUTURE],
    [new Date(FUTURE).toISOString(), FUTURE],
  ])("normalizes OAuth expiry %s", async (expires, expected) => {
    const { path } = fixture({
      anthropic: { type: "oauth", access: SECRET, expires },
    });

    await expect(brokerFor(path).resolve()).resolves.toEqual({
      status: "available",
      credentials: { accessToken: SECRET, expiresAtMs: expected },
    });
  });
});

function fixture(value: unknown): { path: string; before: string } {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-anthropic-"));
  directories.push(directory);
  const agent = join(directory, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  const path = join(agent, "auth.json");
  writeFileSync(path, JSON.stringify(value));
  return { path, before: readFileSync(path, "utf8") };
}

function fixtureText(value: string): { path: string } {
  const result = fixture({});
  writeFileSync(result.path, value);
  return result;
}

function brokerFor(path: string) {
  const agent = path.slice(0, path.lastIndexOf("/"));
  return createPiAnthropicCredentialBroker({
    environment: { PI_CODING_AGENT_DIR: agent },
    homeDirectory: () => "/unused",
    now: () => NOW,
  });
}
