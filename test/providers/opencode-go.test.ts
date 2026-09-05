import { describe, expect, it, vi } from "vitest";
import {
  createOpenCodeGoAdapter,
  extractOpenCodeGoCredential,
  normalizeOpenCodeGoPayload,
  opencodeGoAuthFilePath,
} from "../../src/providers/opencode-go.js";
import type { PiApiKeyCredentialBroker } from "../../src/providers/pi-api-key-credential.js";
import type { PiApiKeyCredentialResolution } from "../../src/providers/pi-api-key-credential.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-opencode-go-key-42";

function createPiBroker(
  resolution: PiApiKeyCredentialResolution,
  providerIds: readonly string[],
): PiApiKeyCredentialBroker {
  const primary = providerIds[0] ?? "opencode-go";
  const inspection =
    resolution.status === "available"
      ? { status: "available" as const, providerId: resolution.providerId }
      : resolution.status === "missing"
        ? { status: "missing" as const, providerId: primary }
        : resolution.status === "invalid"
          ? {
              status: "invalid" as const,
              providerId: resolution.providerId,
              error: "invalid_credential",
            }
          : resolution.status === "unsupported"
            ? {
                status: "unsupported" as const,
                providerId: resolution.providerId,
                error: "unsupported_credential_type",
              }
            : {
                status: "error" as const,
                providerId: primary,
                error: "credential_resolution_failed",
              };
  return {
    providerIds,
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => inspection),
  };
}

function missingPiBroker(): PiApiKeyCredentialBroker {
  return {
    providerIds: ["opencode-go"],
    resolve: async () => ({ status: "missing" }),
    inspect: async () => ({ status: "missing", providerId: "opencode-go" }),
  };
}

function goAdapter(
  overrides: Partial<Parameters<typeof createOpenCodeGoAdapter>[0]> = {},
) {
  return createOpenCodeGoAdapter({
    piCredentialBroker: missingPiBroker(),
    ...overrides,
  });
}

