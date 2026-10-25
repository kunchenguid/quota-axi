import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createMistralAdapter,
  MISTRAL_ENV_SOURCE,
  MISTRAL_PI_SOURCE,
  MISTRAL_POLYTOKEN_SOURCE,
  resolveMistralCredentials,
} from "../../src/providers/mistral.js";
import { SELECTION_SCALAR_KEY } from "../../src/types.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const SYNTHETIC_KEY = "synthetic-mistral-key";
const UNAVAILABLE = "mistral_credential_unavailable";
const GENERATED_AT = "2026-09-01T00:00:00.000Z";
const ALL_SOURCES = [
  MISTRAL_ENV_SOURCE,
  MISTRAL_PI_SOURCE,
  MISTRAL_POLYTOKEN_SOURCE,
];

let dir: string;
const piPath = () => join(dir, "auth.json");
const polytokenPath = () => join(dir, "config.yaml");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quota-axi-mistral-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function writePiStore(store: unknown): void {
  writeFileSync(piPath(), JSON.stringify(store), { mode: 0o600 });
}

function writePolytokenConfig(text: string): void {
  writeFileSync(polytokenPath(), text, { mode: 0o600 });
}

function polytokenYaml(mistralAuth: string): string {
  return [
    "version: 4",
    "providers:",
    "  other:",
    "    auth:",
    "      type: static_key",
    "      key: synthetic-other-provider-key",
    "  mistral:",
    "    kind:",
    "      type: catalog",
    "      name: mistral",
    "    auth:",
    mistralAuth,
    "",
  ].join("\n");
}

/** Binds the adapter to this test's synthetic stores only. */
function adapterFor(
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  return createMistralAdapter({
    now: () => Date.parse(GENERATED_AT),
    credential: () =>
      resolveMistralCredentials(environment, piPath(), polytokenPath()),
  });
}

