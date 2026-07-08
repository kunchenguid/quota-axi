import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { grokAdapter } from "./grok.js";
import {
  PROVIDER_IDS,
  type ProviderAdapter,
  type ProviderId,
} from "../types.js";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  copilot: copilotAdapter,
  grok: grokAdapter,
};

export function parseProviders(value: string | undefined): ProviderId[] {
  if (!value) return [...PROVIDER_IDS];
  const providers = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = providers.find((provider) => !isProviderId(provider));
  if (invalid) {
    throw new Error(`unsupported provider: ${invalid}`);
  }
  return providers as ProviderId[];
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}
