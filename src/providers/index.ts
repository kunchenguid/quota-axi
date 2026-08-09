import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { grokAdapter } from "./grok.js";
import { kimiAdapter } from "./kimi.js";
import { agyAdapter } from "./agy.js";
import {
  DEFAULT_PROVIDER_IDS,
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
  antigravity: agyAdapter,
};

export function parseProviders(value: string | undefined): ProviderId[] {
  if (!value) return [...DEFAULT_PROVIDER_IDS];
  const providers = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = providers.find((provider) => !isProviderId(provider));
  if (invalid) {
    throw new Error(`unsupported provider: ${invalid}`);
  }
  return [...new Set(providers)] as ProviderId[];
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}
