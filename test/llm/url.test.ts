import { describe, expect, it } from 'vitest';
import { buildAnthropicUrl, buildOpenAiUrl } from '../../src/llm/url.js';

describe('buildOpenAiUrl', () => {
  it('appends /chat/completions to a /v1 base', () => {
    expect(buildOpenAiUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
  });
  it('handles bare hosts and trailing slashes', () => {
    expect(buildOpenAiUrl('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1/chat/completions'
    );
  });
  it('is idempotent for an already-full base', () => {
    const full = 'https://example.com/v1/chat/completions';
    expect(buildOpenAiUrl(full)).toBe(full);
  });
});

describe('buildAnthropicUrl', () => {
  it('appends /v1/messages to a bare host', () => {
    expect(buildAnthropicUrl('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
  });
  it('does not double the /v1 segment', () => {
    expect(buildAnthropicUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(buildAnthropicUrl('https://api.anthropic.com/v1/')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
  });
  it('keeps a custom path with its own version segment', () => {
    expect(buildAnthropicUrl('https://proxy.example.com/v1')).toBe(
      'https://proxy.example.com/v1/messages'
    );
  });
});
