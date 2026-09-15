import {
  AUTH_RESPONSE_SCHEMA_VERSION,
  compareModelsByRunway,
  MODELS_RESPONSE_SCHEMA_VERSION,
  QUOTA_RESPONSE_SCHEMA_VERSION,
  SELECTION_SCALAR_KEY,
  type AuthResponse,
  type EffectiveAvailability,
  type ModelQuotaRecord,
  type ModelsResponse,
  type ProviderOptions,
  type QuotaAxiResponse,
} from "quota-axi";

const profileOnlyOptions: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
  credentialMode: "profile-only",
};

const quota: QuotaAxiResponse = {
  generatedAt: "2026-08-05T12:00:00.000Z",
  schemaVersion: QUOTA_RESPONSE_SCHEMA_VERSION,
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
  schemaVersion: MODELS_RESPONSE_SCHEMA_VERSION,
  catalog: { version: "2026-08-05", provenance: "consumer fixture" },
  models: [model],
};

const auth: AuthResponse = {
  generatedAt: quota.generatedAt,
  schemaVersion: AUTH_RESPONSE_SCHEMA_VERSION,
  auth: [],
};

const scope: EffectiveAvailability = {
  scope: "all_models",
  status: "known",
  boundedBy: [],
  selection: { status: "known", [SELECTION_SCALAR_KEY]: 1.5 },
};
const spendPriority: number | undefined =
  scope.selection?.[SELECTION_SCALAR_KEY];
const quotaSchemaVersion: 6 = quota.schemaVersion;
const modelsSchemaVersion: 2 = models.schemaVersion;
const authSchemaVersion: 2 = auth.schemaVersion;

// Demoted fields are optional in the published contract: default `--json`
// omits them and `--full` supplies them.
const demoted: Array<string | undefined> = [
  quota.providers[0]?.label,
  quota.providers[0]?.source,
  quota.providers[0]?.state.sourcesTried?.[0],
  quota.providers[0]?.quotaSemantics?.description,
];

void auth;
void models;
void profileOnlyOptions;
void spendPriority;
void demoted;
void quotaSchemaVersion;
void modelsSchemaVersion;
void authSchemaVersion;
void compareModelsByRunway(model, model);
