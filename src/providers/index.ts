import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { grokAdapter } from "./grok.js";
import { kimiAdapter } from "./kimi.js";
import { tokenrouterAdapter } from "./tokenrouter.js";
import { openrouterAdapter } from "./openrouter.js";
import { pioneerAdapter } from "./pioneer.js";
import { commandcodeAdapter } from "./commandcode.js";
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
  kimi: kimiAdapter,
  tokenrouter: tokenrouterAdapter,
  openrouter: openrouterAdapter,
  pioneer: pioneerAdapter,
  commandcode: commandcodeAdapter,
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
