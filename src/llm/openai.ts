/**
 * OpenAI-compatible chat completions adapter (native fetch, no SDK).
 */

import { buildOpenAiUrl } from './url.js';
import { HttpError } from './types.js';
import type { LLMConfig, LLMMessage } from './types.js';

interface OpenAIResponse {
  choices?: { message?: { content?: string }; text?: string }[];
}

/** Extract the assistant text from an OpenAI-shaped response. */
function extractText(data: OpenAIResponse): string {
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content !== 'string') {
    throw new Error('provider returned no completion content');
  }
  if (content.trim().length === 0) {
    // An empty completion is a transient provider glitch (e.g. a reasoning
    // model that put everything in reasoning_content). Throw a non-LLMError so
    // the caller retries the SAME prompt instead of re-asking about JSON.
    throw new Error('provider returned empty completion content');
  }
  return content;
}

function isResponseFormatError(status: number, body: string): boolean {
  return status === 400 && /response_format|json_object/i.test(body);
}

/**
 * POST `{base}/chat/completions` and return the assistant text.
 * When `jsonMode` is `auto`, sends `response_format: {type:'json_object'}` and
 * retries once without it if the endpoint rejects the field (common on
 * third-party/self-hosted gateways). `timeoutMs` is the remaining budget for
 * this attempt (shared total deadline). Throws `HttpError` on other non-2xx
 * responses.
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
    max_tokens: cfg.maxTokens
  };
  if (jsonMode === 'auto') body.response_format = { type: 'json_object' };

  const doFetch = (): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });

  let res = await doFetch();
  let errorText: string | null = null;
  if (!res.ok) {
    errorText = await res.text();
    if (isResponseFormatError(res.status, errorText)) {
      delete body.response_format;
      res = await doFetch();
      errorText = null; // fresh body if the retry also failed
    }
  }
  if (!res.ok) {
    throw new HttpError(res.status, (errorText ?? (await res.text())).slice(0, 500));
  }
  return extractText((await res.json()) as OpenAIResponse);
}
