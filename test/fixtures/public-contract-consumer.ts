import {
  compareModelsByRunway,
  SELECTION_SCALAR_KEY,
  type EffectiveAvailability,
  type ModelQuotaRecord,
  type ModelsResponse,
  type QuotaAxiResponse,
} from "quota-axi";

const quota: QuotaAxiResponse = {
  generatedAt: "2026-08-05T12:00:00.000Z",
  schemaVersion: 5,
  providers: [],
};

const model: ModelQuotaRecord = {
  provider: "claude",
  id: "consumer-fixture",
  label: "Consumer fixture",
  intelligence: "high",
  quotaScopes: [],
  state: { status: "fresh", stale: false },
};

const models: ModelsResponse = {
  generatedAt: quota.generatedAt,
  schemaVersion: 1,
  catalog: { version: "2026-08-05", provenance: "consumer fixture" },
  models: [model],
};

const scope: EffectiveAvailability = {
  scope: "all_models",
  status: "known",
  boundedBy: [],
  selection: { status: "known", [SELECTION_SCALAR_KEY]: 1.5 },
};
const spendPriority: number | undefined =
  scope.selection?.[SELECTION_SCALAR_KEY];

// Demoted fields are optional in the published contract: default `--json`
// omits them and `--full` supplies them.
const demoted: Array<string | undefined> = [
  quota.providers[0]?.label,
  quota.providers[0]?.source,
  quota.providers[0]?.state.sourcesTried?.[0],
  quota.providers[0]?.quotaSemantics?.description,
];

void models;
void spendPriority;
void demoted;
void compareModelsByRunway(model, model);
