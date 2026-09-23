/**
 * Anthropic Messages API adapter (native fetch, no SDK).
 *
 * Streaming-only: the request carries `stream: true` and the reply is consumed
 * as an SSE event stream, so `timeoutMs: 0` (uncapped — no hard abort signal)
 * still makes progress as long as the model keeps streaming. The 5-minute
 * idle-stall detector inside `parseSSE` remains the last-resort guard against
 * a silently stalled connection.
 */

import { buildAnthropicUrl } from './url.js';
import { parseSSE } from './sse.js';
import { EmptyCompletionError, HttpError } from './types.js';
import type { LLMConfig, LLMMessage } from './types.js';

const ANTHROPIC_VERSION = '2023-06-01';

/** `delta` payload of a `content_block_delta` event (only `text_delta` is used). */
interface AnthropicDelta {
  type?: string;
  text?: string;
}

/**
 * POST `{base}/v1/messages` with `stream: true` (a user-supplied
 * `extraBody.stream: false` still wins) and consume the reply as SSE: only
 * `content_block_delta`/`text_delta` events contribute text — `thinking_delta`
 * and every other delta type are ignored so reasoning never reaches the output
 * or the empty-detection. System messages are moved into the `system` field
 * (not part of `messages`), as required by the Anthropic API. `timeoutMs` is
 * the remaining budget for this attempt (shared total deadline); `0` means
 * uncapped — no hard abort signal, only parseSSE's idle-stall detector.
 * Throws `HttpError` on non-2xx responses, a plain (retryable) `Error` on a
 * mid-stream `error` event, and `EmptyCompletionError` when no text arrived.
 */
export async function anthropicChat(
  cfg: LLMConfig,
  messages: LLMMessage[],
  timeoutMs: number
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
    stream: true, // set before the extraBody merge: user keys still win
    messages: chatMessages
  };
  if (system) body.system = system;
  if (cfg.extraBody) Object.assign(body, cfg.extraBody); // user keys win

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    // Hard total-deadline abort. `timeoutMs 0` = uncapped: no AbortSignal, so
    // the provider may think arbitrarily long (stream bytes keep the request
    // alive). Node throws RangeError for timeouts >= 2^31 ms and clamps larger
    // values to a 1 ms abort, so clamp here.
    signal: timeoutMs > 0 ? AbortSignal.timeout(Math.min(timeoutMs, 2 ** 31 - 1)) : undefined
  });
  if (!res.ok) {
    throw new HttpError(res.status, (await res.text()).slice(0, 500));
  }
  if (!res.body) {
    throw new Error('anthropic stream error: 200 response has no body');
  }

  let text = '';
  let events = 0;
  for await (const ev of parseSSE(res.body)) {
    events++;
    if (ev.event === 'content_block_delta') {
      const delta = (JSON.parse(ev.data) as { delta?: AnthropicDelta }).delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
      }
    } else if (ev.event === 'error') {
      // Mid-stream failure on an HTTP 200 (e.g. overloaded_error). Plain
      // Error, not LLMError, so requestWithRetry treats it as transient.
      throw new Error(`anthropic stream error: ${ev.data}`);
    } else if (ev.event === 'message_stop') {
      break; // terminal; EOF terminates too
    }
  }

  if (text.trim().length === 0) {
    // See the streaming contract: empty completions are a provider-side
    // failure mode; log a diagnostic and let the caller re-ask.
    cfg.log?.(`llm: anthropic extraction failed (empty completion); events=${events}`);
    throw new EmptyCompletionError('provider returned empty completion content');
  }
  return text;
}
