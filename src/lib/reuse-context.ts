import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";

/**
 * Every environment variable a provider consults to choose which profile,
 * credential store, credential, CLI, or deployment it reads. Fresh reuse
 * serves a cached reading only to a process whose values for all of these
 * match the process that took it, so one profile's reading never answers for
 * another (#61). `test/reuse-context.test.ts` reads every provider under a
 * recording environment and fails when a variable it consults is neither
 * listed here nor declared as not selecting a credential.
 */
export const CREDENTIAL_SELECTION_ENV = [
  "HOME",
  "USERPROFILE",
  "USER",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CODEX_HOME",
  "QUOTA_AXI_CODEX_BINARY",
  "PI_CODING_AGENT_DIR",
  "CURSOR_CLI_CONFIG",
  "CURSOR_STATE_DB",
  "COPILOT_GH_HOST",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_HOME",
  "GITHUB_COPILOT_APPS_JSON",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GROK_AUTH",
  "GROK_AUTH_JSON",
  "GROK_AUTH_PATH",
  "GROK_HOME",
  "KIMI_CODE_HOME",
  "QUOTA_AXI_OPENCODE_GO_PI_AUTH",
  "COMMAND_CODE_API_KEY",
  "COMMANDCODE_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "MMX_CONFIG_DIR",
  "MIMO_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "ELEVENLABS_API_KEY",
  "WINDSURF_API_KEY",
  "WINDSURF_API_SERVER_URL",
] as const;

/**
 * An opaque identifier for the credential selection this process would make.
 * Values are hashed together, never stored: several of these variables are
 * credentials themselves.
 */
export function reuseContextId(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "reuse-context-v1",
        homedir(),
        currentUsername(),
        CREDENTIAL_SELECTION_ENV.map((name) => environment[name] ?? null),
      ]),
    )
    .digest("hex");
}

function currentUsername(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}
