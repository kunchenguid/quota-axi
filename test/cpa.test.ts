import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createCpaAdapter } from "../src/providers/cpa.js";
import type { ProviderAdapter, ProviderOptions } from "../src/types.js";

const options: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  delete process.env.CPA_BASE_URL;
  delete process.env.CPA_MANAGEMENT_KEY;
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function fakeServer(): Promise<{ baseUrl: string; calls: unknown[] }> {
  const calls: unknown[] = [];
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.url === "/v0/management/auth-files") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            files: [
              {
                auth_index: "claude-1",
                provider: "claude",
                email: "claude@example.test",
                status: "ready",
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/v0/management/api-call") {
        const parsed = JSON.parse(body) as {
          url: string;
          auth_index: string;
          header: Record<string, string>;
        };
        calls.push(parsed);
        response.setHeader("content-type", "application/json");
        const payload = parsed.url.includes("/usage")
          ? {
              five_hour: { utilization: 25, resets_at: "2030-01-01T01:00:00Z" },
              seven_day: { utilization: 10, resets_at: "2030-01-02T01:00:00Z" },
            }
          : { email: "claude@example.test", account_uuid: "account-1" };
        response.end(
          JSON.stringify({ status_code: 200, body: JSON.stringify(payload) }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    },
  );
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fake server did not bind");
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, calls });
    }),
  );
}

const fallback: ProviderAdapter = {
  id: "claude",
  label: "Claude",
  fetchQuota: async () => ({
    provider: "claude",
    windows: [],
    state: { status: "unavailable", stale: false },
  }),
  inspectAuth: async () => ({ provider: "claude", sources: [] }),
};

describe("CLIProxyAPI provider", () => {
  it("lists accounts and substitutes the token only in CPA api-call", async () => {
    const fake = await fakeServer();
    const adapter = createCpaAdapter("claude", fallback, () => ({
      baseUrl: fake.baseUrl,
      key: randomUUID(),
    }));
    const accounts = await adapter.discoverAccounts?.();
    expect(accounts).toHaveLength(2);
    const account = accounts?.find(
      (candidate) => candidate.accountKey !== "cpa-pool",
    );
    const reading = await account?.fetchQuota(options);
    expect(reading).toMatchObject({
      source: "cpa",
      accountKey: "cpa-claude-1",
      account: { email: "claude@example.test" },
    });
    expect(reading?.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(
      fake.calls.every((call) => JSON.stringify(call).includes("$TOKEN$")),
    ).toBe(true);
    expect(JSON.stringify(fake.calls)).not.toContain("random-access-token");
  });
});
