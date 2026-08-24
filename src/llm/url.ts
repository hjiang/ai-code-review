/**
 * Provider endpoint URL normalization.
 *
 * Trailing slashes are stripped and version segments are appended idempotently:
 * the OpenAI adapter targets `{base}/chat/completions` and the Anthropic
 * adapter targets `{base}/v1/messages` (adding `/v1` only when missing).
 */

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

export function buildOpenAiUrl(baseUrl: string): string {
  const base = stripTrailingSlash(baseUrl);
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export function buildAnthropicUrl(baseUrl: string): string {
  let base = stripTrailingSlash(baseUrl);
  if (!base.endsWith('/v1')) base += '/v1';
  return `${base}/messages`;
}
