/**
 * Anthropic Messages API adapter (native fetch, no SDK).
 */

import { buildAnthropicUrl } from './url.js';
import { HttpError } from './types.js';
import type { LLMConfig, LLMMessage } from './types.js';

const TIMEOUT_MS = 5 * 60 * 1000;
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponse {
  content?: { type?: string; text?: string }[];
}

function extractText(data: AnthropicResponse): string {
  const block = data.content?.find((b) => b.type === 'text');
  if (!block || typeof block.text !== 'string') {
    throw new Error('provider returned no completion content');
  }
  return block.text;
}

/**
 * POST `{base}/v1/messages`. System messages are moved into the `system`
 * field (not part of `messages`), as required by the Anthropic API. Throws
 * `HttpError` on non-2xx responses.
 */
export async function anthropicChat(
  cfg: LLMConfig,
  messages: LLMMessage[]
): Promise<string> {
  const url = buildAnthropicUrl(cfg.baseUrl);
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map(({ role, content }) => ({ role, content }));

  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    messages: chatMessages
  };
  if (system) body.system = system;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) {
    throw new HttpError(res.status, (await res.text()).slice(0, 500));
  }
  return extractText((await res.json()) as AnthropicResponse);
}
