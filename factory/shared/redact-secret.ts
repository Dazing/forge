// Pure secret redaction shared by provider adapters, logging, and ticket annotations.

/** Replace every literal occurrence of every non-empty secret in diagnostic text before it reaches any sink. */
export function redactSecrets(secrets: readonly string[], text: string): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    safe = safe.replaceAll(secret, "[redacted-token]");
  }
  return safe;
}
