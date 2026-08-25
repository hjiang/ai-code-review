import { describe, expect, it, vi } from 'vitest';
import { getPr, getRepo, postReview } from '../../src/github/reviews.js';
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
    // First attempt (with the comment) plus one retry with no comments.
    expect(createReview).toHaveBeenCalledTimes(2);
  });

  it('drops a single rejected anchor and retries with no comments', async () => {
    const err = new Error('Validation Failed') as Error & { status?: number };
    err.status = 422;
    const calls: unknown[] = [];
    const createReview = vi.fn(async (p: unknown) => {
      calls.push(p);
      if ((p as { comments: unknown[] }).comments.length > 0) throw err;
      return { data: { id: 5 } };
    });
    const octo = makeOctokit(createReview);
    const log = vi.fn();
    const result = await postReview(
      octo,
      'o',
      'r',
      7,
      { commitId: 'x', body: 'review', comments: [okComment('bad.ts', 9999, 'bad anchor')] },
      log
    );
    expect(result).toEqual({ data: { id: 5 } });
    expect(createReview).toHaveBeenCalledTimes(2);
    expect((calls[1] as { comments: unknown[] }).comments).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad.ts:9999'));
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

describe('getPr', () => {
  it('maps the pulls.get response onto PrInfo', async () => {
    const get = vi.fn(async () => ({
      data: { head: { sha: 'sha1' }, draft: false, title: 'T', body: 'B' }
    }));
    const octo = {
      rest: { issues: {}, pulls: { get, createReview: vi.fn(), listFiles: vi.fn() } }
    } as unknown as MinimalOctokit;
    const info = await getPr(octo, 'o', 'r', 7);
    expect(info).toEqual({ commitId: 'sha1', isDraft: false, title: 'T', body: 'B' });
    expect(get).toHaveBeenCalledWith({ owner: 'o', repo: 'r', pull_number: 7 });
  });

  it('coerces a missing PR body to an empty string', async () => {
    const get = vi.fn(async () => ({ data: { head: { sha: 's' }, draft: true, title: 'T', body: null } }));
    const octo = {
      rest: { issues: {}, pulls: { get, createReview: vi.fn(), listFiles: vi.fn() } }
    } as unknown as MinimalOctokit;
    expect((await getPr(octo, 'o', 'r', 7)).body).toBe('');
  });
});

describe('getRepo', () => {
  it('maps the repos.get response onto RepoInfo', async () => {
    const get = vi.fn(async () => ({
      data: {
        full_name: 'o/r',
        visibility: 'private',
        description: 'desc',
        default_branch: 'main',
        language: 'Go',
        fork: false,
        archived: false
      }
    }));
    const octo = {
      rest: { issues: {}, pulls: {}, repos: { get } }
    } as unknown as MinimalOctokit;
    const info = await getRepo(octo, 'o', 'r');
    expect(info).toEqual({
      fullName: 'o/r',
      visibility: 'private',
      description: 'desc',
      defaultBranch: 'main',
      language: 'Go',
      isFork: false,
      isArchived: false
    });
    expect(get).toHaveBeenCalledWith({ owner: 'o', repo: 'r' });
  });

  it('falls back to owner/repo and private flag when fields are missing', async () => {
    const get = vi.fn(async () => ({
      data: { private: true }
    }));
    const octo = {
      rest: { issues: {}, pulls: {}, repos: { get } }
    } as unknown as MinimalOctokit;
    const info = await getRepo(octo, 'owner-x', 'repo-y');
    expect(info.visibility).toBe('private');
    expect(info.fullName).toBe('owner-x/repo-y');
    expect(info.description).toBe('');
    expect(info.defaultBranch).toBe('');
    expect(info.language).toBeNull();
    expect(info.isFork).toBe(false);
    expect(info.isArchived).toBe(false);
  });
});
