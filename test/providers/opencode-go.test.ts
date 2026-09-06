import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenCodeGoAdapter,
  extractOpenCodeGoCredential,
  normalizeOpenCodeGoPayload,
  opencodeGoAuthFilePath,
} from "../../src/providers/opencode-go.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-opencode-go-key-42";

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
    const report = await createOpenCodeGoAdapter({
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

  it("normalizes the current flat usage response", () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/opencode-go/usage-flat.json", "utf8"),
    );
    expect(
      normalizeOpenCodeGoPayload(
        payload,
        Date.parse("2026-09-01T00:00:00.000Z"),
      ).windows,
    ).toEqual([
      expect.objectContaining({
        id: "rolling",
        kind: "unknown",
        percentUsed: 18,
        percentRemaining: 82,
        resetsAt: "2026-09-01T01:00:00.000Z",
      }),
      expect.objectContaining({
        id: "weekly",
        percentUsed: 42,
        percentRemaining: 58,
        resetsAt: "2026-09-08T00:00:00.000Z",
      }),
      expect.objectContaining({
        id: "monthly",
        percentUsed: 7,
        percentRemaining: 93,
        resetsAt: "2026-10-01T00:00:00.000Z",
      }),
    ]);
  });

  it("accepts remaining percentages and fails safely on rejected or malformed data", async () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: { weekly: { percentRemaining: 77, resetsAt: 1_790_000_000 } },
      }).windows,
    ).toMatchObject([{ id: "weekly", percentRemaining: 77, percentUsed: 23 }]);

    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
      credential: () => ({ status: "error", path: "/auth.json" }),
    }).inspectAuth(OPTIONS);

    expect(report.sources).toEqual([
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
      const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const unverifiableReport = await createOpenCodeGoAdapter({
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
    const falselyDeclaredReport = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
    const report = await createOpenCodeGoAdapter({
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
