import { describe, expect, it, vi } from 'vitest';
import { fetchPreviousComments } from '../../src/github/threads.js';
import type { MinimalOctokit } from '../../src/github/types.js';

const comment = (path: string, line: number | null, body: string, inReplyToId?: number) => ({
  path,
  line,
  original_line: line,
  body,
  in_reply_to_id: inReplyToId ?? null
});

function makeOctokit(pages: unknown[][]): MinimalOctokit {
  return {
    rest: {
      pulls: {
        listReviewComments: vi.fn(async (p: { page?: number }) => ({
          data: pages[(p.page ?? 1) - 1] ?? []
        }))
      }
    }
  } as unknown as MinimalOctokit;
}

describe('fetchPreviousComments', () => {
  it('returns one entry per review thread root comment, resolved or not', async () => {
    const octo = makeOctokit([
      [
        comment('src/a.ts', 5, 'SQL injection'),
        comment('src/b.ts', 9, 'Missing null check'),
        // a reply within thread 1 must not become its own entry
        comment('src/a.ts', null, 'I agree', 1001)
      ]
    ]);
    const out = await fetchPreviousComments(octo, 'o', 'r', 7);
    expect(out).toEqual([
      { path: 'src/a.ts', line: 5, body: 'SQL injection' },
      { path: 'src/b.ts', line: 9, body: 'Missing null check' }
    ]);
    expect(octo.rest.pulls.listReviewComments).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      per_page: 100,
      page: 1
    });
  });

  it('falls back to original_line when line is absent', async () => {
    const octo = makeOctokit([
      [{ ...comment('a.ts', null, 'x'), original_line: 42 }]
    ]);
    const out = await fetchPreviousComments(octo, 'o', 'r', 7);
    expect(out[0].line).toBe(42);
  });

  it('skips entries with no path or empty body', async () => {
    const octo = makeOctokit([
      [{ ...comment('a.ts', 1, ''), in_reply_to_id: null }, { path: '', line: 1, body: 'x', in_reply_to_id: null }]
    ]);
    expect(await fetchPreviousComments(octo, 'o', 'r', 7)).toEqual([]);
  });

  it('paginates through full pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => comment(`f${i}.ts`, 1, `b${i}`));
    const page2 = [comment('f100.ts', 2, 'b100')];
    const octo = makeOctokit([page1, page2]);
    const out = await fetchPreviousComments(octo, 'o', 'r', 7);
    expect(out).toHaveLength(101);
  });

  it('stops paging early when a page is short', async () => {
    const octo = makeOctokit([[comment('a.ts', 1, 'x')]]);
    await fetchPreviousComments(octo, 'o', 'r', 7);
    expect(octo.rest.pulls.listReviewComments).toHaveBeenCalledTimes(1);
  });

  it('keeps paging past 10 pages until a short page (no fixed page cap)', async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(`f${i}.ts`, 1, `b${i}`));
    const pages = Array.from({ length: 12 }, () => full); // 12 full pages > old cap
    pages.push([comment('last.ts', 1, 'x')]); // short page terminates the walk
    const octo = makeOctokit(pages);
    const out = await fetchPreviousComments(octo, 'o', 'r', 7);
    expect(out).toHaveLength(12 * 100 + 1);
    expect(octo.rest.pulls.listReviewComments).toHaveBeenCalledTimes(13);
  });
});