describe("OpenCode Go provider", () => {
  it("discovers the active opencode-go credential and supports the legacy id", () => {
    expect(
      extractOpenCodeGoCredential(
        { "opencode-go": { type: "api", key: KEY } },
        "/auth.json",
      ),
    ).toEqual({ status: "available", key: KEY, path: "/auth.json" });
    expect(
      extractOpenCodeGoCredential(
        { opencode: { type: "api", key: "fallback-key" } },
        "/auth.json",
      ).status,
    ).toBe("available");
    expect(
      extractOpenCodeGoCredential(
        {
          "opencode-go": {},
          opencode: { type: "api", key: "fallback-key" },
        },
        "/auth.json",
      ),
    ).toEqual({ status: "available", key: "fallback-key", path: "/auth.json" });
  });

  it("discovers the standard Windows auth location", () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    try {
      delete process.env.XDG_DATA_HOME;
      process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");

      expect(opencodeGoAuthFilePath()).toBe(
        "C:\\Users\\test\\AppData\\Local/opencode/auth.json",
      );
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      vi.restoreAllMocks();
    }
  });

  it("queries usage and normalizes consumed percentages as remaining quota", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            usage: {
              rolling: {
                percent: 9,
                resetsAt: "2026-08-28T05:00:00Z",
                windowSeconds: 18_000,
              },
              weekly: { percent: 21, resetsAt: "2026-09-01T00:00:00Z" },
              monthly: { percent: 4, resetsAt: "2026-09-15T00:00:00Z" },
            },
          }),
          { status: 200 },
        ),
    );
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: request,
      now: () => Date.parse("2026-08-28T00:00:00Z"),
    }).fetchQuota(OPTIONS);

    expect(String(request.mock.calls[0][0])).toBe(
      "https://opencode.ai/zen/go/v1/usage",
    );
    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
    expect(report).toMatchObject({
      provider: "opencode-go",
      plan: "OpenCode Go",
      windows: [
        { id: "five_hour", percentUsed: 9, percentRemaining: 91 },
        { id: "weekly", percentUsed: 21, percentRemaining: 79 },
        { id: "monthly", percentUsed: 4, percentRemaining: 96 },
      ],
      state: { status: "fresh", stale: false },
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("accepts remaining percentages and fails safely on rejected or malformed data", async () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: { weekly: { percentRemaining: 77, resetsAt: 1_790_000_000 } },
      }).windows,
    ).toMatchObject([{ id: "weekly", percentRemaining: 77, percentUsed: 23 }]);

    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () => new Response("provider secret", { status: 403 }),
      ),
    }).fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
    expect(
      normalizeOpenCodeGoPayload({ usage: { weekly: {} } }).windows,
    ).toEqual([]);
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          weekly: { percent: 21, resetsAt: "not-a-date" },
        },
      }).windows,
    ).toEqual([
      expect.objectContaining({
        id: "weekly",
        percentUsed: 21,
        percentRemaining: 79,
      }),
    ]);
  });

  it("cancels rejected response bodies before reporting the status", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
    });
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          new Response(body, {
            status: 500,
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_request_rejected",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves credential resolution errors in auth inspection", async () => {
    const report = await goAdapter({
      credential: () => ({ status: "error", path: "/auth.json" }),
    }).inspectAuth(OPTIONS);

    expect(report.sources).toEqual([
      { source: "pi:opencode-go", status: "missing" },
      {
        source: "opencode:auth.json",
        path: "/auth.json",
        status: "error",
        error: "credential_resolution_failed",
      },
    ]);
  });

  it("rejects non-numeric usage values instead of coercing them to zero", () => {
    for (const percent of [null, "", "  ", true, false]) {
      expect(
        normalizeOpenCodeGoPayload({ usage: { weekly: { percent } } }).windows,
      ).toEqual([]);
    }
  });

  it("uses provider cycle durations and omits unsupported defaults", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          rolling: { percent: 9, windowSeconds: 1_234 },
          weekly: { percent: 21, cycle_seconds: "604800" },
          monthly: { percent: 4 },
        },
      }).windows,
    ).toEqual([
      expect.objectContaining({
        id: "rolling",
        label: "rolling",
        kind: "unknown",
        windowSeconds: 1_234,
      }),
      expect.objectContaining({ id: "weekly", windowSeconds: 604_800 }),
      expect.objectContaining({ id: "monthly" }),
    ]);
    expect(
      normalizeOpenCodeGoPayload({ usage: { rolling: { percent: 9 } } })
        .windows[0],
    ).not.toHaveProperty("windowSeconds");
  });

  it("keeps non-five-hour rolling durations unknown", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: { rolling: { percent: 10, windowSeconds: 3_600 } },
      }).windows,
    ).toEqual([
      {
        id: "rolling",
        label: "rolling",
        kind: "unknown",
        percentUsed: 10,
        percentRemaining: 90,
        windowSeconds: 3_600,
      },
    ]);
  });

  it("keeps rolling windows unknown when the provider omits duration", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: { rolling: { percent: 9 } },
      }).windows,
    ).toEqual([
      {
        id: "rolling",
        label: "rolling",
        kind: "unknown",
        percentUsed: 9,
        percentRemaining: 91,
      },
    ]);
  });

  it("clears request deadline timers after a fast response", async () => {
    vi.useFakeTimers();
    try {
      const report = await goAdapter({
        credential: () => ({
          status: "available",
          key: KEY,
          path: "/auth.json",
        }),
        fetch: vi.fn(
          async () =>
            ({
              status: 200,
              ok: true,
              headers: new Headers(),
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ usage: { weekly: { percent: 1 } } }),
                    ),
                  );
                  controller.close();
                },
              }),
            }) as Response,
        ),
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("fresh");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops consuming a response once it exceeds the body limit", async () => {
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(262_145));
      },
      cancel() {
        cancellations += 1;
      },
    });
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(async () => new Response(body)),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "response_too_large",
    });
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancellations).toBe(1);
  });

  it("does not wait for stalled reader cleanup after an oversized chunk", async () => {
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            headers: new Headers(),
            body: {
              getReader: () => ({
                read: async () => ({
                  done: false,
                  value: new Uint8Array(262_145),
                }),
                cancel: () => new Promise<never>(() => undefined),
                releaseLock: vi.fn(),
              }),
            },
          }) as unknown as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "response_too_large",
    });
  });

  it("rejects oversized no-body responses before reading the array buffer", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(262_145));
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            body: null,
            headers: new Headers({ "content-length": "262145" }),
            arrayBuffer,
          }) as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "response_too_large",
    });
    expect(arrayBuffer).not.toHaveBeenCalled();

    const unverifiableArrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    const unverifiableReport = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            body: null,
            headers: new Headers({ "content-length": "not-a-length" }),
            arrayBuffer: unverifiableArrayBuffer,
          }) as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(unverifiableReport.state).toMatchObject({
      status: "error",
      error: "response_size_unverifiable",
    });
    expect(unverifiableArrayBuffer).not.toHaveBeenCalled();

    const falselyDeclaredArrayBuffer = vi.fn(
      async () => new ArrayBuffer(262_145),
    );
    const falselyDeclaredReport = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            body: null,
            headers: new Headers({ "content-length": "1" }),
            arrayBuffer: falselyDeclaredArrayBuffer,
          }) as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(falselyDeclaredReport.state).toMatchObject({
      status: "error",
      error: "response_size_unverifiable",
    });
    expect(falselyDeclaredArrayBuffer).not.toHaveBeenCalled();
  });

  it("cancels oversized declared response bodies before returning", async () => {
    const cancel = vi.fn(async () => undefined);
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            headers: new Headers({ "content-length": "262145" }),
            body: { cancel },
          }) as unknown as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "response_too_large",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait indefinitely for a stalled response body", async () => {
    let resolveRead:
      | ((result: ReadableStreamReadResult<Uint8Array>) => void)
      | undefined;
    const pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>(
      (resolve) => {
        resolveRead = resolve;
      },
    );
    const cancel = vi.fn(async () => {
      resolveRead?.({ done: true, value: undefined });
    });
    const releaseLock = vi.fn();
    const report = await goAdapter({
      deadlineMs: 10,
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            headers: new Headers(),
            body: {
              getReader: () => ({
                read: () => pendingRead,
                cancel,
                releaseLock,
              }),
            },
          }) as unknown as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_timeout",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("aborts a request that stalls before receiving headers", async () => {
    let signal: AbortSignal | undefined;
    const report = await goAdapter({
      deadlineMs: 10,
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async (_input, init) =>
          new Promise<Response>((resolve) => {
            signal = init?.signal;
            void resolve;
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_timeout",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("cleans up a response that arrives after the deadline", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const cancel = vi.fn(async () => undefined);
    const report = await goAdapter({
      deadlineMs: 10,
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(() => fetchPromise),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_timeout",
    });

    resolveFetch?.({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { cancel },
    } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds cleanup when cancellation and the pending read both stall", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const releaseLock = vi.fn();
    const report = await goAdapter({
      deadlineMs: 10,
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            headers: new Headers(),
            body: {
              getReader: () => ({
                read: () =>
                  new Promise<ReadableStreamReadResult<Uint8Array>>(
                    () => undefined,
                  ),
                cancel,
                releaseLock,
              }),
            },
          }) as unknown as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_timeout",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it("releases a retained reader lock when a stalled read settles later", async () => {
    let resolveRead:
      | ((result: ReadableStreamReadResult<Uint8Array>) => void)
      | undefined;
    let readSettled = false;
    const releaseLock = vi.fn(() => {
      if (!readSettled) throw new Error("read_pending");
    });
    const report = await goAdapter({
      deadlineMs: 10,
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            headers: new Headers(),
            body: {
              getReader: () => ({
                read: () =>
                  new Promise<ReadableStreamReadResult<Uint8Array>>(
                    (resolve) => {
                      resolveRead = resolve;
                    },
                  ),
                cancel: vi.fn(async () => undefined),
                releaseLock,
              }),
            },
          }) as unknown as Response,
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_timeout",
    });
    expect(releaseLock).not.toHaveBeenCalled();

    readSettled = true;
    resolveRead?.({ done: true, value: undefined });
    await Promise.resolve();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});

describe("OpenCode Go Pi credential resolution", () => {
  const GO_OPTIONS = OPTIONS;
  const PI_KEY = "synthetic-pi-opencode-go-key-517";
  const USAGE_RESPONSE = () =>
    new Response(JSON.stringify({ usage: { weekly: { percent: 30 } } }), {
      status: 200,
    });

  function piBrokerWith(
    resolution: Parameters<typeof createPiBroker>[0],
  ): PiApiKeyCredentialBroker {
    return createPiBroker(resolution, ["opencode-go"]);
  }

  it("prefers Pi's opencode-go entry for the usage request", async () => {
    const request = vi.fn(async () => USAGE_RESPONSE());
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      piCredentialBroker: piBrokerWith({
        status: "available",
        providerId: "opencode-go",
        credential: PI_KEY,
      }),
      fetch: request,
    }).fetchQuota(GO_OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${PI_KEY}`);
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      { source: "pi:opencode-go", status: "success" },
      { source: "opencode:auth.json", status: "skipped" },
    ]);
    expect(JSON.stringify(report)).not.toContain(PI_KEY);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("falls back to the opencode credential when Pi's key is rejected", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(USAGE_RESPONSE());
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      piCredentialBroker: piBrokerWith({
        status: "available",
        providerId: "opencode-go",
        credential: PI_KEY,
      }),
      fetch: request,
    }).fetchQuota(GO_OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(
      new Headers(request.mock.calls[1][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      {
        source: "pi:opencode-go",
        status: "failed",
        error: "provider_auth_rejected",
      },
      { source: "opencode:auth.json", status: "success" },
    ]);
  });

  it("keeps an unreadable source from turning rejections into a sign-out", async () => {
    const request = vi.fn(async () => new Response(null, { status: 401 }));
    const report = await goAdapter({
      credential: () => ({ status: "error", path: "/auth.json" }),
      piCredentialBroker: piBrokerWith({
        status: "available",
        providerId: "opencode-go",
        credential: PI_KEY,
      }),
      fetch: request,
    }).fetchQuota(GO_OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state).toMatchObject({
      status: "error",
      error: "credential_resolution_failed",
    });
  });

  it("reports auth_required only after every candidate is rejected", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      piCredentialBroker: piBrokerWith({
        status: "available",
        providerId: "opencode-go",
        credential: PI_KEY,
      }),
      fetch: request,
    }).fetchQuota(GO_OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
  });

  it("never treats a missing credential as a measured provider", async () => {
    const request = vi.fn();
    const report = await goAdapter({
      credential: () => ({ status: "missing", path: "/auth.json" }),
      fetch: request,
    }).fetchQuota(GO_OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "opencode_go_credential_unavailable",
    });
    expect(report.attempts).toEqual([
      {
        source: "pi:opencode-go",
        status: "skipped",
        error: "opencode_go_credential_unavailable",
      },
      {
        source: "opencode:auth.json",
        status: "skipped",
        error: "opencode_go_credential_unavailable",
      },
    ]);
  });

  it("does not switch credentials after a transient Pi failure", async () => {
    const request = vi.fn(async () => {
      throw new Error("offline");
    });
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      piCredentialBroker: piBrokerWith({
        status: "available",
        providerId: "opencode-go",
        credential: PI_KEY,
      }),
      fetch: request,
    }).fetchQuota(GO_OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(report.state).toMatchObject({
      status: "error",
      error: "network_unavailable",
    });
    expect(report.attempts).toEqual([
      {
        source: "pi:opencode-go",
        status: "failed",
        error: "network_unavailable",
      },
      {
        source: "opencode:auth.json",
        status: "skipped",
        error: "network_unavailable",
      },
    ]);
  });

  it("inspects both sources without exposing key material", async () => {
    const report = await goAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      piCredentialBroker: piBrokerWith({
        status: "available",
        providerId: "opencode-go",
        credential: PI_KEY,
      }),
    }).inspectAuth(GO_OPTIONS);

    expect(report).toEqual({
      provider: "opencode-go",
      sources: [
        { source: "pi:opencode-go", status: "available" },
        {
          source: "opencode:auth.json",
          path: "/auth.json",
          status: "available",
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(PI_KEY);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });
});
