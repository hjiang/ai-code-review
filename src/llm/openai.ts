/**
 * OpenAI-compatible chat completions adapter (native fetch, no SDK).
 *
 * Streaming-only: the request carries `stream: true` and the reply is consumed
 * as an SSE event stream, accumulating `choices[0].delta.content` fragments
 * until the `[DONE]` sentinel. Streaming keeps bytes flowing during long
 * provider-side reasoning, so an uncapped budget (`timeoutMs: 0`, no abort
 * signal) genuinely allows unbounded thinking — the 5-minute idle-stall
 * detector inside `parseSSE` still applies.
 */

import { buildOpenAiUrl } from './url.js';
import { EmptyCompletionError, HttpError } from './types.js';
import type { LLMConfig, LLMMessage } from './types.js';
import { parseSSE } from './sse.js';

interface OpenAIStreamChunk {
  choices?: {
    delta?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }[];
  /** Mid-stream provider failure delivered on an HTTP 200 (e.g. OpenRouter). */
  error?: unknown;
}

/** Non-streaming chat-completions body (fallback when the endpoint ignores stream). */
interface OpenAIJsonResponse {
  choices?: { message?: { content?: string }; text?: string }[];
}

function isResponseFormatError(status: number, body: string): boolean {
  return status === 400 && /response_format|json_object/i.test(body);
}

/**
 * POST `{base}/chat/completions` with `stream: true` and return the full
 * assistant text, accumulated from SSE `delta.content` chunks until `[DONE]`.
 * DeepSeek-style `reasoning_content` deltas are tracked (for diagnostics) but
 * never emitted. When `jsonMode` is `auto`, sends
 * `response_format: {type:'json_object'}` and retries once without it if the
 * endpoint rejects the field (common on third-party/self-hosted gateways).
 * `timeoutMs` is the remaining budget for this attempt (shared total
 * deadline); `0` means uncapped — no abort signal, so the provider may think
 * arbitrarily long (the 5-minute idle-stall detector in `parseSSE` still
 * applies). Throws `HttpError` on other non-2xx responses and
 * `EmptyCompletionError` when no text content arrives.
 */
export async function openaiChat(
  cfg: LLMConfig,
  messages: LLMMessage[],
  jsonMode: 'auto' | 'off',
  timeoutMs: number
): Promise<string> {
  const url = buildOpenAiUrl(cfg.baseUrl);
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.apiKey}`,
    'content-type': 'application/json'
  };
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    // Set before the extraBody merge: a user-supplied `stream: false` wins.
    stream: true
  };
  if (jsonMode === 'auto') body.response_format = { type: 'json_object' };
  if (cfg.extraBody) Object.assign(body, cfg.extraBody); // user keys win

  // Hard total-deadline abort. Node throws RangeError for Infinity/NaN and
  // clamps delays ≥ 2^31 ms to a ~1 ms abort, so pin the signal at the
  // maximum safe timer delay. timeoutMs 0 = uncapped: no AbortSignal at all.
  const signal = timeoutMs > 0 ? AbortSignal.timeout(Math.min(timeoutMs, 2 ** 31 - 1)) : undefined;

  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  let errorText: string | null = null;
  if (!res.ok) {
    errorText = await res.text();
    if (isResponseFormatError(res.status, errorText)) {
      delete body.response_format;
      // JSON.stringify is recomputed: extra_body keys may be gone (below) or
      // response_format was just deleted.
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      errorText = null; // fresh body if the retry also failed
    } else if (cfg.extraBody && Object.keys(cfg.extraBody).length > 0) {
      // The provider rejected a user-supplied extra param (e.g. this endpoint
      // does not support thinking/reasoning controls); retry without it.
      cfg.log?.(`llm: provider rejected extra_body (400 ${res.status}), retrying without it`);
      for (const k of Object.keys(cfg.extraBody)) delete body[k];
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      errorText = null;
    }
  }
  if (!res.ok) {
    throw new HttpError(res.status, (errorText ?? (await res.text())).slice(0, 500));
  }

  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // The endpoint answered with a plain JSON completion: it ignored
    // `stream: true`, or the user set extra_body {"stream": false} (a
    // documented escape hatch). Handle it rather than misreporting an empty
    // stream. Note: long-thinking requests lose streaming's idle protection.
    cfg.log?.(
      'llm: openai response is not SSE (endpoint ignored stream:true); reading the JSON completion'
    );
    const data = (await res.json()) as OpenAIJsonResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new EmptyCompletionError('provider returned empty completion content');
    }
    return content;
  }

  // Accumulate the streamed reply. `finish_reason` keeps the first non-null
  // value: providers send it once, on the chunk that ends the stream, so the
  // first observation is the reason the content stopped — robust even when a
  // gateway appends its own empty terminator chunk afterwards.
  let text = '';
  let chunks = 0;
  let reasoningSeen = false;
  let finishReason: string | undefined;
  for await (const ev of parseSSE(res.body!)) {
    if (ev.data === '[DONE]') break;
    chunks++;
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(ev.data) as OpenAIStreamChunk;
    } catch {
      continue; // keep-alive or malformed data line; judge by what accumulated
    }
    if (chunk.error !== undefined) {
      // Mid-stream provider failure on an HTTP 200 (e.g. OpenRouter sends
      // `data: {"error": {...}}`). Plain Error = retryable, and the payload
      // reaches the retry log instead of masquerading as an empty completion.
      throw new Error(`openai stream error: ${ev.data}`);
    }
    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content;
    if (typeof content === 'string' && content.length > 0) text += content;
    const reasoning = choice?.delta?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) reasoningSeen = true;
    const reason = choice?.finish_reason;
    if (finishReason === undefined && typeof reason === 'string' && reason.length > 0) {
      finishReason = reason;
    }
  }

  if (text.trim().length === 0) {
    // An empty completion is a provider-side failure mode (e.g. a reasoning
    // model that burned its whole budget on thinking deltas). Surface the
    // stream shape so the retry is diagnosable in CI logs.
    cfg.log?.(
      `llm: openai extraction failed (empty completion); chunks=${chunks} finish_reason=${finishReason ?? 'none'} reasoning_content=${reasoningSeen ? 'yes' : 'no'}`
    );
    throw new EmptyCompletionError('provider returned empty completion content');
  }
  return text;
}
