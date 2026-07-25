import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { ProviderCoverage } from "../src/coverage.js";

const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiDir;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  process.exitCode = undefined;
});

describe("provider coverage inventory", () => {
  it("classifies subscription-backed sources and exposes their quota command", async () => {
    const coverage = await coverageJson();
    expect(find(coverage, "claude", "claude-code-oauth")).toMatchObject({
      billingMode: "subscription",
      coverage: "supported",
      allowance: "available",
      command: "quota-axi --provider claude",
    });
    expect(find(coverage, "kimi", "pi:kimi-coding")).toMatchObject({
      billingMode: "subscription",
      coverage: "supported",
    });
  });

  it("classifies metered APIs without calling them", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const coverage = await coverageJson();
    expect(find(coverage, "openai", "api-key")).toMatchObject({
      billingMode: "metered-api",
      coverage: "unsupported",
      allowance: "unavailable",
    });
    expect(find(coverage, "moonshotai", "api-key")?.reason).toContain(
      "distinct from Kimi Coding membership",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports hybrid and multiple-source providers without conflating billing lanes", async () => {
    const coverage = await coverageJson();
    expect(find(coverage, "cursor", "cursor-session")?.billingMode).toBe(
      "hybrid",
    );
    expect(find(coverage, "xai", "oauth")?.billingMode).toBe("subscription");
    expect(find(coverage, "xai", "api-key")?.billingMode).toBe("metered-api");
  });

  it("reports unsupported providers with the setup needed for allowance", async () => {
    const coverage = await coverageJson();
    expect(find(coverage, "zai", "coding-plan-api-key")).toMatchObject({
      billingMode: "subscription",
      coverage: "unsupported",
      allowance: "unavailable",
      requires: expect.stringContaining("read-only Coding Plan usage API"),
    });
    expect(find(coverage, "opencode-go", "api-key")).toMatchObject({
      coverage: "unsupported",
      requires: expect.stringContaining("official read-only usage endpoint"),
    });
  });

  it("does not guess billing mode or allowance when evidence is missing", async () => {
    const coverage = await coverageJson();
    const antigravity = find(coverage, "antigravity", "local-rpc");
    expect(antigravity).toMatchObject({
      billingMode: "unknown-unproven",
      allowance: "unavailable",
      reason: expect.stringContaining("does not prove"),
      requires: expect.stringContaining("Authoritative billing-mode evidence"),
    });
    expect(antigravity?.command).toBeUndefined();
  });

  it("does not expose credential values or private configuration paths", async () => {
    const secret = "coverage-secret-sentinel-938475";
    const privatePath = `/private/account/${secret}/auth.json`;
    process.env.OPENAI_API_KEY = secret;
    process.env.PI_CODING_AGENT_DIR = privatePath;

    const output = await capture(
      ["coverage", "--json"],
      `/private/bin/${secret}/quota-axi`,
    );
    const toon = await capture(["coverage"], privatePath);
    expect(output + toon).not.toContain(secret);
    expect(output + toon).not.toContain(privatePath);
    expect(output + toon).not.toContain("auth.json");
  });
});

async function coverageJson(): Promise<ProviderCoverage[]> {
  const response = JSON.parse(await capture(["coverage", "--json"])) as {
    schemaVersion: number;
    coverage: ProviderCoverage[];
  };
  expect(response.schemaVersion).toBe(1);
  return response.coverage;
}

function find(
  coverage: ProviderCoverage[],
  provider: string,
  source: string,
): ProviderCoverage | undefined {
  return coverage.find(
    (entry) => entry.provider === provider && entry.source === source,
  );
}

async function capture(argv: string[], binPath = "quota-axi"): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath,
    stdout: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  });
  return chunks.join("");
}
