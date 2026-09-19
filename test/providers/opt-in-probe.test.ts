import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "../../src/lib/http.js";
import {
  createMinimaxAdapter,
  extractMinimaxCredential,
} from "../../src/providers/minimax.js";
import {
  createOpenRouterAdapter,
  extractOpenRouterCredential,
} from "../../src/providers/openrouter.js";

vi.mock("../../src/lib/http.js", () => ({ providerFetch: vi.fn() }));

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "quota-opt-in-probe-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe.each([
  {
    provider: "minimax",
    create: createMinimaxAdapter,
    extract: extractMinimaxCredential,
  },
  {
    provider: "openrouter",
    create: createOpenRouterAdapter,
    extract: extractOpenRouterCredential,
  },
])("$provider probe contracts", ({ provider, create, extract }) => {
  function sources() {
    return ["primary", "secondary"].map((name) => {
      const path = join(directory, `${name}.json`);
      writeFileSync(
        path,
        JSON.stringify({ [provider]: { key: `synthetic-${name}` } }),
      );
      return { name, path: () => path, extract };
    });
  }

  const failures = [
    {
      name: "server",
      response: () => new Response("", { status: 503 }),
      error: "provider_request_rejected",
    },
    {
      name: "rate limit",
      response: () => new Response("", { status: 429 }),
      error: "provider_rate_limited",
    },
    {
      name: "decoding",
      response: () => new Response("{"),
      error: "malformed_json",
    },
    {
      name: "network",
      response: () => {
        throw new Error("synthetic socket failure");
      },
      error: "network_unavailable",
    },
  ];

  it.each(failures)(
    "stops handover after $name failure",
    async ({ response, error }) => {
      const fetch = vi.fn(async () => response());
      const report = await create({
        envApiKey: () => "synthetic-env",
        credentialSources: sources(),
        fetch,
      }).fetchQuota(OPTIONS);
      expect(fetch).toHaveBeenCalledOnce();
      expect(report.state.error).toBe(error);
      expect(report.state.status).not.toBe("auth_required");
      expect(report.attempts).toHaveLength(1);
    },
  );

  it.each(failures)(
    "preserves $name failure over an earlier rejection",
    async ({ response, error }) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 401 }))
        .mockImplementationOnce(async () => response())
        .mockResolvedValue(new Response("{}"));
      const report = await create({
        envApiKey: () => "synthetic-env",
        credentialSources: sources(),
        fetch,
      }).fetchQuota(OPTIONS);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(report.state.error).toBe(error);
      expect(report.state.status).not.toBe("auth_required");
      expect(report.attempts).toHaveLength(2);
    },
  );

  it("hands over after rejection and stops at usable auth without windows", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValue(new Response("{}"));
    const report = await create({
      envApiKey: () => "synthetic-env",
      credentialSources: sources(),
      fetch,
    }).fetchQuota(OPTIONS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(report.state.authStatus).toBe("usable");
    expect(report.windows).toEqual([]);
    expect(report.attempts).toMatchObject([
      { status: "failed" },
      { source: "primary", status: "success" },
    ]);
  });

  it.each(["before", "after"])(
    "preserves an unreadable store %s a credential rejection",
    async (order) => {
      const [rejected] = sources();
      const unreadable = { name: "unreadable", path: () => directory, extract };
      const missing = {
        name: "missing",
        path: () => join(directory, "absent.json"),
        extract,
      };
      const fetch = vi.fn(async () => new Response("", { status: 401 }));
      const report = await create({
        envApiKey: () => undefined,
        credentialSources:
          order === "before"
            ? [unreadable, rejected!, missing]
            : [rejected!, unreadable, missing],
        fetch,
      }).fetchQuota(OPTIONS);
      expect(fetch).toHaveBeenCalledOnce();
      expect(report.state).toMatchObject({
        status: "error",
        error: "credential_resolution_failed: file_read_error",
      });
      expect(report.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "unreadable",
            status: "failed",
            error: "credential_resolution_failed: file_read_error",
          }),
          expect.objectContaining({
            source: "primary",
            status: "failed",
            error: "provider_auth_rejected",
          }),
        ]),
      );
    },
  );

  it("allows a healthy sibling to supersede an unreadable store", async () => {
    const report = await create({
      envApiKey: () => undefined,
      credentialSources: [
        { name: "unreadable", path: () => directory, extract },
        ...sources(),
      ],
      fetch: vi.fn(async () => new Response("{}")),
    }).fetchQuota(OPTIONS);
    expect(report.state.authStatus).toBe("usable");
    expect(report.attempts).toMatchObject([
      { source: "unreadable", status: "failed" },
      { source: "primary", status: "success" },
    ]);
  });

  it.each([
    [401, "provider_auth_rejected"],
    [403, "provider_auth_rejected"],
    [429, "provider_rate_limited"],
    [503, "provider_request_rejected"],
    [302, "provider_request_rejected"],
  ] as const)(
    "aborts streaming HTTP %i without changing its verdict",
    async (status, error) => {
      let signal: AbortSignal | null | undefined;
      const aborted = vi.fn();
      const response = new Response(new ReadableStream(), { status });
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        signal = init?.signal;
        signal?.addEventListener("abort", aborted, { once: true });
        return response;
      };
      const report = await create({
        envApiKey: () => "synthetic-env",
        credentialSources: [],
        fetch,
      }).fetchQuota(OPTIONS);
      expect(report.state.error).toBe(error);
      expect(signal?.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledOnce();
      await response.body?.cancel();
    },
  );

  it("uses the shared transport by default", async () => {
    vi.mocked(providerFetch).mockResolvedValue(new Response("{}"));
    const report = await create({
      envApiKey: () => "synthetic-env",
      credentialSources: [],
    }).fetchQuota(OPTIONS);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(report.state.authStatus).toBe("usable");
  });

  it("caps streamed decoded bytes and cancels before reading the remainder", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const chunk = new TextEncoder().encode("é".repeat(65_537));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(chunk);
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const report = await create({
      envApiKey: () => "synthetic-env",
      credentialSources: [],
      fetch: vi.fn(async () => new Response(body)),
    }).fetchQuota(OPTIONS);
    expect(report.state.error).toBe("response_too_large");
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([262_144, 262_145])(
    "enforces a %i-byte JSON response at the exact boundary",
    async (size) => {
      const payload = '{"label":"' + "x".repeat(size - 12) + '"}';
      expect(new TextEncoder().encode(payload).byteLength).toBe(size);
      const report = await create({
        envApiKey: () => "synthetic-env",
        credentialSources: [],
        fetch: vi.fn(async () => new Response(payload)),
      }).fetchQuota(OPTIONS);
      if (size === 262_144) expect(report.state.authStatus).toBe("usable");
      else expect(report.state.error).toBe("response_too_large");
    },
  );
});
