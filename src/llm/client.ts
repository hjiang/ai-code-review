/**
 * Provider-agnostic LLM client.
 *
 * Dispatches to the OpenAI or Anthropic adapter based on `provider`, retries
 * transient HTTP failures (429/5xx/network) with exponential backoff, and
 * enforces the strict-JSON contract: on a non-JSON reply it re-asks once with
 * the parse error appended, then gives up with `LLMError`.
 */

import { openaiChat } from './openai.js';
import { anthropicChat } from './anthropic.js';
import { extractJson } from './json.js';
import { HttpError, LLMError } from './types.js';
import type { LLMConfig, LLMMessage, Provider } from './types.js';
import { backoffMs, sleep } from '../util/retry.js';

// Re-export the public error type so consumers import from the client entry.
export { LLMError } from './types.js';

const MAX_HTTP_ATTEMPTS = 3;
const MAX_PARSE_ATTEMPTS = 2;

/** Resolve the effective provider from an explicit input + base URL. */
export function resolveProvider(input: string | undefined, baseUrl: string): Provider {
  if (input === 'openai' || input === 'anthropic') return input;
  if (/api\.anthropic\.com/i.test(baseUrl)) return 'anthropic';
  return 'openai';
}

async function chatOnce(
  cfg: LLMConfig,
  messages: LLMMessage[],
  jsonMode: 'auto' | 'off'
): Promise<string> {
  return cfg.provider === 'anthropic'
    ? anthropicChat(cfg, messages)
    : openaiChat(cfg, messages, jsonMode);
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return !(err instanceof LLMError); // transient network/parse-agnostic errors
}

/** One HTTP round-trip with backoff retries; returns the raw reply text. */
async function requestWithRetry(
  cfg: LLMConfig,
  messages: LLMMessage[],
  jsonMode: 'auto' | 'off'
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt++) {
    try {
      return await chatOnce(cfg, messages, jsonMode);
    } catch (err) {
      lastErr = err;
      if (isRetryable(err) && attempt < MAX_HTTP_ATTEMPTS - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
      break;
    }
  }
  if (lastErr instanceof HttpError) {
    throw new LLMError(`LLM HTTP ${lastErr.status}: ${lastErr.message}`);
  }
  throw new LLMError(`LLM request failed: ${String(lastErr)}`);
}

/**
 * Ask the provider for structured JSON, re-asking once when the reply does not
 * parse. Returns the parsed value; throws `LLMError` on failure.
 */
export async function callLLM(cfg: LLMConfig, messages: LLMMessage[]): Promise<unknown> {
  const jsonMode = cfg.jsonMode ?? 'auto';
  let msgs = [...messages];
  for (let parseAttempt = 0; parseAttempt < MAX_PARSE_ATTEMPTS; parseAttempt++) {
    const text = await requestWithRetry(cfg, msgs, jsonMode);
    try {
      return extractJson(text);
    } catch (err) {
      if (parseAttempt < MAX_PARSE_ATTEMPTS - 1) {
        msgs = [
          ...msgs,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: `Your previous reply was not valid JSON: ${(err as Error).message}. Reply with JSON only.`
          }
        ];
        continue;
      }
      throw new LLMError(`LLM returned invalid JSON twice: ${(err as Error).message}`);
    }
  }
  throw new LLMError('unreachable');
}
