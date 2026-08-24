import { describe, expect, it, vi } from 'vitest';
import { postReview } from '../../src/github/reviews.js';
import type { InlineComment, MinimalOctokit } from '../../src/github/types.js';

const okComment = (path: string, line: number, body = 'good'): InlineComment => ({
  path,
  line,
  body,
  side: 'RIGHT'
});

function makeOctokit(createReview: (p: unknown) => Promise<unknown>): MinimalOctokit {
  return {
    rest: {
      issues: { listComments: vi.fn(), createComment: vi.fn() },
      pulls: {
        listFiles: vi.fn(),
        createReview
      }
    }
  } as unknown as MinimalOctokit;
}

describe('postReview', () => {
  it('posts the expected PR review payload', async () => {
    const createReview = vi.fn(async () => ({ data: { id: 42 } }));
    const octo = makeOctokit(createReview);
    const comments = [okComment('src/a.ts', 10, 'issue A')];
    const result = await postReview(octo, 'o', 'r', 7, {
      commitId: 'abc123',
      body: '## Review',
      comments
    });
    expect(result).toEqual({ data: { id: 42 } });
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      commit_id: 'abc123',
      event: 'COMMENT',
      body: '## Review',
      comments: [{ path: 'src/a.ts', line: 10, body: 'issue A', side: 'RIGHT' }]
    });
  });

  it('posts the review even with an empty comments list', async () => {
    const createReview = vi.fn(async () => ({}));
    const octo = makeOctokit(createReview);
    await postReview(octo, 'o', 'r', 7, { commitId: 'x', body: 'No issues 🎉', comments: [] });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [] })
    );
  });

  it('drops a rejected comment anchor and retries once without it', async () => {
    const calls: unknown[] = [];
    const createReview = vi.fn(async (p: unknown) => {
      calls.push(p);
      const comments = (p as { comments: unknown[] }).comments;
      if (comments.length === 3) {
        const err = new Error('Validation Failed') as Error & { status?: number };
        err.status = 422;
        throw err;
      }
      return { data: { id: 99 } };
    });
    const octo = makeOctokit(createReview);
    const log = vi.fn();
    const comments = [
      okComment('a.ts', 1),
      okComment('b.ts', 2),
      okComment('bad.ts', 9999, 'bad anchor')
    ];
    await postReview(octo, 'o', 'r', 7, { commitId: 'x', body: 'review', comments }, log);
    expect(createReview).toHaveBeenCalledTimes(2);
    expect((calls[1] as { comments: unknown[] }).comments).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad.ts:9999'));
  });

  it('rethrows the 422 once all comments have been dropped', async () => {
    const err = new Error('still failing') as Error & { status?: number };
    err.status = 422;
    const createReview = vi.fn(async () => {
      throw err;
    });
    const octo = makeOctokit(createReview);
    await expect(
      postReview(octo, 'o', 'r', 7, {
        commitId: 'x',
        body: 'review',
        comments: [okComment('a.ts', 1)]
      })
    ).rejects.toBe(err);
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-422 errors immediately', async () => {
    const err = new Error('auth failed');
    const createReview = vi.fn(async () => {
      throw err;
    });
    const octo = makeOctokit(createReview);
    await expect(
      postReview(octo, 'o', 'r', 7, {
        commitId: 'x',
        body: 'review',
        comments: [okComment('a.ts', 1)]
      })
    ).rejects.toBe(err);
    expect(createReview).toHaveBeenCalledTimes(1);
  });
});
