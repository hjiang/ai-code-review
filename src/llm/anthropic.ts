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

/** `delta` payload of a `content_block_delta` / `message_delta` event. */
interface AnthropicDelta {
  type?: string;
  text?: string;
  thinking?: string;
  stop_reason?: string;
}

/** Parsed `data:` payload of one Anthropic streaming event. */
interface AnthropicEventPayload {
  delta?: AnthropicDelta;
}

/** Non-streaming Messages API body (fallback when the endpoint ignores stream). */
interface AnthropicJsonResponse {
  content?: { type?: string; text?: string }[];
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

  const headers = {
    'x-api-key': cfg.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json'
  };
  // Hard total-deadline abort, computed once for all attempts. `timeoutMs 0` =
  // uncapped: no AbortSignal, so the provider may think arbitrarily long
  // (stream bytes keep the request alive). Node throws RangeError for
  // non-finite delays and clamps values >= 2^31 ms to a 1 ms abort, so clamp.
  const signal =
    timeoutMs > 0 ? AbortSignal.timeout(Math.min(timeoutMs, 2 ** 31 - 1)) : undefined;
  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok && res.status === 400 && cfg.extraBody && Object.keys(cfg.extraBody).length > 0) {
    // The provider rejected a user-supplied extra param (e.g. thinking with a
    // temperature other than 1); retry once without it, mirroring openai.ts.
    cfg.log?.(`llm: provider rejected extra_body (400 ${res.status}), retrying without it`);
    for (const k of Object.keys(cfg.extraBody)) delete body[k];
    // JSON.stringify is recomputed: extra_body keys are gone from `body`.
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }
  if (!res.ok) {
    throw new HttpError(res.status, (await res.text()).slice(0, 500));
  }

  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // The endpoint answered with a plain JSON completion: it ignored
    // `stream: true`, or the user set extra_body {"stream": false} (a
    // documented escape hatch). Handle it rather than misreporting an empty
    // stream. Note: long-thinking requests lose streaming's idle protection.
    cfg.log?.(
      'llm: anthropic response is not SSE (endpoint ignored stream:true); reading the JSON completion'
    );
    const data = (await res.json()) as AnthropicJsonResponse;
    const text = data.content?.find((b) => b.type === 'text')?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new EmptyCompletionError('provider returned empty completion content');
    }
    return text;
  }
  if (!res.body) {
    throw new Error('anthropic stream error: 200 response has no body');
  }

  let text = '';
  let events = 0;
  let stopReason: string | undefined;
  let thinkingSeen = false;
  for await (const ev of parseSSE(res.body)) {
    events++;
    if (ev.event === 'content_block_delta') {
      let payload: AnthropicEventPayload;
      try {
        payload = JSON.parse(ev.data) as AnthropicEventPayload;
      } catch {
        continue; // malformed/truncated line; judge by what accumulated
      }
      const delta = payload.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
      } else if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string' &&
        delta.thinking.length > 0
      ) {
        thinkingSeen = true;
      }
    } else if (ev.event === 'message_delta') {
      // Carries the stop reason (e.g. `max_tokens` when a thinking budget ate
      // the allowance) — the key clue when a completion ends up empty.
      try {
        const payload = JSON.parse(ev.data) as AnthropicEventPayload;
        const reason = payload.delta?.stop_reason;
        if (stopReason === undefined && typeof reason === 'string' && reason.length > 0) {
          stopReason = reason;
        }
      } catch {
        continue; // malformed line; the diagnostic degrades to stop_reason=none
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
    cfg.log?.(
      `llm: anthropic extraction failed (empty completion); events=${events} stop_reason=${stopReason ?? 'none'} thinking=${thinkingSeen ? 'yes' : 'no'}`
    );
    throw new EmptyCompletionError('provider returned empty completion content');
  }
  return text;
}
