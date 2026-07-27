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
export const GROK_ACCESS_TOKEN_EXPIRED_ERROR = "Grok access token expired";

const BLOCKED_CREDENTIAL_ERRORS = new Set([
  "credentials_expired",
  "credentials_missing",
]);

export function annotateQuotaAdvice(
  response: Omit<QuotaAxiResponse, "schemaVersion">,
): QuotaAxiResponse {
  const providers = response.providers.map(annotateProviderAdvice);
  const help = providers.flatMap(providerHelpLines);
  return {
    generatedAt: response.generatedAt,
    schemaVersion: 2,
    providers,
    ...(help.length > 0 ? { help } : {}),
  };
}

export function quotaHelpLines(response: QuotaAxiResponse): string[] {
  return [
    ...(response.help ?? []),
    "Run `quota-axi --provider claude --json` for JSON output",
    "Run `quota-axi --full` to include account and source-attempt details",
    "Run `quota-axi auth` to inspect local auth source availability without printing secrets",
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
  return provider;
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
    provider.state.error === GROK_ACCESS_TOKEN_EXPIRED_ERROR
  );
}

function isBlockedCredentialAttempt(attempt: SourceAttempt): boolean {
  return (
    attempt.source !== "keychain" &&
    attempt.status === "skipped" &&
    Boolean(attempt.error && BLOCKED_CREDENTIAL_ERRORS.has(attempt.error))
  );
}

function isPromptBlockedKeychainAttempt(attempt: SourceAttempt): boolean {
  return (
    attempt.source === "keychain" &&
    attempt.status === "skipped" &&
    attempt.error === "keychain_prompt_required" &&
    attempt.credentialPresent === true
  );
}

function providerHelpLines(provider: ProviderQuota): string[] {
  if (hasKeychainAccessAdvice(provider))
    return [keychainAccessHelpLine(provider)];
  if (hasGrokTokenRefreshAdvice(provider)) return [grokTokenRefreshHelpLine()];
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
  return `Tell your user: open the Grok CLI (\`${GROK_TOKEN_REFRESH_REMEDY_COMMAND}\`) once so it can refresh Grok's local session token. quota-axi does not refresh credentials.`;
}
