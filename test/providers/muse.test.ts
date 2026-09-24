import { annotateQuotaAdvice } from "../../src/advice.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createMuseAdapter,
  defaultMuseCredentialSources,
  MUSE_API_URL,
  MUSE_AUTH_FILE_SOURCE,
  MUSE_API_KEY_SOURCE,
  MUSE_INFERENCE_REMEDY_COMMAND,
  museAuthFilePath,
} from "../../src/providers/muse.js";
import type { ProviderOptions } from "../../src/types.js";

const KEY = "synthetic-muse-key";
const FILE_KEY = "synthetic-muse-file-key";
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const OPTIONS: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};
const SUBSCRIPTION = {
  subscription: {
    window: {
      used_percent: "24",
      resets_at: "1790870400",
      window_duration_mins: 300,
    },
    weekly: { used_percent: "65", resets_at: "1791505200" },
  },
};

let tempDir: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

type Request = { url: string; init?: RequestInit };

function adapterFor(
  args: {
    environment?: Readonly<Record<string, string | undefined>>;
    responses?: Response[];
    processes?: RunningProcessList;
  } = {},
) {
  const requests: Request[] = [];
  const processList = vi.fn(
    async () => args.processes ?? { status: "listed" as const, processes: [] },
  );
  let responseIndex = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return args.responses?.[responseIndex++] ?? quotaResponse();
  };
  const environment = args.environment ?? {
    META_API_KEY: KEY,
    MUSE_AUTH_PATH: missingAuthPath(),
  };
  const adapter = createMuseAdapter({
    sources: defaultMuseCredentialSources(environment),
    fetch,
    listRunningCommandLines: processList,
    now: () => NOW,
  });
  return { adapter, requests, processList };
}

function quotaResponse(): Response {
  return new Response(event(SUBSCRIPTION), {
    headers: { "content-type": "text/event-stream" },
  });
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function writeAuthFile(key: string, mode = 0o600): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "quota-axi-muse-"));
  const path = join(tempDir, "auth.json");
  writeFileSync(
    path,
    JSON.stringify({ providers: { meta: { api_key: key } } }),
    {
      mode,
    },
  );
  chmodSync(path, mode);
  return path;
}
function missingAuthPath(): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "quota-axi-muse-"));
  return join(tempDir, "missing-auth.json");
}

