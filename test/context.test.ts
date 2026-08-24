import { describe, expect, it } from 'vitest';
import { loadConfig, loadContext } from '../src/context.js';
import type { InputReader } from '../src/context.js';

function reader(over: Record<string, string> = {}): InputReader {
  const store: Record<string, string> = {
    api_base_url: 'https://api.example.com/v1',
    api_key: 'sk-key',
    model: 'model-x',
    ...over
  };
  return {
    getInput: (name: string) => store[name] ?? '',
    setSecret: () => {}
  };
}

const basePayload = {
  repository: { name: 'repo', owner: { login: 'owner' } }
};

describe('loadConfig', () => {
  it('reads defaults for optional inputs', () => {
    const cfg = loadConfig(reader());
    expect(cfg.mode).toBe('review');
    expect(cfg.provider).toBe('openai');
    expect(cfg.maxTokens).toBe(8192);
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.exclude).toEqual([]);
    expect(cfg.maxFiles).toBe(40);
    expect(cfg.maxPatchChars).toBe(100000);
    expect(cfg.reviewDrafts).toBe(false);
    expect(cfg.commentTrigger).toBe('/review');
    expect(cfg.failOnError).toBe(false);
  });

  it('throws when a required input is missing', () => {
    for (const missing of ['api_base_url', 'api_key', 'model']) {
      const r = reader({ [missing]: '' });
      expect(() => loadConfig(r)).toThrow(missing);
    }
  });

  it('validates the mode value', () => {
    expect(() => loadConfig(reader({ mode: 'bogus' }))).toThrow(/mode/i);
    expect(loadConfig(reader({ mode: 'summary' })).mode).toBe('summary');
    expect(loadConfig(reader({ mode: 'both' })).mode).toBe('both');
  });

  it('resolves the provider from an explicit input or auto', () => {
    expect(loadConfig(reader({ provider: 'anthropic' })).provider).toBe('anthropic');
    expect(
      loadConfig(reader({ provider: 'auto', api_base_url: 'https://api.anthropic.com' })).provider
    ).toBe('anthropic');
  });

  it('parses comma- and newline-separated exclude patterns', () => {
    const cfg = loadConfig(reader({ exclude: '**/*.md,\n**/generated/**\n  **/skip.ts' }));
    expect(cfg.exclude).toEqual(['**/*.md', '**/generated/**', '**/skip.ts']);
  });

  it('parses numeric and boolean inputs', () => {
    const cfg = loadConfig(
      reader({
        max_tokens: '4096',
        temperature: '0.0',
        max_files: '10',
        max_patch_chars: '50000',
        review_drafts: 'true',
        fail_on_error: 'true'
      })
    );
    expect(cfg.maxTokens).toBe(4096);
    expect(cfg.temperature).toBe(0);
    expect(cfg.maxFiles).toBe(10);
    expect(cfg.maxPatchChars).toBe(50000);
    expect(cfg.reviewDrafts).toBe(true);
    expect(cfg.failOnError).toBe(true);
  });
});

describe('loadContext', () => {
  it('derives a pull_request context', () => {
    const payload = {
      ...basePayload,
      pull_request: {
        number: 7,
        head: { sha: 'abc' },
        draft: true,
        title: 'T',
        body: 'B'
      }
    };
    const ctx = loadContext('pull_request', payload, reader(), 'bot');
    expect(ctx).toMatchObject({ owner: 'owner', repo: 'repo', prNumber: 7, botLogin: 'bot' });
    expect(ctx?.issueComment).toBeUndefined();
  });

  it('derives an issue_comment context on a PR with the trigger', () => {
    const payload = {
      ...basePayload,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: '/review please', user: { login: 'alice' } }
    };
    const ctx = loadContext('issue_comment', payload, reader(), 'bot');
    expect(ctx?.prNumber).toBe(12);
    expect(ctx?.issueComment).toEqual({ author: 'alice', body: '/review please' });
  });

  it('returns null for a comment on a plain issue (not a PR)', () => {
    const payload = { ...basePayload, issue: { number: 5 }, comment: { body: '/review', user: { login: 'alice' } } };
    expect(loadContext('issue_comment', payload, reader(), 'bot')).toBeNull();
  });

  it('returns null when the comment does not start with the trigger', () => {
    const payload = {
      ...basePayload,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: 'hello', user: { login: 'alice' } }
    };
    expect(loadContext('issue_comment', payload, reader(), 'bot')).toBeNull();
  });

  it('returns null when the bot comments on its own PR (loop guard)', () => {
    const payload = {
      ...basePayload,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: '/review', user: { login: 'Bot' } }
    };
    expect(loadContext('issue_comment', payload, reader(), 'bot')).toBeNull();
  });

  it('derives a workflow_dispatch context from the pr_number input', () => {
    const ctx = loadContext('workflow_dispatch', basePayload, reader({ pr_number: '99' }), 'bot');
    expect(ctx?.prNumber).toBe(99);
  });

  it('throws on workflow_dispatch without a valid pr_number', () => {
    expect(() => loadContext('workflow_dispatch', basePayload, reader(), 'bot')).toThrow(/pr_number/i);
  });
});
