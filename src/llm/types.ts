/**
 * Shared LLM client types.
 */

export type Provider = 'openai' | 'anthropic';

/** Thinking effort, normalized across providers; `auto` = today's behavior. */
export type ThinkingLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';

export interface LLMConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  /**
   * Sampling temperature. Omitted from the request when undefined (Anthropic:
   * Claude 4.7+/5.x reject any non-default value with 400, even without
   * thinking, so the action leaves it unset unless configured explicitly).
   */
  temperature?: number;
  /** Provider-mapped thinking effort; `auto` and `off` send no effort level. */
  thinking?: ThinkingLevel;
  /** `auto`: send `response_format` and retry without it on 400; `off`: never. */
  jsonMode?: 'auto' | 'off';
  /**
   * Wall-clock budget for one logical LLM call (`callLLM`), ms: every HTTP
   * attempt, the response_format compat retry, and the JSON re-ask share it.
   * Defaults to 5 minutes; `0` (or any non-finite value) removes the
   * client-side deadline. Responses stream (SSE) with a 5-minute no-bytes
   * stall detector, so uncapped requests support arbitrarily long thinking
   * (bounded by provider limits and the job timeout).
   */
  timeoutMs?: number;
  /** User-supplied extra request-body keys (merged after defaults; user wins). */
  extraBody?: Record<string, unknown>;
  /** Optional diagnostic sink (e.g. Actions `core.info`); receives non-secret LLM chatter. */
  log?: (msg: string) => void;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Thrown when the HTTP call or JSON contract with the provider fails. */
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Thrown by adapters on a non-2xx provider response. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Thrown by adapters when the provider returns an empty/missing completion
 * (e.g. `content: ""`). Distinct from `HttpError` and `LLMError` so the client
 * can treat it specially: same-prompt HTTP retries rarely help, but a JSON
 * re-ask nudge often recovers a real answer.
 */
export class EmptyCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyCompletionError';
  }
}
