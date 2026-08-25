/**
 * Provider-agnostic LLM client.
 *
 * Dispatches to the OpenAI or Anthropic adapter based on `provider`, retries
 * transient HTTP failures (429/5xx/network) with exponential backoff, and
 * enforces the strict-JSON contract: on a non-JSON or EMPTY reply it re-asks
 * once with a JSON nudge appended, then gives up with `LLMError`. Empty
 * completions skip same-prompt HTTP retries (they don't recover) and go
 * straight to the re-ask, which has proven to recover real answers.
 */

import { openaiChat } from './openai.js';
import { anthropicChat } from './anthropic.js';
import { extractJson } from './json.js';
import { EmptyCompletionError, HttpError, LLMError } from './types.js';
import type { LLMConfig, LLMMessage, Provider } from './types.js';
import { backoffMs, sleep } from '../util/retry.js';
import { excerpt } from '../util/text.js';

// Re-export the public error type so consumers import from the client entry.
export { LLMError } from './types.js';

const MAX_HTTP_ATTEMPTS = 3;
const MAX_PARSE_ATTEMPTS = 2;
/** Total budget for one LLM request including all HTTP retries and backoff. */
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolve the effective provider from an explicit input + base URL. */
export function resolveProvider(input: string | undefined, baseUrl: string): Provider {
  if (input === 'openai' || input === 'anthropic') return input;
  if (/api\.anthropic\.com/i.test(baseUrl)) return 'anthropic';
  return 'openai';
}

async function chatOnce(
  cfg: LLMConfig,
  messages: LLMMessage[],
  jsonMode: 'auto' | 'off',
  timeoutMs: number
): Promise<string> {
  return cfg.provider === 'anthropic'
    ? anthropicChat(cfg, messages, timeoutMs)
    : openaiChat(cfg, messages, jsonMode, timeoutMs);
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof EmptyCompletionError) return false; // same-prompt retry didn't help; re-ask instead
  return !(err instanceof LLMError); // transient network/parse-agnostic errors
}

/**
 * One HTTP round-trip with backoff retries; returns the raw reply text.
 * A single deadline is computed up front and each attempt receives the
 * remaining budget, so the total request (all attempts + backoff) cannot
 * exceed `TOTAL_TIMEOUT_MS`.
 */
async function requestWithRetry(
  cfg: LLMConfig,
  messages: LLMMessage[],
  jsonMode: 'auto' | 'off'
): Promise<string> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break; // total deadline exhausted; give up
    try {
      return await chatOnce(cfg, messages, jsonMode, remaining);
    } catch (err) {
      lastErr = err;
      if (isRetryable(err) && attempt < MAX_HTTP_ATTEMPTS - 1) {
        // Log transient failures (incl. empty completions) so retries are
        // visible in the workflow log; the reply body is already omitted from
        // the message to keep it one-line and secret-free.
        cfg.log?.(`llm: attempt #${attempt + 1} failed (${String(err)}), retrying`);
        // Never sleep past the deadline: clamp the backoff to the remaining
        // budget (skipping the sleep entirely when it is exhausted).
        const wait = Math.min(backoffMs(attempt), deadline - Date.now());
        if (wait > 0) await sleep(wait);
        continue;
      }
      break;
    }
  }
  if (lastErr === undefined) {
    // The shared deadline was exhausted before any attempt could start (e.g.
    // the clock jumped past the deadline between computation and the first
    // attempt); surface a clear timeout instead of `LLM request failed: undefined`.
    throw new LLMError(`LLM deadline exceeded after ${TOTAL_TIMEOUT_MS}ms`);
  }
  if (lastErr instanceof HttpError) {
    throw new LLMError(`LLM HTTP ${lastErr.status}: ${lastErr.message}`);
  }
  if (lastErr instanceof EmptyCompletionError) {
    throw lastErr; // preserved so callLLM can recover via a JSON re-ask
  }
  throw new LLMError(`LLM request failed: ${String(lastErr)}`);
}

/**
 * Ask the provider for structured JSON, re-asking once when the reply does not
 * parse. Returns the parsed value; throws `LLMError` on failure. Every failed
 * parse attempt is surfaced (truncated raw reply) via `cfg.log` AND embedded
 * in the final error so the failure is diagnosable in CI logs without leaking
 * secrets (replies may carry user-code snippets, but never credentials).
 */
export async function callLLM(cfg: LLMConfig, messages: LLMMessage[]): Promise<unknown> {
  const jsonMode = cfg.jsonMode ?? 'auto';
  const log = cfg.log ?? (() => {});
  let msgs = [...messages];
  const rawReplies: string[] = [];
  let retriedWithoutFormat = false;
  let parseAttempt = 0;
  while (parseAttempt < MAX_PARSE_ATTEMPTS) {
    const effectiveMode = jsonMode === 'auto' && retriedWithoutFormat ? 'off' : jsonMode;
    let text: string;
    try {
      text = await requestWithRetry(cfg, msgs, effectiveMode);
    } catch (err) {
      if (!(err instanceof EmptyCompletionError)) throw err;
      if (jsonMode === 'auto' && cfg.provider === 'openai' && !retriedWithoutFormat) {
        // Reasoning models (e.g. deepseek-v4-flash) can burn the whole token
        // budget on reasoning when `response_format: json_object` is sent,
        // returning empty content with finish_reason=length. Retry the same
        // prompt once WITHOUT response_format before re-asking — the provider
        // then emits real JSON within budget.
        retriedWithoutFormat = true;
        log(
          'llm: empty completion with response_format; retrying the same prompt without response_format'
        );
        continue; // same parse attempt, same messages, jsonMode off
      }
      log(`llm: attempt #${parseAttempt + 1} empty completion; re-asking with a JSON nudge`);
      text = '';
    }
    rawReplies.push(text);
    try {
      return extractJson(text);
    } catch (err) {
      log(
        `llm: attempt #${parseAttempt + 1} not strict JSON (${(err as Error).message}); ` +
          `raw reply: ${excerpt(text)}`
      );
      if (parseAttempt < MAX_PARSE_ATTEMPTS - 1) {
        msgs = [
          ...msgs,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: `Your previous reply was not valid JSON: ${(err as Error).message}. Reply with JSON only.`
          }
        ];
        parseAttempt++;
        continue;
      }
      throw new LLMError(
        `LLM returned invalid JSON twice: ${(err as Error).message}. ` +
          `Raw replies: [${rawReplies.map((r, i) => `#${i + 1}=${excerpt(r)}`).join(', ')}]`
      );
    }
  }
  throw new LLMError('unreachable');
}
