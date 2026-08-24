import { describe, expect, it, vi } from 'vitest';
import { findMarkerComment, postComment } from '../../src/github/comments.js';
import type { MinimalOctokit } from '../../src/github/types.js';

const comment = (id: number, login: string, body: string) => ({
  id,
  user: { login },
  body
});

function makeOctokit(pages: unknown[][]): MinimalOctokit {
  return {
    rest: {
      issues: {
        listComments: vi.fn(async (p: { page?: number }) => ({
          data: pages[(p.page ?? 1) - 1] ?? []
        })),
        createComment: vi.fn(async () => ({}))
      },
      pulls: { listFiles: vi.fn(), createReview: vi.fn() }
    }
  } as unknown as MinimalOctokit;
}

const MARKER = '<!-- ai-review:summary -->';

describe('findMarkerComment', () => {
  it('returns the comment whose body has the marker and whose author matches the bot', async () => {
    const octo = makeOctokit([[comment(1, 'other', 'hi'), comment(2, 'bot', `${MARKER}\nsummary`)]]);
    const found = await findMarkerComment(octo, 'o', 'r', 7, MARKER, 'bot');
    expect(found?.id).toBe(2);
    expect(octo.rest.issues.listComments).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      per_page: 100,
      page: 1
    });
  });

  it('returns null when no comment carries the marker', async () => {
    const octo = makeOctokit([[comment(1, 'bot', 'no marker here')]]);
    expect(await findMarkerComment(octo, 'o', 'r', 7, MARKER, 'bot')).toBeNull();
  });

  it('ignores comments from other authors even with the marker', async () => {
    const octo = makeOctokit([[comment(1, 'someone', `${MARKER}\nspoofed`)]]);
    expect(await findMarkerComment(octo, 'o', 'r', 7, MARKER, 'bot')).toBeNull();
  });

  it('compares the author login case-insensitively', async () => {
    const octo = makeOctokit([[comment(1, 'MyBot', `${MARKER}\nsummary`)]]);
    expect((await findMarkerComment(octo, 'o', 'r', 7, MARKER, 'mybot'))?.id).toBe(1);
  });

  it('paginates through pages until it finds a match', async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(1000 + i, 'bot', 'no marker'));
    const markerPage = [comment(5000, 'bot', `${MARKER}\nfound`)];
    const octo = makeOctokit([full, full, markerPage]);
    const found = await findMarkerComment(octo, 'o', 'r', 7, MARKER, 'bot');
    expect(found?.id).toBe(5000);
    expect(octo.rest.issues.listComments).toHaveBeenCalledTimes(3);
  });

  it('stops paginating after 10 pages and returns null', async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(1000 + i, 'bot', 'no marker'));
    const octo = makeOctokit(Array.from({ length: 12 }, () => full));
    expect(await findMarkerComment(octo, 'o', 'r', 7, MARKER, 'bot')).toBeNull();
    expect(octo.rest.issues.listComments).toHaveBeenCalledTimes(10);
  });
});

describe('postComment', () => {
  it('posts to the issues comments endpoint with the body', async () => {
    const octo = makeOctokit([[]]);
    await postComment(octo, 'o', 'r', 7, 'hello');
    expect(octo.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      body: 'hello'
    });
  });
});
