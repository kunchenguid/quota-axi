import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createOpenCodeGoAdapter,
  createPiOpenCodeGoCredentialSource,
  defaultOpenCodeGoCredentialSources,
  extractOpenCodeGoCredential,
  normalizeOpenCodeGoPayload,
  opencodeGoAuthFilePath,
  OPENCODE_GO_CREDENTIAL_SOURCE,
  OPENCODE_GO_DB_CREDENTIAL_SOURCE,
  createOpencodeGoDbCredentialSource,
  PI_OPENCODE_GO_AUTH_ENV,
  PI_OPENCODE_GO_SOURCE,
  type CredentialResolution,
  type NamedOpenCodeGoCredentialSource,
  type OpenCodeGoCredentialSource,
} from "../../src/providers/opencode-go.js";

const sqlite3 = vi.hoisted(() => ({ available: true }));

// The process boundary is mocked: `sqlite3 -readonly <db> <sql>` is answered
// by running the same SQL read-only against the synthetic fixture database.
vi.mock("../../src/lib/process.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/process.js")>();
  const { DatabaseSync: Database } = await import("node:sqlite");
  return {
    ...original,
    commandExists: async (command: string) =>
      command === "sqlite3"
        ? sqlite3.available
        : original.commandExists(command),
    execFileText: async (command: string, args: string[]) => {
      if (command !== "sqlite3" || args[0] !== "-readonly") {
        throw new Error(`unexpected command ${command}`);
      }
      const db = new Database(args.at(-2)!, { readOnly: true });
      try {
        const row = db.prepare(args.at(-1)!.replace(/;\s*$/, "")).get() as
          | Record<string, unknown>
          | undefined;
        return row ? `${Object.values(row)[0]}\n` : "";
      } finally {
        db.close();
      }
    },
  };
});

beforeEach(() => {
  sqlite3.available = true;
});

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-opencode-go-key-42";
const PI_AUTH_PATH = "/pi/agent/auth.json";
const PI_KEY = "synthetic-pi-opencode-go-key-77";

function fakeSource(
  resolution: CredentialResolution,
): OpenCodeGoCredentialSource {
  return {
    resolve: () => resolution,
    inspect: () =>
      resolution.status === "available"
        ? { status: "available", path: resolution.path }
        : resolution,
  };
}

function sources(
  opencode: CredentialResolution,
  pi: CredentialResolution = { status: "missing", path: PI_AUTH_PATH },
): NamedOpenCodeGoCredentialSource[] {
  return [
    { name: "pi:opencode-go", source: fakeSource(pi) },
    { name: "opencode:auth.json", source: fakeSource(opencode) },
  ];
}

