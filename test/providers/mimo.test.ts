import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMimoAdapter,
  MIMO_ENV_SOURCE,
  MIMO_PI_PROVIDER_IDS,
  mimoPiSource,
  resolveMimoCredentials,
} from "../../src/providers/mimo.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const SYNTHETIC_MIMO_KEY = "synthetic-mimo-key";
const UNAVAILABLE = "mimo_credential_unavailable";
const ALL_PI_SOURCES = MIMO_PI_PROVIDER_IDS.map(mimoPiSource);

let piDir: string;
const piPath = () => join(piDir, "auth.json");

beforeEach(() => {
  piDir = mkdtempSync(join(tmpdir(), "quota-axi-mimo-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(piDir, { recursive: true, force: true });
});

function writePiStore(store: unknown): void {
  writeFileSync(piPath(), JSON.stringify(store), { mode: 0o600 });
}

/** Binds the adapter to this test's Pi store so no machine credential decides. */
function adapterFor(
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  return createMimoAdapter({
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    credential: () => resolveMimoCredentials(environment, piPath()),
  });
}

const skipped = (source: string) => ({
  source,
  status: "skipped" as const,
  error: UNAVAILABLE,
});

/** MiMo never sends a request: a usable key is model auth, not a quota read. */
function stubNoFetch() {
  const fetch = vi.fn(async () => {
    throw new Error("MiMo must not send a quota request");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("MiMo provider", () => {
  it("reports local model authentication as usable without fabricating dashboard quota", async () => {
    const fetch = stubNoFetch();

    const report = await adapterFor({
      MIMO_API_KEY: SYNTHETIC_MIMO_KEY,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "mimo",
      source: "api",
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        sourcesTried: [MIMO_ENV_SOURCE],
      },
      attempts: [{ source: MIMO_ENV_SOURCE, status: "success" }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(MIMO_PI_PROVIDER_IDS.map((id, index) => ({ id, index })))(
    "reads Pi's $id entry as its own source, naming the entry that answered",
    async ({ id, index }) => {
      const fetch = stubNoFetch();
      writePiStore({
        [id]: { type: "api_key", key: SYNTHETIC_MIMO_KEY },
      });
      const declared = [
        MIMO_ENV_SOURCE,
        ...MIMO_PI_PROVIDER_IDS.slice(0, index + 1).map(mimoPiSource),
      ];
      const answered = declared[declared.length - 1];

      const report = await adapterFor().fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        provider: "mimo",
        source: "api",
        windows: [],
        state: {
          status: "fresh",
          stale: false,
          authStatus: "usable",
          sourcesTried: declared,
        },
      });
      expect(report.attempts).toEqual([
        skipped(MIMO_ENV_SOURCE),
        ...declared.slice(1, -1).map((source) => skipped(source)),
        { source: answered, status: "success" },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps the environment credential first in the declared source order", async () => {
    writePiStore({ xiaomi: { type: "api_key", key: SYNTHETIC_MIMO_KEY } });

    const report = await adapterFor({
      MIMO_API_KEY: "env-key",
    }).fetchQuota(OPTIONS);

    expect(report.state.sourcesTried).toEqual([MIMO_ENV_SOURCE]);
    expect(report.attempts).toEqual([
      { source: MIMO_ENV_SOURCE, status: "success" },
    ]);
  });

  it("treats template and missing API keys as unavailable", () => {
    expect(
      resolveMimoCredentials({ MIMO_API_KEY: "${MIMO_API_KEY}" }, piPath()),
    ).toEqual([
      { status: "missing", source: MIMO_ENV_SOURCE },
      ...ALL_PI_SOURCES.map((source) => ({
        status: "missing",
        source,
        path: piPath(),
      })),
    ]);
  });

  it("reports a machine without any MiMo credential as not set up", async () => {
    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      state: {
        status: "auth_required",
        error: UNAVAILABLE,
        sourcesTried: [MIMO_ENV_SOURCE, ...ALL_PI_SOURCES],
      },
    });
    expect(report.attempts).toEqual([
      skipped(MIMO_ENV_SOURCE),
      ...ALL_PI_SOURCES.map(skipped),
    ]);
    for (const attempt of report.attempts ?? []) {
      expect(attempt.credentialPresent).toBeUndefined();
    }
  });

  it.each([
    ["empty entry", {}],
    ["entry without a key", { type: "api_key" }],
    ["unknown entry type", { type: "totally-unknown", access: "x" }],
    ["OAuth-shaped entry", { type: "oauth", access: "x" }],
  ])(
    "keeps a present but unusable Pi entry visible as a credential",
    async (_label, entry) => {
      writePiStore({ "xiaomi-token-plan-sgp": entry });

      const report = await adapterFor().fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        source: "unavailable",
        state: {
          status: "auth_required",
          error: "mimo_credential_invalid",
        },
      });
      expect(report.attempts).toContainEqual({
        source: mimoPiSource("xiaomi-token-plan-sgp"),
        status: "failed",
        error: "mimo_credential_invalid",
        credentialPresent: true,
      });
      expect(report.attempts).toContainEqual(skipped(mimoPiSource("xiaomi")));
    },
  );

  it("marks an unparseable Pi store as present rather than absent", async () => {
    writeFileSync(piPath(), "not json", { mode: 0o600 });

    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report.state.status).toBe("auth_required");
    for (const source of ALL_PI_SOURCES) {
      expect(report.attempts).toContainEqual({
        source,
        status: "failed",
        error: "mimo_credential_invalid",
        credentialPresent: true,
      });
    }
  });

  it("marks an unreadable Pi store as present rather than absent", async () => {
    // A store that exists but cannot be read still is not an absent source:
    // README lets a read failure carry credentialPresent, and both the quota
    // and auth paths must say the same thing about it.
    mkdirSync(piPath(), { recursive: true });

    const report = await adapterFor().fetchQuota(OPTIONS);
    const auth = await adapterFor().inspectAuth(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "mimo_credential_resolution_failed",
    });
    for (const source of ALL_PI_SOURCES) {
      expect(report.attempts).toContainEqual({
        source,
        status: "failed",
        error: "mimo_credential_resolution_failed",
        credentialPresent: true,
      });
      expect(auth.sources).toContainEqual({
        source,
        path: piPath(),
        status: "error",
        error: "mimo_credential_resolution_failed",
        credentialPresent: true,
      });
    }
  });

  it("inspects every declared source, marking the ones that are not absent", async () => {
    writePiStore({ xiaomi: { type: "api_key", key: SYNTHETIC_MIMO_KEY } });

    const auth = await adapterFor().inspectAuth(OPTIONS);

    expect(auth).toEqual({
      provider: "mimo",
      sources: [
        { source: MIMO_ENV_SOURCE, status: "missing" },
        {
          source: mimoPiSource("xiaomi"),
          path: piPath(),
          status: "available",
          credentialPresent: true,
        },
        ...ALL_PI_SOURCES.slice(1).map((source) => ({
          source,
          path: piPath(),
          status: "missing",
        })),
      ],
    });
  });

  it("marks a present-but-unusable entry in auth the same way the quota path does", async () => {
    writePiStore({ xiaomi: { type: "oauth", access: "x" } });

    const auth = await adapterFor().inspectAuth(OPTIONS);

    expect(auth.sources).toContainEqual({
      source: mimoPiSource("xiaomi"),
      path: piPath(),
      status: "invalid",
      error: "mimo_credential_invalid",
      credentialPresent: true,
    });
  });
});
