import { coveredAccountKeys } from "./providers/accounts.js";
import {
  REFRESH_COMMAND_NOT_FOUND,
  REFRESH_EXIT_STATUS,
  REFRESH_SPAWN_FAILED,
} from "./providers/delegated-refresh.js";
import { grokCliRefreshNeeded } from "./providers/grok.js";
import type {
  ProviderQuota,
  QuotaAxiResponse,
  SourceAttempt,
} from "./types.js";

export const KEYCHAIN_ACCESS_REASON = "keychain_access_required";
export const KEYCHAIN_ACCESS_REMEDY_COMMAND =
  "quota-axi --allow-keychain-prompt";
export const CREDENTIALS_EXPIRED_REASON = "credentials_expired";
export const GROK_TOKEN_REFRESH_REMEDY_COMMAND = "grok";
export const CLAUDE_TOKEN_REFRESH_REMEDY_COMMAND = "claude";
export const PI_KIMI_TOKEN_REFRESH_REMEDY_COMMAND = "pi";
export const KIMI_CODE_TOKEN_REFRESH_REMEDY_COMMAND = "kimi";
const PI_KIMI_EXPIRED_ERROR = "pi_kimi_credential_expired";
const KIMI_CODE_EXPIRED_ERROR = "kimi_code_cli_credential_expired";
export const INFERENCE_OPT_IN_REASON = "inference_opt_in_required";
export const CLAUDE_INFERENCE_REMEDY_COMMAND =
  "quota-axi --provider claude --allow-claude-inference";
const CLAUDE_ENV_SCOPE_DENIAL_ERROR = "claude_env_usage_scope_unavailable";

export function annotateQuotaAdvice(
  response: Omit<QuotaAxiResponse, "schemaVersion">,
): QuotaAxiResponse {
  const expanded = response.providers.some((provider) => provider.accountKey);
  const providers = response.providers.map((provider) => {
    const accountKey = expanded
      ? (provider.accountKey ?? "default")
      : undefined;
    return annotateProviderAdvice({
      ...provider,
      ...(accountKey ? { accountKey } : {}),
      accountKeys: coveredAccountKeys(
        accountKey ?? provider.accountKeys?.[0] ?? "default",
        provider.accountKeys,
      ),
    });
  });
  const help = providers.flatMap(providerHelpLines);
  return {
    generatedAt: response.generatedAt,
    schemaVersion: providers.some((provider) => provider.accountKey) ? 6 : 5,
    providers,
    ...(help.length > 0 ? { help } : {}),
  };
}

/**
 * Situational advice stays first because it is actionable; only the tier hint
 * is worth repeating on every invocation.
 */
export function quotaHelpLines(
  response: QuotaAxiResponse,
  omittedNotSetUp = 0,
): string[] {
  const lines = [
    ...(response.help ?? []),
    "Run `quota-axi --full` for windows, pace, reserve, and account evidence",
  ];
  if (omittedNotSetUp > 0) {
    lines.splice(lines.length - 1, 0, omittedNotSetUpHelpLine(omittedNotSetUp));
  }
  return lines;
}

/**
 * The omission sentence the default report uses when it drops providers that
 * are not set up. Situational advice stays ahead of it; the tier hint stays
 * last.
 */
function omittedNotSetUpHelpLine(count: number): string {
  const subject = count === 1 ? "1 provider" : `${count} providers`;
  const verb = count === 1 ? "is" : "are";
  const pronoun = count === 1 ? "it" : "them";
  return `${subject} not set up ${verb} omitted; run \`quota-axi --full\` to list ${pronoun}`;
}

function annotateProviderAdvice(provider: ProviderQuota): ProviderQuota {
  if (needsClaudeInferenceAdvice(provider)) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: INFERENCE_OPT_IN_REASON,
        remedyCommand: CLAUDE_INFERENCE_REMEDY_COMMAND,
      },
    };
  }
  if (needsKeychainAccessAdvice(provider)) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: KEYCHAIN_ACCESS_REASON,
        remedyCommand: KEYCHAIN_ACCESS_REMEDY_COMMAND,
      },
    };
  }
  if (needsGrokTokenRefreshAdvice(provider)) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: CREDENTIALS_EXPIRED_REASON,
        remedyCommand: GROK_TOKEN_REFRESH_REMEDY_COMMAND,
      },
    };
  }
  if (needsClaudeTokenRefreshAdvice(provider)) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: CREDENTIALS_EXPIRED_REASON,
        remedyCommand: CLAUDE_TOKEN_REFRESH_REMEDY_COMMAND,
      },
    };
  }
  const kimiRemedy = kimiTokenRefreshRemedy(provider);
  if (kimiRemedy) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: CREDENTIALS_EXPIRED_REASON,
        remedyCommand: kimiRemedy,
      },
    };
  }
  return provider;
}

/**
 * A refreshable stored-expired Claude token still rejected after `claude
 * doctor` ran, or after quota-axi found no way to run it, is the Claude
 * counterpart of Grok's case: the vendor CLI did not recover the session, so
 * the user runs it once. A delegate that was skipped because Claude Code is
 * already running (or its process table was unreadable) or that outran its
 * wait is not this case: the owning process is still doing the work.
 */
