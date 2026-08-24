import { describe, expect, it, vi } from 'vitest';
import { runReview, validateFindings } from '../src/review.js';
import type { ActionConfig, PrContext } from '../src/context.js';
import type { PrInfo } from '../src/github/reviews.js';
import type { PrFile } from '../src/diff.js';
import type { MinimalOctokit } from '../src/github/types.js';

const cfg: ActionConfig = {
  mode: 'review',
  githubToken: 'tok',
  apiKey: 'k',
  baseUrl: 'https://x/v1',
  model: 'model-x',
  provider: 'openai',
  maxTokens: 100,
  temperature: 0,
  exclude: [],
  maxFiles: 40,
  maxPatchChars: 5000,
  reviewDrafts: false,
  commentTrigger: '/review',
  failOnError: false
};
const ctx: PrContext = { owner: 'o', repo: 'r', prNumber: 7, botLogin: 'bot' };
const prInfo: PrInfo = { commitId: 'sha', isDraft: false, title: 'T', body: '' };

const PATCH = '@@ -1,2 +1,2 @@\n ctx\n+new\n'; // new-side anchors {1, 2}

function file(filename: string, patch: string = PATCH): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, changes: 1, patch };
}

function makeOctokit(files: unknown[]): MinimalOctokit {
  return {
    rest: {
      issues: { listComments: vi.fn(), createComment: vi.fn() },
      pulls: {
        listFiles: vi.fn(async () => ({ data: files })),
        createReview: vi.fn(async () => ({ data: { id: 1 } })),
        get: vi.fn()
      }
    }
  } as unknown as MinimalOctokit;
}

describe('validateFindings', () => {
  const prFiles = [file('src/a.ts')];
  const noop = () => {};

  it('keeps a finding whose path and line are in the diff', () => {
    const out = validateFindings(
      [{ path: 'src/a.ts', line: 2, severity: 'warning', comment_md: 'x' }],
      prFiles,
      noop
    );
    expect(out).toEqual([
      { path: 'src/a.ts', line: 2, severity: 'warning', category: 'code', comment_md: 'x', suggestion_md: null }
    ]);
  });

  it('drops findings whose path is not in the diff', () => {
    const out = validateFindings(
      [{ path: 'src/other.ts', line: 2, severity: 'warning', comment_md: 'x' }],
      prFiles,
      noop
    );
    expect(out).toEqual([]);
  });

  it('repairs ./-prefixed and case-mismatched paths', () => {
    const out = validateFindings(
      [
        { path: './src/a.ts', line: 2, severity: 'warning', comment_md: 'x' },
        { path: 'SRC/A.TS', line: 1, severity: 'warning', comment_md: 'y' }
      ],
      prFiles,
      noop
    );
    expect(out.map((f) => f.path)).toEqual(['src/a.ts', 'src/a.ts']);
  });

  it('snaps an off-by-a-bit line to the nearest valid anchor', () => {
    const out = validateFindings(
      [{ path: 'src/a.ts', line: 4, severity: 'warning', comment_md: 'x' }],
      prFiles,
      noop
    );
    expect(out[0].line).toBe(2);
  });

  it('drops findings whose line is far from any valid anchor', () => {
    const out = validateFindings(
      [{ path: 'src/a.ts', line: 100, severity: 'warning', comment_md: 'x' }],
      prFiles,
      noop
    );
    expect(out).toEqual([]);
  });

  it('coerces unknown severities to suggestion', () => {
    const out = validateFindings(
      [{ path: 'src/a.ts', line: 2, severity: 'critical-ish', comment_md: 'x' }],
      prFiles,
      noop
    );
    expect(out[0].severity).toBe('suggestion');
  });

  it('drops findings with an empty comment', () => {
    const out = validateFindings(
      [{ path: 'src/a.ts', line: 2, severity: 'warning', comment_md: '   ' }],
      prFiles,
      noop
    );
    expect(out).toEqual([]);
  });

  it('dedupes identical (path, line) keeping the highest severity', () => {
    const out = validateFindings(
      [
        { path: 'src/a.ts', line: 2, severity: 'suggestion', comment_md: 'low' },
        { path: 'src/a.ts', line: 2, severity: 'critical', comment_md: 'high' }
      ],
      prFiles,
      noop
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('critical');
  });

  it('caps the total number of comments at 30', () => {
    const patch40 = `@@ -1,40 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+line${i}`).join('\n')}\n`;
    const wide = [file('src/a.ts', patch40)];
    const many = Array.from({ length: 40 }, (_, i) => ({
      path: 'src/a.ts',
      line: i + 1,
      severity: 'warning',
      comment_md: `issue ${i}`
    }));
    const out = validateFindings(many, wide, noop);
    expect(out).toHaveLength(30);
  });
});

describe('runReview', () => {
  it('skips draft PRs unless review_drafts is set', async () => {
    const octo = makeOctokit([file('src/a.ts')]);
    const llm = vi.fn();
    const res = await runReview(cfg, ctx, { ...prInfo, isDraft: true }, { octokit: octo, llm });
    expect(res.commentCount).toBe(0);
    expect(llm).not.toHaveBeenCalled();
    expect(octo.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('posts a review noting nothing to review when all files are filtered', async () => {
    const octo = makeOctokit([{ filename: 'package-lock.json', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '…' }]);
    const llm = vi.fn();
    const res = await runReview(cfg, ctx, prInfo, { octokit: octo, llm });
    expect(res).toEqual({ commentCount: 0, filesReviewed: 0 });
    expect(llm).not.toHaveBeenCalled();
    expect(octo.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [], body: expect.stringContaining('Nothing to review') })
    );
  });

  it('posts a review with validated inline comments on the happy path', async () => {
    const octo = makeOctokit([file('src/a.ts')]);
    const llm = vi.fn(async () => ({
      findings: [{ path: 'src/a.ts', line: 2, severity: 'warning', category: 'correctness', comment_md: '**issue**' }]
    }));
    const res = await runReview(cfg, ctx, prInfo, { octokit: octo, llm });
    expect(res.commentCount).toBe(1);
    expect(res.filesReviewed).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
    const payload = (octo.rest.pulls.createReview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.commit_id).toBe('sha');
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments).toEqual([
      { path: 'src/a.ts', line: 2, body: '**issue**', side: 'RIGHT' }
    ]);
    expect(payload.body).toContain('model-x');
    expect(payload.body).toContain('1');
  });

  it('merges findings across multiple chunks (one LLM call per chunk)', async () => {
    const octo = makeOctokit([file('a.ts'), file('b.ts')]);
    const llm = vi.fn(async () => ({
      findings: [
        { path: 'a.ts', line: 2, severity: 'warning', comment_md: 'A' },
        { path: 'b.ts', line: 2, severity: 'warning', comment_md: 'B' }
      ]
    }));
    const smallCfg = { ...cfg, maxPatchChars: 20 };
    const res = await runReview(smallCfg, ctx, prInfo, { octokit: octo, llm });
    expect(res.commentCount).toBe(2);
    expect(llm).toHaveBeenCalledTimes(2);
    const payload = (octo.rest.pulls.createReview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.comments).toHaveLength(2);
  });

  it('treats a malformed findings field as no findings rather than crashing', async () => {
    const octo = makeOctokit([file('src/a.ts')]);
    const llm = vi.fn(async () => ({ findings: 'oops' }));
    const res = await runReview(cfg, ctx, prInfo, { octokit: octo, llm });
    expect(res.commentCount).toBe(0);
    expect(octo.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [] })
    );
  });
});
