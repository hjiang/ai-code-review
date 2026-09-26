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

/** Thinking levels that map to an Anthropic effort/budget (all but auto/off). */
type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

/** Fraction of `max_tokens` per level; must leave room for the reply text. */
const EFFORT_BUDGET_FRACTION: Record<ThinkingEffort, number> = {
  low: 0.2,
  medium: 0.35,
  high: 0.5,
  max: 0.7
};

/**
 * Legacy extended-thinking budget derived from the completion budget.
 * Contract: 1024 <= result <= maxTokens - 1024 (the API requires a minimum of
 * 1024 and strictly less than `max_tokens`, and the reply needs room too), so
 * `maxTokens` must be >= 2048 for a valid result.
 */
export function thinkingBudgetTokens(level: ThinkingEffort, maxTokens: number): number {
  const fraction = EFFORT_BUDGET_FRACTION[level];
  return Math.min(Math.max(1024, Math.round(maxTokens * fraction)), maxTokens - 1024);
}

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
    stream: true, // set before the extraBody merge: user keys still win
    messages: chatMessages
  };
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  const level: ThinkingEffort | undefined =
    cfg.thinking === 'low' || cfg.thinking === 'medium' || cfg.thinking === 'high' || cfg.thinking === 'max'
      ? cfg.thinking
      : undefined;
  if (level) {
    // Modern shape (Claude 4.6+/5.x): adaptive thinking + a top-level effort.
    // Legacy-only models (<= 4.5) reject it; the failover below swaps in
    // extended thinking with a budget derived from max_tokens.
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: level };
  }
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
  if (!res.ok) {
    let errorText = (await res.text()).slice(0, 500);
    if (res.status === 400 && level && /thinking|effort|output_config/i.test(errorText)) {
      // The model rejected adaptive thinking/effort: extended thinking is the
      // only mode on Claude 4.5 and earlier. Its budget must be >= 1024 and
      // strictly below max_tokens, so it needs max_tokens >= 2048.
      if (cfg.maxTokens < 2048) {
        throw new HttpError(
          res.status,
          `${errorText} — this model rejects adaptive thinking and max_tokens=${cfg.maxTokens} is too small for extended thinking (needs >= 2048 so budget_tokens can be >= 1024 and still leave room for the reply)`
        );
      }
      cfg.log?.(
        'llm: model rejected adaptive thinking; retrying with extended thinking + auto budget'
      );
      delete body.output_config;
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudgetTokens(level, cfg.maxTokens) };
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!res.ok) errorText = (await res.text()).slice(0, 500);
    }
    if (!res.ok && cfg.extraBody && Object.keys(cfg.extraBody).length > 0) {
      // The provider rejected a user-supplied extra param (e.g. thinking with a
      // temperature other than 1); retry once without it, mirroring openai.ts.
      cfg.log?.(`llm: provider rejected extra_body (400 ${res.status}), retrying without it`);
      for (const k of Object.keys(cfg.extraBody)) delete body[k];
      // JSON.stringify is recomputed: extra_body keys are gone from `body`.
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!res.ok) errorText = (await res.text()).slice(0, 500);
    }
    if (!res.ok) {
      throw new HttpError(res.status, errorText);
    }
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