function needsClaudeTokenRefreshAdvice(provider: ProviderQuota): boolean {
  return (
    provider.provider === "claude" &&
    provider.state.status !== "fresh" &&
    provider.state.authStatus === "expired_refreshable" &&
    (provider.attempts ?? []).some(
      (attempt) =>
        attempt.source === "claude-cli-refresh" &&
        (attempt.status === "success" ||
          attempt.error === REFRESH_EXIT_STATUS ||
          attempt.error === REFRESH_SPAWN_FAILED ||
          attempt.error === REFRESH_COMMAND_NOT_FOUND),
    )
  );
}

/**
 * The env token's exact `user:profile` scope denial leaves a usable session
 * with no numeric quota. It is checked ahead of Keychain advice because the
 * env token is consulted first and that denial ends discovery, so a stored
 * Keychain grant could never have helped this reading. A run that already
 * attempted the native fallback reports that fallback's own error instead, so
 * the exact error equality alone keeps an enabled run from re-advertising it.
 */
function needsClaudeInferenceAdvice(provider: ProviderQuota): boolean {
  return (
    provider.provider === "claude" &&
    provider.state.status !== "fresh" &&
    provider.state.error === CLAUDE_ENV_SCOPE_DENIAL_ERROR &&
    envScopeDenialEndedDiscovery(provider.attempts ?? [])
  );
}

/**
 * The env token is consulted first and its exact scope denial ends discovery,
 * so no stored source was consulted on that reading and a Keychain grant could
 * not have changed it - whether the denial itself or a later native fallback
 * failure ended up as the report's error.
 */
function envScopeDenialEndedDiscovery(attempts: SourceAttempt[]): boolean {
  return attempts.some(
    (attempt) =>
      attempt.source === "env" &&
      attempt.status === "failed" &&
      attempt.error === CLAUDE_ENV_SCOPE_DENIAL_ERROR,
  );
}

function needsKeychainAccessAdvice(provider: ProviderQuota): boolean {
  const attempts = provider.attempts ?? [];
  return (
    provider.state.status !== "fresh" &&
    !envScopeDenialEndedDiscovery(attempts) &&
    !(
      provider.provider === "claude" &&
      attempts.some(
        (attempt) =>
          attempt.source === "env" &&
          attempt.status === "failed" &&
          attempt.error === "Claude sign-in required",
      )
    ) &&
    !attempts.some(isCredentialSourceReading) &&
    attempts.some(isBlockedCredentialAttempt) &&
    attempts.some(isPromptBlockedKeychainAttempt)
  );
}

function isCredentialSourceReading(attempt: SourceAttempt): boolean {
  return (
    attempt.status === "success" && !isIdentityLookupSource(attempt.source)
  );
}

/**
 * Kimi has no delegated refresh. A soft-expired login stays read-only, and the
 * remedy names the CLI that owns the store the reading came from: `pi` when
 * Pi's `kimi-coding` entry defines it, `kimi` when the Kimi Code CLI store
 * does. A hard sign-out has no `expired_refreshable` status, so it stays silent.
 */
function kimiTokenRefreshRemedy(provider: ProviderQuota): string | undefined {
  if (
    provider.provider !== "kimi" ||
    provider.state.status === "fresh" ||
    provider.state.authStatus !== "expired_refreshable"
  ) {
    return undefined;
  }
  if (provider.state.error === PI_KIMI_EXPIRED_ERROR) {
    return PI_KIMI_TOKEN_REFRESH_REMEDY_COMMAND;
  }
  if (provider.state.error === KIMI_CODE_EXPIRED_ERROR) {
    return KIMI_CODE_TOKEN_REFRESH_REMEDY_COMMAND;
  }
  return undefined;
}

function needsGrokTokenRefreshAdvice(provider: ProviderQuota): boolean {
  return (
    provider.provider === "grok" &&
    provider.state.status !== "fresh" &&
    grokCliRefreshNeeded(provider)
  );
}

function isBlockedCredentialAttempt(attempt: SourceAttempt): boolean {
  if (isKeychainSource(attempt.source)) return false;
  if (isIdentityLookupSource(attempt.source)) return false;
  if (attempt.status === "skipped") return true;
  return (
    attempt.status === "failed" &&
    isDefinitiveCredentialRejection(attempt.error)
  );
}

function isDefinitiveCredentialRejection(error: string | undefined): boolean {
  if (!error) return false;
  return (
    /^credentials_(?:missing|invalid|expired)$/i.test(error) ||
    /\bsign-in required\b/i.test(error) ||
    /\b(?:unauthorized|forbidden)\b/i.test(error) ||
    /(?:^|\D)(?:401|403)(?:\D|$)/.test(error)
  );
}

/** Providers name their Keychain source `keychain` or `<store>-keychain`. */
function isKeychainSource(source: string): boolean {
  return source === "keychain" || source.endsWith("-keychain");
}