describe("Muse Code quota provider", () => {
  it("does not spend a prompt or inspect processes without the opt-in", async () => {
    const { adapter, requests, processList } = adapterFor();

    const report = await adapter.fetchQuota(OPTIONS);

    expect(requests).toHaveLength(0);
    expect(processList).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "unavailable",
      error: "muse_inference_opt_in_required",
    });
    expect(report.state.authStatus).toBeUndefined();
    const advised = annotateQuotaAdvice({
      generatedAt: new Date(NOW).toISOString(),
      providers: [report],
    });
    expect(advised.providers[0]?.state).toMatchObject({
      reason: "inference_opt_in_required",
      remedyCommand: MUSE_INFERENCE_REMEDY_COMMAND,
    });
    expect(advised.help?.[0]).toContain(
      "spends at most one successful streamed",
    );
  });
  it("reports absent credentials without probing the process list", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-muse-"));
    const { adapter, requests, processList } = adapterFor({
      environment: { MUSE_AUTH_PATH: join(tempDir, "missing-auth.json") },
    });

    const report = await adapter.fetchQuota({
      ...OPTIONS,
      allowMuseInference: true,
    });

    expect(requests).toHaveLength(0);
    expect(processList).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.attempts).toEqual([
      { source: MUSE_API_KEY_SOURCE, status: "skipped" },
      { source: MUSE_AUTH_FILE_SOURCE, status: "skipped" },
    ]);
  });

  it("reports sign-out only after every key is rejected", async () => {
    const path = writeAuthFile(FILE_KEY);
    const { adapter, requests } = adapterFor({
      environment: { META_API_KEY: KEY, MUSE_AUTH_PATH: path },
      responses: [
        new Response(null, { status: 401 }),
        new Response(null, { status: 403 }),
      ],
    });

    const report = await adapter.fetchQuota({
      ...OPTIONS,
      allowMuseInference: true,
    });

    expect(requests).toHaveLength(2);
    expect(report.state.status).toBe("auth_required");
    expect(report.attempts?.map(({ status }) => status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain(FILE_KEY);
  });

  it("sends one bounded prompt and stops at the first usable stream event", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(event({ choices: [{ text: "not quota" }] })),
        );
        controller.enqueue(new TextEncoder().encode(event(SUBSCRIPTION)));
        controller.enqueue(new TextEncoder().encode(event(SUBSCRIPTION)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { adapter, requests, processList } = adapterFor({
      environment: {
        META_API_KEY: KEY,
        MUSE_AUTH_PATH: writeAuthFile(FILE_KEY),
      },
      responses: [new Response(stream)],
    });

    const report = await adapter.fetchQuota({
      ...OPTIONS,
      allowMuseInference: true,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(MUSE_API_URL);
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "manual",
    });
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("cookie")).toBeNull();
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      model: "muse-spark-1.3",
      input: "ping",
      stream: true,
      max_output_tokens: 16,
    });
    expect(processList).toHaveBeenCalledOnce();
    expect(cancelled).toBe(true);
    expect(report).toMatchObject({
      provider: "muse-code",
      label: "Muse Code",
      source: "api",
      state: { status: "fresh", authStatus: "usable" },
      windows: [
        {
          id: "five_hour",
          percentUsed: 24,
          percentRemaining: 76,
          windowSeconds: 18_000,
        },
        {
          id: "weekly",
          percentUsed: 65,
          percentRemaining: 35,
          windowSeconds: 604_800,
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(report.attempts).toEqual([
      { source: MUSE_API_KEY_SOURCE, status: "success" },
      {
        source: MUSE_AUTH_FILE_SOURCE,
        status: "skipped",
        credentialPresent: true,
        degraded: false,
      },
    ]);
    const interpreted = withQuotaSemantics(report, new Date(NOW).toISOString());
    expect(interpreted.quotaSemantics?.effectiveAvailability).toHaveLength(1);
  });

  it("tries the protected Muse auth file after an env key is rejected", async () => {
    const path = writeAuthFile(FILE_KEY);
    const { adapter, requests } = adapterFor({
      environment: { META_API_KEY: KEY, MUSE_AUTH_PATH: path },
      responses: [new Response(null, { status: 401 }), quotaResponse()],
    });

    const report = await adapter.fetchQuota({
      ...OPTIONS,
      allowMuseInference: true,
    });

    expect(requests).toHaveLength(2);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(
      `Bearer ${FILE_KEY}`,
    );
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual([
      {
        source: MUSE_API_KEY_SOURCE,
        status: "failed",
        error: "provider_auth_rejected",
        credentialPresent: true,
      },
      { source: MUSE_AUTH_FILE_SOURCE, status: "success" },
    ]);
    expect(JSON.stringify(report)).not.toContain(FILE_KEY);
  });

  it("stops source handover after a transient rate limit", async () => {
    const path = writeAuthFile(FILE_KEY);
    const { adapter, requests } = adapterFor({
      environment: { META_API_KEY: KEY, MUSE_AUTH_PATH: path },
      responses: [
        new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      ],
    });

    const report = await adapter.fetchQuota({
      ...OPTIONS,
      allowMuseInference: true,
    });

    expect(requests).toHaveLength(1);
    expect(report.state).toMatchObject({
      status: "rate_limited",
      retryAfter: new Date(NOW + 60_000).toISOString(),
    });
    expect(report.attempts?.map(({ status }) => status)).toEqual([
      "failed",
      "skipped",
    ]);
  });

  it("rejects auth files that other users can read", async ({ skip }) => {
    if (process.platform === "win32") skip();
    const path = writeAuthFile(FILE_KEY, 0o644);
    const { adapter, requests } = adapterFor({
      environment: { MUSE_AUTH_PATH: path },
    });

    const report = await adapter.fetchQuota({
      ...OPTIONS,
      allowMuseInference: true,
    });

    expect(requests).toHaveLength(0);
    expect(report.state.error).toBe("muse_auth_file_permissions_unsafe");
    expect(report.attempts).toContainEqual({
      source: MUSE_AUTH_FILE_SOURCE,
      status: "failed",
      error: "muse_auth_file_permissions_unsafe",
      credentialPresent: true,
    });
  });

  it.each([
    [
      "Muse is running",
      {
        status: "listed",
        processes: [{ pid: 4444, commandLine: "muse chat" }],
      },
    ],
    ["the process list is unavailable", { status: "unavailable" }],
  ] as const)("does not send a prompt when %s", async (_label, processes) => {
    const { adapter, requests } = adapterFor({ processes });

    const report = await adapter.fetchQuota({
      ...OPTIONS,
      allowMuseInference: true,
    });

    expect(requests).toHaveLength(0);
    expect(report.state.authStatus).toBeUndefined();
    expect(report.state.error).toBe(
      processes.status === "listed"
        ? "muse_cli_running"
        : "muse_process_state_unavailable",
    );
  });

  it("uses MUSE_AUTH_PATH before the default XDG path", () => {
    expect(
      museAuthFilePath({
        MUSE_AUTH_PATH: "/tmp/muse-auth.json",
        XDG_CONFIG_HOME: "/tmp/config",
      }),
    ).toBe("/tmp/muse-auth.json");
    expect(museAuthFilePath({ XDG_CONFIG_HOME: "/tmp/config" })).toBe(
      join("/tmp/config", "muse", "auth.json"),
    );
  });
});
