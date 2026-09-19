import { agyAdapter } from "./agy.js";
import { alibabaAdapter } from "./alibaba.js";
import { claudeAdapter } from "./claude.js";
import { commandCodeAdapter } from "./commandcode.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { grokAdapter } from "./grok.js";
import { kimiAdapter } from "./kimi.js";
import { minimaxAdapter } from "./minimax.js";
import { opencodeGoAdapter } from "./opencode-go.js";
import { openrouterAdapter } from "./openrouter.js";
import { zaiAdapter } from "./zai.js";
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
  zai: zaiAdapter,
  agy: agyAdapter,
  alibaba: alibabaAdapter,
  "opencode-go": opencodeGoAdapter,
  commandcode: commandCodeAdapter,
  minimax: minimaxAdapter,
  openrouter: openrouterAdapter,
};

export function parseProviders(value: string | undefined): ProviderId[] {
  // No `--provider` selector: stick to the explicit default list so opt-in
  // adapters (`minimax`, `openrouter`) never appear in a default probe. They
  // still validate against {@link PROVIDER_IDS} so an explicit selector can
  // name them.
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
