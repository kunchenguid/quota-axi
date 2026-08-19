#!/usr/bin/env tsx
/**
 * Maintainer-only curation aid. It never writes the catalog and never prints
 * Artificial Analysis scores. Set AA_API_KEY for this one command, then review
 * the suggestions and edit src/model-kb.ts deliberately.
 *
 * Optional --provider-models <file> accepts a reviewed JSON array of current
 * first-party provider model records ({ provider, id, label? }) so additions
 * can be compared before a human updates the committed catalog.
 */
import { readFile } from "node:fs/promises";

import { MODEL_CATALOG } from "../src/model-kb.js";
import { validateModelCatalog } from "../src/models.js";

type ProviderModel = {
  provider: string;
  id: string;
  label?: string;
};

type AaModel = {
  name?: string;
  slug?: string;
  model_creator?: string;
};

const AA_MODELS_URL =
  "https://api.artificialanalysis.ai/api/v2/data/llms/models";

async function main(): Promise<void> {
  validateModelCatalog(MODEL_CATALOG);
  const key = process.env.AA_API_KEY;
  if (!key) {
    throw new Error(
      "AA_API_KEY is required for this maintainer-only refresh aid",
    );
  }

  const providerModels = await loadProviderModels(process.argv.slice(2));
  const response = await fetch(AA_MODELS_URL, {
    headers: { "x-api-key": key, accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(
      `Artificial Analysis request failed: HTTP ${response.status}`,
    );
  const payload: unknown = await response.json();
  const aaModels = modelsFromPayload(payload);
  const known = new Set(
    MODEL_CATALOG.entries.map((entry) => `${entry.provider}/${entry.id}`),
  );

  console.log(`Catalog version: ${MODEL_CATALOG.version}`);
  console.log(`Catalog entries: ${MODEL_CATALOG.entries.length}`);
  console.log(`Artificial Analysis model records fetched: ${aaModels.length}`);
  if (providerModels.length === 0) {
    console.log(
      "Provider list: none supplied (pass --provider-models <reviewed-json>)",
    );
    return;
  }

  const additions = providerModels.filter(
    (model) => !known.has(`${model.provider}/${model.id}`),
  );
  console.log(`Provider model records reviewed: ${providerModels.length}`);
  if (additions.length === 0) {
    console.log("Suggested catalog additions: none");
    return;
  }
  console.log(
    "Suggested catalog additions (review intelligence buckets manually):",
  );
  for (const model of additions) {
    const aaMatch = aaModels.some((candidate) =>
      matchesAaModel(model, candidate),
    );
    console.log(
      `- ${model.provider}/${model.id}${model.label ? ` (${model.label})` : ""}; AA name match: ${aaMatch ? "yes" : "no"}`,
    );
  }
}

async function loadProviderModels(args: string[]): Promise<ProviderModel[]> {
  if (args.length === 0) return [];
  if (args.length !== 2 || args[0] !== "--provider-models") {
    throw new Error(
      "usage: refresh-model-kb.ts [--provider-models <reviewed-json>]",
    );
  }
  const parsed: unknown = JSON.parse(await readFile(args[1]!, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error("provider model list must be a JSON array");
  return parsed.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.provider !== "string" ||
      typeof value.id !== "string" ||
      (value.label !== undefined && typeof value.label !== "string")
    ) {
      throw new Error(
        "each provider model requires string provider, id, and optional label",
      );
    }
    return value;
  });
}

function modelsFromPayload(payload: unknown): AaModel[] {
  if (!payload || typeof payload !== "object") return [];
  const records =
    "data" in payload
      ? payload.data
      : "models" in payload
        ? payload.models
        : [];
  return Array.isArray(records)
    ? records.filter((record): record is AaModel =>
        Boolean(record && typeof record === "object"),
      )
    : [];
}

function matchesAaModel(model: ProviderModel, candidate: AaModel): boolean {
  const haystack = [candidate.name, candidate.slug, candidate.model_creator]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(model.id.toLowerCase());
}

await main();
