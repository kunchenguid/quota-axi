import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { tokenrouterAdapter } from "./tokenrouter.js";
import { openrouterAdapter } from "./openrouter.js";
import { pioneerAdapter } from "./pioneer.js";
import { commandcodeAdapter } from "./commandcode.js";
import { runpodAdapter } from "./runpod.js";
import { fireworksAdapter } from "./fireworks.js";
import { daytonaAdapter } from "./daytona.js";
import {
  PROVIDER_IDS,
  type ProviderAdapter,
  type ProviderId,
} from "../types.js";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  tokenrouter: tokenrouterAdapter,
  openrouter: openrouterAdapter,
  pioneer: pioneerAdapter,
  commandcode: commandcodeAdapter,
  runpod: runpodAdapter,
  fireworks: fireworksAdapter,
  daytona: daytonaAdapter,
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