/** Mistral never sends a request: a usable key is model auth, not a quota read. */
function stubNoFetch() {
  const fetch = vi.fn(async () => {
    throw new Error("Mistral must not send a quota request");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const skipped = (source: string) => ({
  source,
  status: "skipped" as const,
  error: UNAVAILABLE,
});

describe("Mistral provider", () => {
  it("reports a usable env key as usable without spending inference", async () => {
    const fetch = stubNoFetch();

    const report = await adapterFor({
      MISTRAL_API_KEY: SYNTHETIC_KEY,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "mistral",
      source: "api",
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        sourcesTried: [MISTRAL_ENV_SOURCE],
      },
      attempts: [{ source: MISTRAL_ENV_SOURCE, status: "success" }],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_KEY);
  });

  it("reads Pi's mistral entry as its own source", async () => {
    const fetch = stubNoFetch();
    writePiStore({ mistral: { type: "api_key", key: SYNTHETIC_KEY } });

    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "mistral",
      windows: [],
      state: {
        status: "fresh",
        authStatus: "usable",
        sourcesTried: [MISTRAL_ENV_SOURCE, MISTRAL_PI_SOURCE],
      },
    });
    expect(report.attempts).toEqual([
      skipped(MISTRAL_ENV_SOURCE),
      { source: MISTRAL_PI_SOURCE, status: "success" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads Polytoken's mistral static_key without retaining other providers' keys", async () => {
    const fetch = stubNoFetch();
    writePolytokenConfig(
      polytokenYaml(`      type: static_key\n      key: ${SYNTHETIC_KEY}`),
    );

    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "mistral",
      windows: [],
      state: {
        status: "fresh",
        authStatus: "usable",
        sourcesTried: ALL_SOURCES,
      },
    });
    expect(report.attempts).toEqual([
      skipped(MISTRAL_ENV_SOURCE),
      skipped(MISTRAL_PI_SOURCE),
      { source: MISTRAL_POLYTOKEN_SOURCE, status: "success" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SYNTHETIC_KEY);
    expect(serialized).not.toContain("synthetic-other-provider-key");
  });

  it("keeps the declared source order: env, then Pi, then Polytoken", async () => {
    writePiStore({ mistral: { type: "api_key", key: SYNTHETIC_KEY } });
    writePolytokenConfig(
      polytokenYaml(`      type: static_key\n      key: ${SYNTHETIC_KEY}`),
    );

    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report.state.sourcesTried).toEqual([
      MISTRAL_ENV_SOURCE,
      MISTRAL_PI_SOURCE,
    ]);
    expect(report.attempts).toEqual([
      skipped(MISTRAL_ENV_SOURCE),
      { source: MISTRAL_PI_SOURCE, status: "success" },
    ]);
  });

  it("reports a machine without any Mistral credential as not set up", async () => {
    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      state: {
        status: "auth_required",
        error: UNAVAILABLE,
        sourcesTried: ALL_SOURCES,
      },
    });
    expect(report.attempts).toEqual(ALL_SOURCES.map(skipped));
    for (const attempt of report.attempts ?? []) {
      expect(attempt.credentialPresent).toBeUndefined();
    }
  });

  it.each([
    [
      "a non-static auth type",
      "      type: oauth\n      key: synthetic-mistral-key",
    ],
    ["a template key", "      type: static_key\n      key: ${MISTRAL_API_KEY}"],
    ["no key", "      type: static_key"],
  ])(
    "keeps a present but unusable Polytoken entry visible: %s",
    async (_label, auth) => {
      writePolytokenConfig(polytokenYaml(auth));

      const report = await adapterFor().fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        source: "unavailable",
        state: { status: "auth_required", error: "mistral_credential_invalid" },
      });
      expect(report.attempts).toContainEqual({
        source: MISTRAL_POLYTOKEN_SOURCE,
        status: "failed",
        error: "mistral_credential_invalid",
        credentialPresent: true,
      });
    },
  );

  it("treats a Polytoken config without a mistral provider as missing", () => {
    writePolytokenConfig("version: 4\nproviders:\n  other:\n    auth: {}\n");

    expect(
      resolveMistralCredentials({}, piPath(), polytokenPath()),
    ).toContainEqual({
      status: "missing",
      source: MISTRAL_POLYTOKEN_SOURCE,
      path: polytokenPath(),
    });
  });

  it("marks an unparseable Polytoken config as present rather than absent", async () => {
    writePolytokenConfig("providers: [unclosed\n");

    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report.attempts).toContainEqual({
      source: MISTRAL_POLYTOKEN_SOURCE,
      status: "failed",
      error: "mistral_credential_invalid",
      credentialPresent: true,
    });
  });

  it("inspects every declared source", async () => {
    writePolytokenConfig(
      polytokenYaml(`      type: static_key\n      key: ${SYNTHETIC_KEY}`),
    );

    const auth = await adapterFor().inspectAuth(OPTIONS);

    expect(auth).toEqual({
      provider: "mistral",
      sources: [
        { source: MISTRAL_ENV_SOURCE, status: "missing" },
        { source: MISTRAL_PI_SOURCE, path: piPath(), status: "missing" },
        {
          source: MISTRAL_POLYTOKEN_SOURCE,
          path: polytokenPath(),
          status: "available",
          credentialPresent: true,
        },
      ],
    });
  });

  it("publishes a fixed spendPriority of 0 with unknown runway when usable", async () => {
    const report = await adapterFor({
      MISTRAL_API_KEY: SYNTHETIC_KEY,
    }).fetchQuota(OPTIONS);

    const semantics = withQuotaSemantics(report, GENERATED_AT).quotaSemantics;

    expect(semantics?.effectiveAvailability).toEqual([
      {
        scope: "all_models",
        status: "unknown",
        boundedBy: [],
        pace: { status: "unknown" },
        runway: { status: "unknown" },
        selection: { status: "known", [SELECTION_SCALAR_KEY]: 0 },
      },
    ]);
  });

  it("publishes no scope and unknown selection without a usable credential", async () => {
    const report = await adapterFor().fetchQuota(OPTIONS);

    const semantics = withQuotaSemantics(report, GENERATED_AT).quotaSemantics;

    expect(semantics?.status).toBe("unknown");
    expect(semantics?.effectiveAvailability).toEqual([]);
  });
});