function usageResponse(): Response {
  return new Response(
    JSON.stringify({
      usage: { weekly: { percent: 21, resetsAt: "2026-09-01T00:00:00Z" } },
    }),
    { status: 200 },
  );
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
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
    expect(
      normalizeOpenCodeGoPayload(
        { rollingUsage: { usagePercent: 18, resetInSec: 10_000_000_000_000 } },
        Date.parse("2026-09-01T00:00:00.000Z"),
      ).windows,
    ).toEqual([
      expect.objectContaining({
        id: "rolling",
        percentUsed: 18,
        percentRemaining: 82,
      }),
    ]);
    expect(
      normalizeOpenCodeGoPayload(
        { rollingUsage: { usagePercent: 18, resetInSec: 10_000_000_000_000 } },
        Date.parse("2026-09-01T00:00:00.000Z"),
      ).windows[0]?.resetsAt,
    ).toBeUndefined();

    const report = await createOpenCodeGoAdapter({
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({ status: "error", path: "/auth.json" }),
    }).inspectAuth(OPTIONS);

    expect(report.sources).toEqual([
      {
        source: "pi:opencode-go",
        path: PI_AUTH_PATH,
        status: "missing",
      },
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

  it("keeps rolling windows unknown when the payload has neither duration nor reset", () => {
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

  it("falls back to plan-declared cycle lengths when the payload carries none", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          rolling: { percent: 9, resetsAt: "2026-09-22T02:51:00Z" },
          weekly: { percent: 21, resetsAt: "2026-09-28T00:00:00Z" },
          monthly: { percent: 4, resetsAt: "2026-10-20T17:17:39Z" },
        },
      }).windows,
    ).toEqual([
      {
        id: "rolling",
        label: "rolling",
        kind: "unknown",
        percentUsed: 9,
        percentRemaining: 91,
        windowSeconds: 18_000,
        resetsAt: "2026-09-22T02:51:00.000Z",
      },
      {
        id: "weekly",
        label: "weekly",
        kind: "weekly",
        percentUsed: 21,
        percentRemaining: 79,
        windowSeconds: 604_800,
        resetsAt: "2026-09-28T00:00:00.000Z",
      },
      {
        id: "monthly",
        label: "monthly",
        kind: "monthly",
        percentUsed: 4,
        percentRemaining: 96,
        startsAt: "2026-09-20T17:17:39.000Z",
        resetsAt: "2026-10-20T17:17:39.000Z",
      },
    ]);
  });

  it("derives the monthly start one calendar month before the reset, clamping month ends", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          monthly: { percent: 4, resetsAt: "2026-03-31T12:00:00Z" },
        },
      }).windows[0]?.startsAt,
    ).toBe("2026-02-28T12:00:00.000Z");
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          monthly: { percent: 4, resetsAt: "2024-03-31T12:00:00Z" },
        },
      }).windows[0]?.startsAt,
    ).toBe("2024-02-29T12:00:00.000Z");
  });

  it("keeps payload-supplied cycle durations ahead of the plan-declared fallbacks", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          rolling: {
            percent: 5,
            windowSeconds: 3_600,
            resetsAt: "2026-09-22T02:51:00Z",
          },
          weekly: {
            percent: 5,
            windowSeconds: 7_200,
            resetsAt: "2026-09-28T00:00:00Z",
          },
          monthly: {
            percent: 5,
            windowSeconds: 2_592_000,
            resetsAt: "2026-10-20T17:17:39Z",
          },
        },
      }).windows,
    ).toEqual([
      expect.objectContaining({
        id: "rolling",
        label: "rolling",
        kind: "unknown",
        windowSeconds: 3_600,
      }),
      expect.objectContaining({
        id: "weekly",
        windowSeconds: 7_200,
      }),
      expect.objectContaining({
        id: "monthly",
        windowSeconds: 2_592_000,
      }),
    ]);
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          monthly: {
            percent: 5,
            windowSeconds: 2_592_000,
            resetsAt: "2026-10-20T17:17:39Z",
          },
        },
      }).windows[0],
    ).not.toHaveProperty("startsAt");
  });

  it("treats a non-positive payload duration as absent for every window", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          rolling: {
            percent: 5,
            windowSeconds: 0,
            resetsAt: "2026-09-22T02:51:00Z",
          },
          monthly: {
            percent: 5,
            windowSeconds: 0,
            resetsAt: "2026-10-20T17:17:39Z",
          },
        },
      }).windows,
    ).toEqual([
      expect.objectContaining({ id: "rolling", windowSeconds: 18_000 }),
      expect.objectContaining({
        id: "monthly",
        startsAt: "2026-09-20T17:17:39.000Z",
      }),
    ]);
  });

  it("still promotes only a payload-supplied 18,000 s rolling duration to the session identity", () => {
    expect(
      normalizeOpenCodeGoPayload({
        usage: {
          rolling: {
            percent: 5,
            windowSeconds: 18_000,
            resetsAt: "2026-09-22T02:51:00Z",
          },
        },
      }).windows[0],
    ).toEqual({
      id: "five_hour",
      label: "session",
      kind: "session",
      percentUsed: 5,
      percentRemaining: 95,
      windowSeconds: 18_000,
      resetsAt: "2026-09-22T02:51:00.000Z",
    });
  });

  it("makes pace, runway, and selection measurable for the live absent-duration shape", async () => {
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                rolling: {
                  percent: 0,
                  resetsAt: "2026-09-22T02:51:00Z",
                },
                weekly: { percent: 12, resetsAt: "2026-09-28T00:00:00Z" },
                monthly: { percent: 3, resetsAt: "2026-10-20T17:17:39Z" },
              },
            }),
            { status: 200 },
          ),
      ),
      now: () => Date.parse("2026-09-21T21:51:00Z"),
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, "2026-09-21T21:51:00.000Z");

    expect(report.windows?.map(({ id }) => id)).toEqual([
      "rolling",
      "weekly",
      "monthly",
    ]);
    expect(report.windows?.[0]).toMatchObject({
      id: "rolling",
      kind: "unknown",
      windowSeconds: 18_000,
    });
    const [scope] = interpreted.quotaSemantics.effectiveAvailability;
    expect(scope).toMatchObject({
      status: "known",
      boundedBy: ["rolling", "weekly", "monthly"],
      runway: { status: "through_reset" },
      selection: { status: "known" },
    });
    expect(scope?.selection?.spendPriority).toEqual(expect.any(Number));
    const rollingPace = interpreted.windows?.find(
      ({ id }) => id === "rolling",
    )?.pace;
    expect(rollingPace).toMatchObject({
      status: "on_pace",
      elapsedPercent: 0,
      cycleSeconds: 18_000,
    });
    expect(rollingPace).not.toHaveProperty("burnMultiple");
  });

  it("clears request deadline timers after a fast response", async () => {
    vi.useFakeTimers();
    try {
      const report = await createOpenCodeGoAdapter({
        credentialSources: sources({
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
        status: "available",
        key: KEY,
        path: "/auth.json",
      }),
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
      credentialSources: sources({
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
      credentialSources: sources({
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

describe("OpenCode Go multi-source credentials", () => {
  it("uses Pi auth without resolving the fallback store", async () => {
    const request = vi.fn(async () => usageResponse());
    const fallbackResolve = vi.fn(
      (): CredentialResolution => ({
        status: "error",
        path: "/oc/auth.json",
      }),
    );
    const report = await createOpenCodeGoAdapter({
      credentialSources: [
        {
          name: "pi:opencode-go",
          source: fakeSource({
            status: "available",
            key: PI_KEY,
            path: PI_AUTH_PATH,
          }),
        },
        {
          name: "opencode:auth.json",
          source: {
            resolve: fallbackResolve,
            inspect: () => ({ status: "error", path: "/oc/auth.json" }),
          },
        },
      ],
      fetch: request,
      now: () => Date.parse("2026-08-28T00:00:00Z"),
    }).fetchQuota(OPTIONS);

    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${PI_KEY}`);
    expect(fallbackResolve).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "fresh",
      sourcesTried: ["pi:opencode-go"],
    });
    expect(report.attempts).toEqual([
      { source: "pi:opencode-go", status: "success" },
    ]);
    expect(JSON.stringify(report)).not.toContain(PI_KEY);
  });

  it("falls through from a rejected Pi key to a working opencode key", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return headers.get("authorization") === `Bearer ${PI_KEY}`
          ? new Response(null, { status: 401 })
          : usageResponse();
      },
    );
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources(
        { status: "available", key: KEY, path: "/oc/auth.json" },
        { status: "available", key: PI_KEY, path: PI_AUTH_PATH },
      ),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(report.state).toMatchObject({
      status: "fresh",
      sourcesTried: ["pi:opencode-go", "opencode:auth.json"],
    });
    expect(report.attempts).toEqual([
      {
        source: "pi:opencode-go",
        status: "failed",
        error: "provider_auth_rejected",
      },
      { source: "opencode:auth.json", status: "success" },
    ]);
  });

  it("does not switch credentials after a transient Pi failure", async () => {
    const request = vi.fn(async () => new Response(null, { status: 500 }));
    const fallbackResolve = vi.fn(
      (): CredentialResolution => ({
        status: "available",
        key: KEY,
        path: "/oc/auth.json",
      }),
    );
    const report = await createOpenCodeGoAdapter({
      credentialSources: [
        {
          name: "pi:opencode-go",
          source: fakeSource({
            status: "available",
            key: PI_KEY,
            path: PI_AUTH_PATH,
          }),
        },
        {
          name: "opencode:auth.json",
          source: {
            resolve: fallbackResolve,
            inspect: () => ({ status: "available", path: "/oc/auth.json" }),
          },
        },
      ],
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(fallbackResolve).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "error",
      error: "provider_request_rejected",
      sourcesTried: ["pi:opencode-go"],
    });
    expect(report.attempts).toEqual([
      {
        source: "pi:opencode-go",
        status: "failed",
        error: "provider_request_rejected",
      },
    ]);
  });

  it("marks an invalid Pi source degraded when the fallback works", async () => {
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources(
        { status: "available", key: KEY, path: "/oc/auth.json" },
        { status: "invalid", path: PI_AUTH_PATH },
      ),
      fetch: vi.fn(async () => usageResponse()),
    }).fetchQuota(OPTIONS);
    const interpreted = withQuotaSemantics(report, "2026-08-28T00:00:00.000Z");

    expect(report.attempts).toEqual([
      {
        source: "pi:opencode-go",
        status: "skipped",
        error: "opencode_go_credential_invalid",
        credentialPresent: true,
      },
      { source: "opencode:auth.json", status: "success" },
    ]);
    expect(interpreted.state.degradedSources).toEqual([
      {
        source: "pi:opencode-go",
        error: "opencode_go_credential_invalid",
      },
    ]);
  });

  it("keeps invalid stores indeterminate unless another source works", async () => {
    const invalidPi = await createOpenCodeGoAdapter({
      credentialSources: sources(
        { status: "missing", path: "/oc/auth.json" },
        { status: "invalid", path: PI_AUTH_PATH },
      ),
      fetch: vi.fn(async () => usageResponse()),
    }).fetchQuota(OPTIONS);
    expect(invalidPi.state).toMatchObject({
      status: "error",
      error: "opencode_go_credential_invalid",
    });

    const rejectedPi = await createOpenCodeGoAdapter({
      credentialSources: sources(
        { status: "invalid", path: "/oc/auth.json" },
        { status: "available", key: PI_KEY, path: PI_AUTH_PATH },
      ),
      fetch: vi.fn(async () => new Response(null, { status: 403 })),
    }).fetchQuota(OPTIONS);
    expect(rejectedPi.state).toMatchObject({
      status: "error",
      error: "opencode_go_credential_invalid",
    });
  });

  it("reports auth_required only after every candidate is rejected", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources(
        { status: "available", key: KEY, path: "/oc/auth.json" },
        { status: "available", key: PI_KEY, path: PI_AUTH_PATH },
      ),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
  });

  it("keeps an unreadable Pi source from turning opencode rejection into a sign-out", async () => {
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources(
        { status: "available", key: KEY, path: "/oc/auth.json" },
        { status: "error", path: PI_AUTH_PATH },
      ),
      fetch: vi.fn(async () => new Response(null, { status: 403 })),
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "credential_resolution_failed",
    });
  });

  it("never treats an absent credential as a measured provider", async () => {
    const request = vi.fn(async () => usageResponse());
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources({ status: "missing", path: "/oc/auth.json" }),
      fetch: request,
    }).fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "opencode_go_credential_unavailable",
    });
    expect(report.windows).toEqual([]);
  });

  it("reads a Pi opencode-go api_key entry from the Pi agent auth file", () => {
    withPiAuthFile(
      { "opencode-go": { type: "api_key", key: PI_KEY } },
      (path) => {
        expect(
          createPiOpenCodeGoCredentialSource(() => path).resolve(),
        ).toEqual({
          status: "available",
          key: PI_KEY,
          path,
        });
        expect(
          JSON.stringify(
            createPiOpenCodeGoCredentialSource(() => path).inspect(),
          ),
        ).not.toContain(PI_KEY);
      },
    );
  });

  it("ignores Pi's separate opencode Zen entry", () => {
    withPiAuthFile({ opencode: { type: "api_key", key: PI_KEY } }, (path) => {
      expect(createPiOpenCodeGoCredentialSource(() => path).resolve()).toEqual({
        status: "missing",
        path,
      });
    });
  });

  it.each([
    ["an unsupported type", { type: "oauth", access: PI_KEY }],
    ["an environment reference", { type: "api_key", key: "$OPENCODE_GO_KEY" }],
    ["a command reference", { type: "api_key", key: "!pass show opencode-go" }],
    ["an empty key", { type: "api_key", key: "  " }],
  ])(
    "reports a Pi entry holding %s as invalid, not missing",
    (_label, entry) => {
      withPiAuthFile({ "opencode-go": entry }, (path) => {
        expect(
          createPiOpenCodeGoCredentialSource(() => path).resolve(),
        ).toEqual({
          status: "invalid",
          path,
        });
      });
    },
  );

  it("reports both sources in auth inspection without credential material", async () => {
    const report = await createOpenCodeGoAdapter({
      credentialSources: sources(
        { status: "missing", path: "/oc/auth.json" },
        { status: "available", key: PI_KEY, path: PI_AUTH_PATH },
      ),
    }).inspectAuth(OPTIONS);

    expect(report.sources).toEqual([
      {
        source: "pi:opencode-go",
        path: PI_AUTH_PATH,
        status: "available",
      },
      {
        source: "opencode:auth.json",
        path: "/oc/auth.json",
        status: "missing",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(PI_KEY);
  });

  function withPiAuthFile(
    auth: Record<string, unknown>,
    assertions: (path: string) => void,
  ): void {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-opencode-go-pi-"));
    try {
      const path = join(directory, "auth.json");
      writeFileSync(path, JSON.stringify(auth));
      assertions(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("OpenCode Go Pi-auth opt-in", () => {
  const names = (sources: NamedOpenCodeGoCredentialSource[]) =>
    sources.map((source) => source.name);

  it("reads the OpenCode database ahead of the legacy auth.json by default", () => {
    expect(names(defaultOpenCodeGoCredentialSources({}))).toEqual([
      OPENCODE_GO_DB_CREDENTIAL_SOURCE,
      OPENCODE_GO_CREDENTIAL_SOURCE,
    ]);
  });

  it.each(["1", "true", "TRUE", " true "])(
    "reads Pi first when the flag is %j",
    (value) => {
      expect(
        names(
          defaultOpenCodeGoCredentialSources({
            [PI_OPENCODE_GO_AUTH_ENV]: value,
          }),
        ),
      ).toEqual([
        PI_OPENCODE_GO_SOURCE,
        OPENCODE_GO_DB_CREDENTIAL_SOURCE,
        OPENCODE_GO_CREDENTIAL_SOURCE,
      ]);
    },
  );

  it.each(["0", "yes", "", "false", undefined])(
    "stays Pi-free when the flag is %j",
    (value) => {
      expect(
        names(
          defaultOpenCodeGoCredentialSources({
            [PI_OPENCODE_GO_AUTH_ENV]: value,
          }),
        ),
      ).toEqual([
        OPENCODE_GO_DB_CREDENTIAL_SOURCE,
        OPENCODE_GO_CREDENTIAL_SOURCE,
      ]);
    },
  );

  it("reads the real Pi file-to-adapter path once opted in", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "quota-axi-opencode-go-optin-"),
    );
    const originalDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = directory;
      const path = join(directory, "auth.json");
      writeFileSync(
        path,
        JSON.stringify({ "opencode-go": { type: "api_key", key: PI_KEY } }),
      );

      const piSource = defaultOpenCodeGoCredentialSources({
        [PI_OPENCODE_GO_AUTH_ENV]: "1",
      }).find((source) => source.name === PI_OPENCODE_GO_SOURCE);

      expect(piSource?.source.resolve()).toEqual({
        status: "available",
        key: PI_KEY,
        path,
      });
      expect(JSON.stringify(piSource?.source.inspect())).not.toContain(PI_KEY);
    } finally {
      if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalDir;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("OpenCode Go database credential source", () => {
  const rows = (
    entries: Array<{
      id: string;
      integration: string;
      value: unknown;
      active?: number | null;
      created: number;
    }>,
    path: string,
  ): void => {
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, active INTEGER, time_created INTEGER NOT NULL)",
    );
    const insert = db.prepare(
      "INSERT INTO credential (id, integration_id, label, value, active, time_created) VALUES (?, ?, 'default', ?, ?, ?)",
    );
    for (const entry of entries) {
      insert.run(
        entry.id,
        entry.integration,
        typeof entry.value === "string"
          ? entry.value
          : JSON.stringify(entry.value),
        entry.active ?? null,
        entry.created,
      );
    }
    db.close();
  };

  async function withDatabase(
    entries: Parameters<typeof rows>[0],
    check: (path: string) => void | Promise<void>,
  ): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-opencode-db-"));
    try {
      const path = join(directory, "opencode.db");
      rows(entries, path);
      await check(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const keyValue = (key: string) => ({ type: "key", key });

  it("picks the active opencode-go row, then the newest, like OpenCode", async () => {
    await withDatabase(
      [
        {
          id: "a",
          integration: "opencode-go",
          value: keyValue("old"),
          created: 1,
        },
        {
          id: "b",
          integration: "opencode-go",
          value: keyValue(KEY),
          active: 1,
          created: 2,
        },
        {
          id: "c",
          integration: "opencode-go",
          value: keyValue("newer-inactive"),
          active: 0,
          created: 3,
        },
        {
          id: "d",
          integration: "other",
          value: keyValue("other"),
          active: 1,
          created: 4,
        },
      ],
      async (path) => {
        const source = createOpencodeGoDbCredentialSource(() => path);
        expect(await source.resolve()).toEqual({
          status: "available",
          key: KEY,
          path,
        });
        expect(JSON.stringify(await source.inspect())).not.toContain(KEY);
      },
    );
    await withDatabase(
      [
        {
          id: "a",
          integration: "opencode-go",
          value: keyValue("old"),
          created: 1,
        },
        {
          id: "b",
          integration: "opencode-go",
          value: keyValue(KEY),
          created: 2,
        },
      ],
      async (path) => {
        expect(
          await createOpencodeGoDbCredentialSource(() => path).resolve(),
        ).toEqual({
          status: "available",
          key: KEY,
          path,
        });
      },
    );
  });

  it.each([
    [
      "oauth",
      { type: "oauth", methodID: "m", refresh: "r", access: "a", expires: 1 },
    ],
    ["external", { type: "external", methodID: "m" }],
    ["template key", keyValue("${OPENCODE_API_KEY}")],
    ["command key", keyValue("!op read x")],
    ["empty key", keyValue("")],
    ["bad JSON", "{not json"],
    ["non-object", "42"],
  ])("rejects a %s value as invalid", async (_name, value) => {
    await withDatabase(
      [{ id: "a", integration: "opencode-go", value, active: 1, created: 1 }],
      async (path) => {
        expect(
          await createOpencodeGoDbCredentialSource(() => path).resolve(),
        ).toEqual({
          status: "invalid",
          path,
        });
      },
    );
  });

  it("reports missing for no file, no row, no table, and :memory:", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-opencode-db-"));
    try {
      const absent = join(directory, "nope.db");
      expect(
        (await createOpencodeGoDbCredentialSource(() => absent).resolve())
          .status,
      ).toBe("missing");
      expect(
        (await createOpencodeGoDbCredentialSource(() => ":memory:").resolve())
          .status,
      ).toBe("missing");
      const legacy = join(directory, "legacy.db");
      const db = new DatabaseSync(legacy);
      db.exec("CREATE TABLE session (id TEXT)");
      db.close();
      expect(
        (await createOpencodeGoDbCredentialSource(() => legacy).resolve())
          .status,
      ).toBe("missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    await withDatabase(
      [{ id: "a", integration: "anthropic", value: keyValue("x"), created: 1 }],
      async (path) => {
        expect(
          (await createOpencodeGoDbCredentialSource(() => path).resolve())
            .status,
        ).toBe("missing");
      },
    );
  });

  it("reports an unreadable database as an error, never a sign-out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-opencode-db-"));
    try {
      const path = join(directory, "opencode.db");
      writeFileSync(
        path,
        "this is not a sqlite database, just text padding".repeat(8),
      );
      expect(
        await createOpencodeGoDbCredentialSource(() => path).resolve(),
      ).toEqual({
        status: "error",
        path,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never writes the database", async () => {
    await withDatabase(
      [
        {
          id: "a",
          integration: "opencode-go",
          value: keyValue(KEY),
          active: 1,
          created: 1,
        },
      ],
      async (path) => {
        const before = readFileSync(path);
        const result = await createOpencodeGoDbCredentialSource(
          () => path,
        ).resolve();
        expect(result.status).toBe("available");
        expect(readFileSync(path).equals(before)).toBe(true);
      },
    );
  });

  it("resolves the path like OpenCode: XDG_DATA_HOME, then OPENCODE_DB", async () => {
    const original = { ...process.env };
    try {
      process.env.XDG_DATA_HOME = "/data/xdg";
      delete process.env.OPENCODE_DB;
      const path = async () =>
        (
          await defaultOpenCodeGoCredentialSources({})
            .find((s) => s.name === OPENCODE_GO_DB_CREDENTIAL_SOURCE)!
            .source.inspect()
        ).path;
      expect(await path()).toBe(join("/data/xdg", "opencode", "opencode.db"));
      process.env.OPENCODE_DB = "custom.db";
      expect(await path()).toBe(join("/data/xdg", "opencode", "custom.db"));
      process.env.OPENCODE_DB = "/abs/other.db";
      expect(await path()).toBe("/abs/other.db");
    } finally {
      process.env = original;
    }
  });

  it("skips an existing database without sqlite3 and keeps auth.json working", async () => {
    sqlite3.available = false;
    const fetchSpy = vi.fn(async () => usageResponse());
    await withDatabase(
      [
        {
          id: "a",
          integration: "opencode-go",
          value: keyValue(KEY),
          active: 1,
          created: 1,
        },
      ],
      async (path) => {
        const dbSource = createOpencodeGoDbCredentialSource(() => path);
        expect(await dbSource.resolve()).toEqual({ status: "skipped", path });
        const authSource = fakeSource({
          status: "available",
          key: "auth-json-key",
          path: "/auth.json",
        });
        const adapter = createOpenCodeGoAdapter({
          credentialSources: [
            { name: OPENCODE_GO_DB_CREDENTIAL_SOURCE, source: dbSource },
            { name: OPENCODE_GO_CREDENTIAL_SOURCE, source: authSource },
          ],
          fetch: fetchSpy as unknown as typeof fetch,
        });
        const quota = await adapter.fetchQuota(OPTIONS);
        expect(quota.attempts).toEqual([
          {
            source: OPENCODE_GO_DB_CREDENTIAL_SOURCE,
            status: "skipped",
            error: "sqlite3_unavailable",
            credentialPresent: true,
          },
          { source: OPENCODE_GO_CREDENTIAL_SOURCE, status: "success" },
        ]);
        const rejecting = createOpenCodeGoAdapter({
          credentialSources: [
            { name: OPENCODE_GO_DB_CREDENTIAL_SOURCE, source: dbSource },
            { name: OPENCODE_GO_CREDENTIAL_SOURCE, source: authSource },
          ],
          fetch: (async () =>
            new Response("", { status: 401 })) as unknown as typeof fetch,
        });
        expect((await rejecting.fetchQuota(OPTIONS)).state).toMatchObject({
          status: "error",
          error: "sqlite3_unavailable",
        });
        expect((await rejecting.inspectAuth(OPTIONS)).sources[0]).toEqual({
          source: OPENCODE_GO_DB_CREDENTIAL_SOURCE,
          path,
          status: "skipped",
          error: "sqlite3_unavailable",
          credentialPresent: true,
        });
      },
    );
  });

  it("reports an absent database as missing even without sqlite3", async () => {
    sqlite3.available = false;
    expect(
      (await createOpencodeGoDbCredentialSource(() => "/nope/x.db").resolve())
        .status,
    ).toBe("missing");
  });

  it("prefers the database key over a stale auth.json key end to end", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === `Bearer ${KEY}`
        ? usageResponse()
        : new Response("", { status: 401 });
    });
    await withDatabaseAsync(KEY, async (dbPath) => {
      const adapter = createOpenCodeGoAdapter({
        credentialSources: [
          {
            name: OPENCODE_GO_DB_CREDENTIAL_SOURCE,
            source: createOpencodeGoDbCredentialSource(() => dbPath),
          },
          {
            name: OPENCODE_GO_CREDENTIAL_SOURCE,
            source: fakeSource({
              status: "available",
              key: "stale-key",
              path: "/auth.json",
            }),
          },
        ],
        fetch: fetchSpy as unknown as typeof fetch,
      });
      const quota = await adapter.fetchQuota(OPTIONS);
      expect(quota.state.status).toBe("fresh");
      expect(quota.attempts).toEqual([
        { source: OPENCODE_GO_DB_CREDENTIAL_SOURCE, status: "success" },
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to auth.json when the database holds no opencode-go row", async () => {
    const fetchSpy = vi.fn(async () => usageResponse());
    const adapter = createOpenCodeGoAdapter({
      credentialSources: [
        {
          name: OPENCODE_GO_DB_CREDENTIAL_SOURCE,
          source: fakeSource({ status: "missing", path: "/x/opencode.db" }),
        },
        {
          name: OPENCODE_GO_CREDENTIAL_SOURCE,
          source: fakeSource({
            status: "available",
            key: KEY,
            path: "/auth.json",
          }),
        },
      ],
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const quota = await adapter.fetchQuota(OPTIONS);
    expect(quota.attempts).toEqual([
      {
        source: OPENCODE_GO_DB_CREDENTIAL_SOURCE,
        status: "skipped",
        error: "opencode_go_credential_unavailable",
      },
      { source: OPENCODE_GO_CREDENTIAL_SOURCE, status: "success" },
    ]);
  });

  it("reports an unreadable database as a local failure, not a rejection", async () => {
    const adapter = createOpenCodeGoAdapter({
      credentialSources: [
        {
          name: OPENCODE_GO_DB_CREDENTIAL_SOURCE,
          source: fakeSource({ status: "error", path: "/x/opencode.db" }),
        },
        {
          name: OPENCODE_GO_CREDENTIAL_SOURCE,
          source: fakeSource({ status: "missing", path: "/auth.json" }),
        },
      ],
      fetch: vi.fn() as unknown as typeof fetch,
    });
    const quota = await adapter.fetchQuota(OPTIONS);
    expect(quota.state).toMatchObject({
      status: "error",
      error: "credential_resolution_failed",
    });
  });
});

async function withDatabaseAsync(
  key: string,
  check: (path: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-opencode-db-"));
  try {
    const path = join(directory, "opencode.db");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, active INTEGER, time_created INTEGER NOT NULL)",
    );
    db.prepare(
      "INSERT INTO credential VALUES ('a', 'opencode-go', 'default', ?, 1, 1)",
    ).run(JSON.stringify({ type: "key", key }));
    db.close();
    await check(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
