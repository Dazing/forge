// Pure secret redaction shared by provider adapters, logging, and ticket annotations.

/** Replace every literal occurrence of a secret in diagnostic text before it reaches any sink. */
export function redactSecret(secret: string, text: string): string {
  return text.replaceAll(secret, "[redacted-token]");
}