/**
 * The OAuth identity lookup is a probe made with a credential some source
 * already supplied, not a credential source of its own, so its outcome neither
 * establishes nor cancels a credential reading.
 */
function isIdentityLookupSource(source: string): boolean {
  return source === "oauth-profile";
}

function isPromptBlockedKeychainAttempt(attempt: SourceAttempt): boolean {
  return (
    isKeychainSource(attempt.source) &&
    attempt.status === "skipped" &&
    attempt.error === "keychain_prompt_required" &&
    attempt.credentialPresent === true
  );
}

function providerHelpLines(provider: ProviderQuota): string[] {
  if (hasKeychainAccessAdvice(provider))
    return [keychainAccessHelpLine(provider)];
  if (hasGrokTokenRefreshAdvice(provider)) return [grokTokenRefreshHelpLine()];
  if (hasClaudeTokenRefreshAdvice(provider))
    return [claudeTokenRefreshHelpLine(provider)];
  if (hasClaudeInferenceAdvice(provider)) return [claudeInferenceHelpLine()];
  if (hasKimiTokenRefreshAdvice(provider))
    return [kimiTokenRefreshHelpLine(provider.state.remedyCommand)];
  return [];
}

function hasClaudeInferenceAdvice(provider: ProviderQuota): boolean {
  return (
    provider.state.reason === INFERENCE_OPT_IN_REASON &&
    provider.state.remedyCommand === CLAUDE_INFERENCE_REMEDY_COMMAND
  );
}

function hasClaudeTokenRefreshAdvice(provider: ProviderQuota): boolean {
  return (
    provider.provider === "claude" &&
    provider.state.reason === CREDENTIALS_EXPIRED_REASON &&
    provider.state.remedyCommand === CLAUDE_TOKEN_REFRESH_REMEDY_COMMAND
  );
}

function hasKeychainAccessAdvice(provider: ProviderQuota): boolean {
  return (
    provider.state.reason === KEYCHAIN_ACCESS_REASON &&
    provider.state.remedyCommand === KEYCHAIN_ACCESS_REMEDY_COMMAND
  );
}

function hasKimiTokenRefreshAdvice(provider: ProviderQuota): boolean {
  return (
    provider.provider === "kimi" &&
    provider.state.reason === CREDENTIALS_EXPIRED_REASON &&
    (provider.state.remedyCommand === PI_KIMI_TOKEN_REFRESH_REMEDY_COMMAND ||
      provider.state.remedyCommand === KIMI_CODE_TOKEN_REFRESH_REMEDY_COMMAND)
  );
}

function hasGrokTokenRefreshAdvice(provider: ProviderQuota): boolean {
  return (
    provider.state.reason === CREDENTIALS_EXPIRED_REASON &&
    provider.state.remedyCommand === GROK_TOKEN_REFRESH_REMEDY_COMMAND
  );
}

function keychainAccessHelpLine(provider: ProviderQuota): string {
  return `Tell your user: run \`${KEYCHAIN_ACCESS_REMEDY_COMMAND}\` once and approve Keychain access ("Always Allow") so quota-axi can read ${provider.provider}'s live quota.`;
}

function claudeInferenceHelpLine(): string {
  return `Tell your user: the CLAUDE_CODE_OAUTH_TOKEN session is usable but its token cannot read the quota endpoint. Running \`${CLAUDE_INFERENCE_REMEDY_COMMAND}\` once reads its five-hour and seven-day quota by spending one bounded native Claude Code startup plus a small inference request; quota-axi never does this by default.`;
}

function claudeTokenRefreshHelpLine(provider: ProviderQuota): string {
  const refreshFailure = (provider.attempts ?? []).find(
    (attempt) =>
      attempt.source === "claude-cli-refresh" &&
      (attempt.error === REFRESH_COMMAND_NOT_FOUND ||
        attempt.error === REFRESH_SPAWN_FAILED),
  );
  if (refreshFailure) {
    return "Tell your user: quota-axi could not run the Claude CLI; run `claude` once where it is installed.";
  }
  return `Tell your user: run \`${CLAUDE_TOKEN_REFRESH_REMEDY_COMMAND}\` once so Claude Code can refresh its own session token; \`claude doctor\` did not recover it. quota-axi delegates that refresh to the Claude CLI and never rotates credentials itself.`;
}

function kimiTokenRefreshHelpLine(remedy: string | undefined): string {
  if (remedy === KIMI_CODE_TOKEN_REFRESH_REMEDY_COMMAND) {
    return "Tell your user: run a Kimi Code session with `kimi` once so Kimi Code refreshes its own session token. quota-axi stays read-only and never rotates Kimi credentials.";
  }
  return "Tell your user: use a Kimi model in `pi` once so Pi refreshes its own Kimi session token; Pi refreshes a provider's token only when that provider is used. quota-axi stays read-only and never rotates Kimi credentials.";
}

function grokTokenRefreshHelpLine(): string {
  return `Tell your user: run \`${GROK_TOKEN_REFRESH_REMEDY_COMMAND}\` once so the Grok CLI can refresh its own session token. quota-axi delegates that refresh to the Grok CLI and never rotates credentials itself.`;
}
