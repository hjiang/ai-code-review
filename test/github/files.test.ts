import { describe, expect, it, vi } from 'vitest';
import { fetchPrFiles } from '../../src/diff.js';
import type { MinimalOctokit } from '../../src/github/types.js';

const apiFile = (filename: string, over: Record<string, unknown> = {}) => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: '@@ -1 +1 @@\n+hi\n',
  ...over
});

function makeOctokit(pages: unknown[][]): MinimalOctokit {
  return {
    rest: {
      issues: { listComments: vi.fn(), createComment: vi.fn() },
      pulls: {
        listFiles: vi.fn(async (p: { page?: number }) => ({
          data: pages[(p.page ?? 1) - 1] ?? []
        })),
        createReview: vi.fn()
      }
    }
  } as unknown as MinimalOctokit;
}

describe('fetchPrFiles', () => {
  it('maps API files to PrFile and paginates', async () => {
    const full = Array.from({ length: 100 }, (_, i) => apiFile(`a${i}.ts`));
    const octo = makeOctokit([full, [apiFile('last.ts')]]);
    const files = await fetchPrFiles(octo, 'o', 'r', 7);
    expect(files).toHaveLength(101);
    expect(files[0].filename).toBe('a0.ts');
    expect(files[100].filename).toBe('last.ts');
    expect(files[0]).toMatchObject({ status: 'modified', additions: 1 });
    expect(files[0].patch).toContain('+hi');
    expect(octo.rest.pulls.listFiles).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      per_page: 100,
      page: 1
    });
    expect(octo.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
  });

  it('stops when a page returns fewer than the page size', async () => {
    const octo = makeOctokit([[apiFile('a.ts')], [apiFile('b.ts')]]);
    const files = await fetchPrFiles(octo, 'o', 'r', 7);
    expect(files).toHaveLength(1);
    expect(octo.rest.pulls.listFiles).toHaveBeenCalledTimes(1);
  });

  it('preserves a null patch for binary files', async () => {
    const octo = makeOctokit([[apiFile('img.png', { patch: undefined })]]);
    const files = await fetchPrFiles(octo, 'o', 'r', 7);
    expect(files[0].patch).toBeNull();
  });

  it('returns an empty list for a PR with no files', async () => {
    const octo = makeOctokit([[]]);
    expect(await fetchPrFiles(octo, 'o', 'r', 7)).toEqual([]);
  });
});
