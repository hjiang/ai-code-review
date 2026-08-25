import { describe, expect, it } from 'vitest';
import { loadConfig, loadContext } from '../src/context.js';
import type { InputReader } from '../src/context.js';

function reader(over: Record<string, string> = {}): InputReader {
  const store: Record<string, string> = {
    api_base_url: 'https://api.example.com/v1',
    api_key: 'sk-key',
    model: 'model-x',
    github_token: 'gh-token',
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
    expect(cfg.responseFormat).toBe('auto');
    expect(cfg.extraBody).toEqual({});
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

  it('throws a clear error for non-numeric numeric inputs', () => {
    for (const name of ['max_tokens', 'max_files', 'max_patch_chars']) {
      const r = reader({ [name]: 'lots' });
      expect(() => loadConfig(r)).toThrow(`invalid input "${name}"`);
    }
    const r = reader({ temperature: 'hot' });
    expect(() => loadConfig(r)).toThrow('invalid input "temperature"');
  });

  it('throws a clear error for non-positive numeric inputs', () => {
    for (const name of ['max_tokens', 'max_files', 'max_patch_chars']) {
      const r = reader({ [name]: '0' });
      expect(() => loadConfig(r)).toThrow(`invalid input "${name}"`);
    }
    const r = reader({ temperature: '-0.5' });
    expect(() => loadConfig(r)).toThrow('invalid input "temperature"');
  });

  it('validates the mode value', () => {
    expect(() => loadConfig(reader({ mode: 'bogus' }))).toThrow(/mode/i);
    expect(loadConfig(reader({ mode: 'summary' })).mode).toBe('summary');
    expect(loadConfig(reader({ mode: 'both' })).mode).toBe('both');
  });

  it('parses and validates the response_format value', () => {
    expect(loadConfig(reader()).responseFormat).toBe('auto');
    expect(loadConfig(reader({ response_format: 'off' })).responseFormat).toBe('off');
    expect(() => loadConfig(reader({ response_format: 'bogus' }))).toThrow(/response_format/i);
  });

  it('parses extra_body as a JSON object and rejects invalid values', () => {
    expect(
      loadConfig(reader({ extra_body: '{"thinking":{"type":"disabled"}}' })).extraBody
    ).toEqual({ thinking: { type: 'disabled' } });
    expect(loadConfig(reader({ extra_body: '' })).extraBody).toEqual({});
    expect(() => loadConfig(reader({ extra_body: 'not-json' }))).toThrow(/extra_body/i);
    expect(() => loadConfig(reader({ extra_body: '[1,2]' }))).toThrow(/extra_body/i);
  });

  it('auto-disables thinking for DeepSeek base URLs when extra_body is unset', () => {
    // DeepSeek's API defaults thinking to ENABLED (documented) and its v4
    // reasoning models burn the whole token budget on reasoning_content for
    // review-sized prompts -> empty content. So the action opts DeepSeek out
    // unless the user configures extra_body themselves.
    for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/v1']) {
      expect(loadConfig(reader({ api_base_url: base })).extraBody).toEqual({
        thinking: { type: 'disabled' }
      });
    }
  });

  it('an explicit extra_body always wins over the DeepSeek auto-default', () => {
    expect(
      loadConfig(
        reader({ api_base_url: 'https://api.deepseek.com/v1', extra_body: '{"thinking":{"type":"enabled"}}' })
      ).extraBody
    ).toEqual({ thinking: { type: 'enabled' } });
    expect(
      loadConfig(
        reader({ api_base_url: 'https://api.deepseek.com/v1', extra_body: '{"reasoning_effort":"low"}' })
      ).extraBody
    ).toEqual({ reasoning_effort: 'low' });
    // An explicitly empty object is still a user override: no auto-default.
    expect(
      loadConfig(reader({ api_base_url: 'https://api.deepseek.com/v1', extra_body: '{}' })).extraBody
    ).toEqual({});
  });

  it('leaves extra_body empty for non-DeepSeek providers', () => {
    expect(loadConfig(reader()).extraBody).toEqual({});
    expect(
      loadConfig(reader({ api_base_url: 'https://api.openai.com/v1' })).extraBody
    ).toEqual({});
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
    const ctx = loadContext('pull_request', payload, reader(), 'github-actions[bot]');
    expect(ctx).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      prNumber: 7,
      botLogin: 'github-actions[bot]'
    });
    expect(ctx?.issueComment).toBeUndefined();
  });

  it('derives an issue_comment context on a PR with the trigger', () => {
    const payload = {
      ...basePayload,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: '/review please', user: { login: 'alice' } }
    };
    const ctx = loadContext('issue_comment', payload, reader(), 'github-actions[bot]');
    expect(ctx?.prNumber).toBe(12);
    expect(ctx?.issueComment).toEqual({ author: 'alice', body: '/review please' });
    expect(ctx?.botLogin).toBe('github-actions[bot]');
  });

  it('returns null for a comment on a plain issue (not a PR)', () => {
    const payload = { ...basePayload, issue: { number: 5 }, comment: { body: '/review', user: { login: 'alice' } } };
    expect(loadContext('issue_comment', payload, reader(), 'github-actions[bot]')).toBeNull();
  });

  it('returns null when the comment does not start with the trigger', () => {
    const payload = {
      ...basePayload,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: 'hello', user: { login: 'alice' } }
    };
    expect(loadContext('issue_comment', payload, reader(), 'github-actions[bot]')).toBeNull();
  });

  it('returns null when the bot comments on its own PR (loop guard)', () => {
    const payload = {
      ...basePayload,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: '/review', user: { login: 'github-actions[bot]' } }
    };
    expect(loadContext('issue_comment', payload, reader(), 'github-actions[bot]')).toBeNull();
  });

  it('does NOT drop a human /review comment even when the event actor matches the author', () => {
    // Regression: the loop guard must compare the comment author against the
    // TOKEN identity (botLogin), never against github.context.actor - on
    // issue_comment events the actor IS the comment author, so an actor-based
    // guard would silently drop every human /review comment (FR-R1).
    const payload = {
      ...basePayload,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: '/review', user: { login: 'alice' } }
    };
    const ctx = loadContext('issue_comment', payload, reader(), 'github-actions[bot]');
    expect(ctx).not.toBeNull();
    expect(ctx?.issueComment?.author).toBe('alice');
  });

  it('derives a workflow_dispatch context from the pr_number input', () => {
    const ctx = loadContext('workflow_dispatch', basePayload, reader({ pr_number: '99' }), 'github-actions[bot]');
    expect(ctx?.prNumber).toBe(99);
    expect(ctx?.botLogin).toBe('github-actions[bot]');
  });

  it('throws on workflow_dispatch without a valid pr_number', () => {
    expect(() => loadContext('workflow_dispatch', basePayload, reader(), 'github-actions[bot]')).toThrow(/pr_number/i);
  });
});
