import type { ModelCatalog } from "./types.js";

/**
 * A deliberately coarse, editorial catalog of provider-native models.
 *
 * Buckets are relative to the current general-purpose frontier, not scores or
 * claims of exact capability. They are maintained from public provider
 * materials and leaderboards, including Artificial Analysis, without copying
 * or redistributing any third-party scores.
 */
export const MODEL_CATALOG: ModelCatalog = {
  version: "2026-08-05",
  provenance:
    "Curated editorial intelligence buckets informed by public provider materials and leaderboards, including Artificial Analysis (https://artificialanalysis.ai/). No third-party scores are reproduced.",
  entries: [
    {
      provider: "minimax",
      id: "minimax-m3",
      label: "MiniMax M3",
      intelligence: "high",
      windowIds: ["model:minimax-m3"],
      aliases: ["MiniMax-M3", "MiniMax M3"],
    },
    {
      provider: "minimax",
      id: "minimax-m2.7",
      label: "MiniMax M2.7",
      intelligence: "high",
      windowIds: ["model:minimax-m2.7"],
      aliases: ["MiniMax-M2.7", "MiniMax M2.7"],
    },
    {
      provider: "minimax",
      id: "minimax-m2.7-highspeed",
      label: "MiniMax M2.7 Highspeed",
      intelligence: "medium",
      windowIds: ["model:minimax-m2.7-highspeed"],
      aliases: ["MiniMax-M2.7-highspeed"],
    },
    {
      provider: "mimo",
      id: "mimo-v2.5-pro",
      label: "MiMo V2.5 Pro",
      intelligence: "high",
      aliases: ["mimo 2.5 pro", "MiMo 2.5 Pro"],
    },
    {
      provider: "mimo",
      id: "mimo-v2.5",
      label: "MiMo V2.5",
      intelligence: "medium",
      aliases: ["mimo 2.5", "MiMo 2.5"],
    },
    {
      provider: "claude",
      id: "claude-opus-4-5",
      label: "Claude Opus 4.5",
      intelligence: "high",
      windowIds: ["model:fable"],
      aliases: ["Fable", "claude-opus-4.5"],
    },
    {
      provider: "claude",
      id: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      intelligence: "high",
      aliases: ["claude-sonnet-4.5"],
    },
    {
      provider: "claude",
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      intelligence: "medium",
      aliases: ["claude-haiku-4.5"],
    },
    {
      provider: "codex",
      id: "gpt-5.3-codex",
      label: "GPT-5.3-Codex",
      intelligence: "high",
      windowIds: ["model:codex_bengalfox"],
      aliases: ["codex_bengalfox", "GPT-5.3-Codex-Spark"],
    },
    {
      provider: "codex",
      id: "gpt-5.1-codex",
      label: "GPT-5.1-Codex",
      intelligence: "high",
      windowIds: ["model:gpt-5.1-codex"],
    },
    {
      provider: "codex",
      id: "gpt-5-codex-mini",
      label: "GPT-5-Codex Mini",
      intelligence: "medium",
      windowIds: ["model:gpt-5-codex-mini"],
    },
    {
      provider: "grok",
      id: "grok-4",
      label: "Grok 4",
      intelligence: "high",
      aliases: ["grok-4-latest"],
    },
    {
      provider: "grok",
      id: "grok-4-fast",
      label: "Grok 4 Fast",
      intelligence: "medium",
      aliases: ["grok-4-fast-reasoning"],
    },
    {
      provider: "grok",
      id: "grok-3-mini",
      label: "Grok 3 Mini",
      intelligence: "low",
    },
    {
      provider: "kimi",
      id: "kimi-k2.5",
      label: "Kimi K2.5",
      intelligence: "high",
      aliases: ["kimi-k2-5"],
    },
    {
      provider: "kimi",
      id: "kimi-k2",
      label: "Kimi K2",
      intelligence: "medium",
    },
    {
      provider: "kimi",
      id: "kimi-k1.5",
      label: "Kimi K1.5",
      intelligence: "low",
    },
  ],
};
