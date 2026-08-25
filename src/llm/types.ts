/**
 * Shared LLM client types.
 */

export type Provider = 'openai' | 'anthropic';

export interface LLMConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** `auto`: send `response_format` and retry without it on 400; `off`: never. */
  jsonMode?: 'auto' | 'off';
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
