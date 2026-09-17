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

export function annotateQuotaAdvice(
  response: Omit<QuotaAxiResponse, "schemaVersion">,
): QuotaAxiResponse {
  const expanded = response.providers.some((provider) => provider.accountKey);
  const providers = response.providers.map((provider) =>
    annotateProviderAdvice(
      expanded
        ? { ...provider, accountKey: provider.accountKey ?? "default" }
        : provider,
    ),
  );
  const help = providers.flatMap(providerHelpLines);
  return {
    generatedAt: response.generatedAt,
    schemaVersion: providers.some((provider) => provider.accountKey) ? 6 : 5,
    providers,
    ...(help.length > 0 ? { help } : {}),
  };
}

/**
 * The sibling-lane reauth advice names that lane's own config directory, so
 * ordinary output demotes it - and the matching `state.remedyCommand` - to
 * `--full` alongside `accountLocator`. Resolved through the same dispatcher
 * that emitted the line rather than by matching the command text.
 *
 * @returns the help line to withhold, or undefined when nothing is demoted
 */
export function fullOnlyHelpLine(provider: ProviderQuota): string | undefined {
  if (!needsClaudeReauthAdvice(provider)) return undefined;
  const [line] = providerHelpLines(provider);
  return line === claudeReauthHelpLine(provider) ? line : undefined;
}

/**
 * Situational advice stays first because it is actionable; only the tier hint
 * is worth repeating on every invocation.
 */
export function quotaHelpLines(response: QuotaAxiResponse): string[] {
  return [
    ...(response.help ?? []),
    "Run `quota-axi --full` for windows, pace, reserve, and account evidence",
  ];
}

function annotateProviderAdvice(provider: ProviderQuota): ProviderQuota {
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
  if (needsClaudeReauthAdvice(provider)) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: CREDENTIALS_EXPIRED_REASON,
        remedyCommand: claudeReauthRemedyCommand(provider),
      },
    };
  }
  return provider;
}

/**
 * A discovered sibling Claude lane is excluded from the refresh delegate (only
 * the process-selected profile owns it), so it can never self-heal a credential
 * rejection on its own. Point at the exact non-interactive rotation for that
 * lane's own config directory instead. The delegate-eligible (process-selected)
 * lane is excluded here: its own read already attempted that delegate, so
 * repeating the remedy would misreport it as never auto-refreshed.
 */
function needsClaudeReauthAdvice(provider: ProviderQuota): boolean {
  return (
    provider.provider === "claude" &&
    provider.accountLocator?.path !== undefined &&
    provider.accountLocator.delegateEligible !== true &&
    provider.state.status === "auth_required"
  );
}

function claudeReauthRemedyCommand(provider: ProviderQuota): string {
  return `CLAUDE_CONFIG_DIR=${shellQuote(provider.accountLocator!.path)} claude doctor`;
}

/** POSIX single-quote a value so a path with spaces or shell metacharacters survives a copy-paste. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function needsKeychainAccessAdvice(provider: ProviderQuota): boolean {
  const attempts = provider.attempts ?? [];
  return (
    provider.state.status !== "fresh" &&
    !attempts.some((attempt) => attempt.status === "success") &&
    attempts.some(isBlockedCredentialAttempt) &&
    attempts.some(isPromptBlockedKeychainAttempt)
  );
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
  if (needsClaudeReauthAdvice(provider))
    return [claudeReauthHelpLine(provider)];
  return [];
}

function hasKeychainAccessAdvice(provider: ProviderQuota): boolean {
  return (
    provider.state.reason === KEYCHAIN_ACCESS_REASON &&
    provider.state.remedyCommand === KEYCHAIN_ACCESS_REMEDY_COMMAND
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

function grokTokenRefreshHelpLine(): string {
  return `Tell your user: run \`${GROK_TOKEN_REFRESH_REMEDY_COMMAND}\` once so the Grok CLI can refresh its own session token. quota-axi delegates that refresh to the Grok CLI and never rotates credentials itself.`;
}

function claudeReauthHelpLine(provider: ProviderQuota): string {
  return `Tell your user: this Claude account (${provider.accountKey ?? "default"}) is a sibling lane quota-axi never auto-refreshes, so run \`${claudeReauthRemedyCommand(provider)}\` once to have Claude Code rotate its own session.`;
}
