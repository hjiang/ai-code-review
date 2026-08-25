import { describe, expect, it, vi } from 'vitest';
import { runReview, validateFindings } from '../src/review.js';
import type { RawFinding } from '../src/review.js';
import type { ActionConfig, PrContext } from '../src/context.js';
import type { PrInfo, RepoInfo } from '../src/github/reviews.js';
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
const repoInfo: RepoInfo = {
  fullName: 'o/r',
  visibility: 'private',
  description: 'secret store',
  defaultBranch: 'main',
  language: 'TypeScript',
  isFork: false,
  isArchived: false
};

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

  it('caps at 30 findings preferring higher severity (deterministic tie-break)', () => {
    const patch40 = `@@ -1,40 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+line${i}`).join('\n')}\n`;
    const wide = [file('src/wide.ts', patch40)];
    const many: RawFinding[] = [];
    // 32 suggestions arrive first...
    for (let i = 1; i <= 32; i++) {
      many.push({ path: 'src/wide.ts', line: i, severity: 'suggestion', comment_md: `s${i}` });
    }
    // ...and the criticals arrive last: they must survive the cap.
    many.push({ path: 'src/wide.ts', line: 33, severity: 'critical', comment_md: 'c33' });
    many.push({ path: 'src/wide.ts', line: 34, severity: 'critical', comment_md: 'c34' });
    const out = validateFindings(many, wide, noop);
    expect(out).toHaveLength(30);
    expect(out.filter((f) => f.severity === 'critical')).toHaveLength(2);
    expect(out.filter((f) => f.severity === 'suggestion')).toHaveLength(28);
  });
});

describe('runReview', () => {
  it('skips draft PRs unless review_drafts is set', async () => {
    const octo = makeOctokit([file('src/a.ts')]);
    const llm = vi.fn();
    const res = await runReview(cfg, ctx, { ...prInfo, isDraft: true }, repoInfo, {
      octokit: octo,
      llm
    });
    expect(res.commentCount).toBe(0);
    expect(llm).not.toHaveBeenCalled();
    expect(octo.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('posts a review noting nothing to review when all files are filtered', async () => {
    const octo = makeOctokit([{ filename: 'package-lock.json', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '…' }]);
    const llm = vi.fn();
    const res = await runReview(cfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
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
    const res = await runReview(cfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
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
    // Budget fits one 26-char patch per chunk but not two -> 2 chunks, no drops.
    const smallCfg = { ...cfg, maxPatchChars: 30 };
    const res = await runReview(smallCfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
    expect(res.commentCount).toBe(2);
    expect(llm).toHaveBeenCalledTimes(2);
    const payload = (octo.rest.pulls.createReview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.comments).toHaveLength(2);
  });

  it('treats a malformed findings field as no findings rather than crashing', async () => {
    const octo = makeOctokit([file('src/a.ts')]);
    const llm = vi.fn(async () => ({ findings: 'oops' }));
    const res = await runReview(cfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
    expect(res.commentCount).toBe(0);
    expect(octo.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [] })
    );
  });

  it('forwards cfg.maxPatchChars to the per-file patch cap', async () => {
    // Patch between the filter default per-file cap (20k) and cfg.maxPatchChars:
    // must be kept because the config budget governs, not the hardcoded default.
    const bigPatch = `@@ -1,1000 +1,1000 @@\n${Array.from({ length: 1000 }, () => '+xxxxxxxxxxxxxxxxxxxxxxxxx').join('\n')}\n`; // ~27k chars > 20k default per-file cap
    const octo = makeOctokit([file('src/big.ts', bigPatch)]);
    const llm = vi.fn(async () => ({ findings: [] }));
    const bigCfg = { ...cfg, maxPatchChars: 100000 };
    const res = await runReview(bigCfg, ctx, prInfo, repoInfo, { octokit: octo, llm });
    expect(llm).toHaveBeenCalled();
    expect(res.filesReviewed).toBe(1);
  });
});
