/**
 * Accept a credential value only when it is a literal secret that can be sent
 * verbatim in a header. Control bytes would make the request throw rather than
 * surface a credential problem, and `$`/`!` prefixed values are environment,
 * template, or command references that must never be resolved or executed.
 *
 * @param value candidate credential read from a local auth file
 * @returns the literal secret, or undefined when it is unusable
 */
export function usableLiteralSecret(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  if (value.startsWith("!") || value.includes("$")) {
    return undefined;
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
}

/**
 * Strip a credential out of text that is about to be reported. Error messages
 * from a request carry the actual cause an operator needs, and sometimes the
 * bearer that produced it; keep the cause, drop the secret.
 *
 * @param message text about to be reported
 * @param secret credential value that must not appear in it
 * @returns the message with every occurrence of the secret replaced
 */
export function redactSecret(message: string, secret: string): string {
  return message.replaceAll(secret, "[redacted]");
}
