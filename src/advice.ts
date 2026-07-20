import type {
  ProviderQuota,
  QuotaAxiResponse,
  QuotaSummary,
  SourceAttempt,
} from "./types.js";

export const KEYCHAIN_ACCESS_REASON = "keychain_access_required";
export const KEYCHAIN_ACCESS_REMEDY_COMMAND =
  "quota-axi --allow-keychain-prompt";

const BLOCKED_CREDENTIAL_ERRORS = new Set([
  "credentials_expired",
  "credentials_missing",
]);

export function annotateQuotaAdvice(
  response: Omit<QuotaAxiResponse, "schemaVersion" | "summary">,
  keychainAccessRemedyCommand = KEYCHAIN_ACCESS_REMEDY_COMMAND,
): QuotaAxiResponse {
  const providers = response.providers.map((provider) =>
    annotateProviderAdvice(provider, keychainAccessRemedyCommand),
  );
  const help = [
    ...new Set(
      providers.filter(hasKeychainAccessAdvice).map(keychainAccessHelpLine),
    ),
  ];
  return {
    generatedAt: response.generatedAt,
    schemaVersion: 2,
    summary: summarizeProviders(providers),
    providers,
    ...(help.length > 0 ? { help } : {}),
  };
}

/** A provider row is usable when it carries live or cached quota data. */
export function isUsableProvider(provider: ProviderQuota): boolean {
  return provider.state.status === "fresh" || provider.state.status === "stale";
}

/**
 * Reduce per-provider (per-seat) rows to one aggregate verdict so a single
 * seat's failure never masquerades as the whole fleet's state.
 */
function summarizeProviders(providers: ProviderQuota[]): QuotaSummary {
  const total = providers.length;
  const ok = providers.filter(isUsableProvider).length;
  const unavailable = total - ok;
  const availability =
    total > 0 && ok === total ? "ok" : ok === 0 ? "unavailable" : "partial";
  return { availability, ok, unavailable, total };
}

export function quotaHelpLines(response: QuotaAxiResponse): string[] {
  return [
    ...(response.help ?? []),
    "Run `quota-axi --provider claude --json` for JSON output",
    "Run `quota-axi --full` to include account and source-attempt details",
    "Run `quota-axi auth` to inspect local auth source availability without printing secrets",
  ];
}

function annotateProviderAdvice(
  provider: ProviderQuota,
  remedyCommand: string,
): ProviderQuota {
  if (!needsKeychainAccessAdvice(provider)) return provider;
  return {
    ...provider,
    state: {
      ...provider.state,
      reason: KEYCHAIN_ACCESS_REASON,
      remedyCommand,
    },
  };
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

function hasKeychainAccessAdvice(provider: ProviderQuota): boolean {
  return (
    provider.state.reason === KEYCHAIN_ACCESS_REASON &&
    Boolean(provider.state.remedyCommand)
  );
}

function keychainAccessHelpLine(provider: ProviderQuota): string {
  return `Tell your user: run \`${provider.state.remedyCommand}\` once and approve Keychain access ("Always Allow") so quota-axi can read ${provider.provider}'s live quota.`;
}
