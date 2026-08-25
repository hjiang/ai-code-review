import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../src/summarize.js';
import type { ActionConfig, PrContext } from '../src/context.js';
import type { PrInfo, RepoInfo } from '../src/github/reviews.js';
import type { LLMMessage } from '../src/llm/types.js';
import type { MinimalOctokit } from '../src/github/types.js';

const cfg: ActionConfig = {
  mode: 'summary',
  githubToken: 'tok',
  apiKey: 'k',
  baseUrl: 'https://x/v1',
  model: 'm',
  provider: 'openai',
  maxTokens: 100,
  temperature: 0,
  responseFormat: 'auto',
  exclude: [],
  maxFiles: 40,
  maxPatchChars: 5000,
  reviewDrafts: false,
  commentTrigger: '/review',
  failOnError: false
};

const ctx: PrContext = { owner: 'o', repo: 'r', prNumber: 7, botLogin: 'bot' };
const prInfo: PrInfo = { commitId: 'sha', isDraft: false, title: 'Add X', body: 'Does Y' };
const repoInfo: RepoInfo = {
  fullName: 'o/r',
  visibility: 'public',
  description: 'open source',
  defaultBranch: 'main',
  language: 'Go',
  isFork: false,
  isArchived: false
};

const apiFile = (filename: string) => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: '@@ -1 +1 @@\n+new line\n'
});

const apiFileWithPatch = (filename: string, patch: string) => ({
  ...apiFile(filename),
  patch
});

function makeOctokit(over: Partial<MinimalOctokit['rest']> = {}): MinimalOctokit {
  return {
    rest: {
      issues: {
        listComments: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(async () => ({}))
      },
      pulls: {
        listFiles: vi.fn(async () => ({ data: [apiFile('a.ts')] })),
        createReview: vi.fn(async () => ({})),
        get: vi.fn()
      },
      repos: {
        get: vi.fn(async () => ({ data: {} }))
      },
      ...over
    }
  };
}

describe('runSummary', () => {
  it('skips draft PRs unless review_drafts is set', async () => {
    const octo = makeOctokit();
    const llm = vi.fn();
    const res = await runSummary(cfg, ctx, { ...prInfo, isDraft: true }, repoInfo, {
      octokit: octo,
      llm
    });
    expect(res.posted).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(octo.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('does not post twice when the marker comment already exists', async () => {
    const octo = makeOctokit({
      issues: {
        listComments: vi.fn(async () => ({
          data: [{ id: 1, user: { login: 'bot' }, body: '<!-- ai-review:summary -->\nold' }]
        })),
        createComment: vi.fn(async () => ({}))
      }
    });
    const llm = vi.fn();
    const res = await runSummary(cfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
    expect(res.posted).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(octo.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('posts a marker-prefixed summary comment on the happy path', async () => {
    const octo = makeOctokit();
    const llm = vi.fn(async () => ({ summary_md: '**Summary** text' }));
    const res = await runSummary(cfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
    expect(res.posted).toBe(true);
    expect(llm).toHaveBeenCalledTimes(1);
    const [messages] = llm.mock.calls[0] as unknown as [LLMMessage[]];
    expect(messages[0].content).toContain('summary_md');
    expect(messages[1].content).toContain('Add X');
    expect(octo.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const body = (octo.rest.issues.createComment as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .body as string;
    expect(body).toContain('<!-- ai-review:summary -->');
    expect(body).toContain('**Summary** text');
  });

  it('throws when the LLM result has no summary_md field', async () => {
    const octo = makeOctokit();
    const llm = vi.fn(async () => ({ somethingElse: 1 }));
    await expect(runSummary(cfg, ctx, prInfo, repoInfo, { octokit: octo, llm })).rejects.toThrow(
      /summary_md/
    );
  });

  it('forwards cfg.maxPatchChars to the per-file patch cap', async () => {
    // Patch between the filter default per-file cap (20k) and cfg.maxPatchChars:
    // must reach the LLM because the config budget governs, not the hardcoded default.
    const bigPatch = `@@ -1,1000 +1,1000 @@\n${Array.from({ length: 1000 }, () => '+xxxxxxxxxxxxxxxxxxxxxxxxx').join('\n')}\n`; // ~27k chars > 20k default per-file cap
    const octo = makeOctokit({
      pulls: {
        listFiles: vi.fn(async () => ({ data: [apiFileWithPatch('src/big.ts', bigPatch)] })),
        createReview: vi.fn(async () => ({})),
        get: vi.fn()
      }
    });
    const llm = vi.fn(async () => ({ summary_md: 'ok' }));
    const bigCfg = { ...cfg, maxPatchChars: 100000 };
    const res = await runSummary(bigCfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
    expect(res.posted).toBe(true);
    expect(res.filesReviewed).toBe(1);
  });
});
