/** Redact credentials before text is sent to a remote model provider. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/gu, '[REDACTED_API_KEY]')
    .replace(/\b(AIza[0-9A-Za-z_-]{20,})\b/gu, '[REDACTED_API_KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED_TOKEN]')
    .replace(/\b(password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*([^\s,;]+)/giu, '$1=[REDACTED_SECRET]')
    .replace(/(https?:\/\/[^\s/]+\/)[^\s]+/giu, (_match, prefix: string) => `${prefix}[REDACTED_PATH]`)
}

