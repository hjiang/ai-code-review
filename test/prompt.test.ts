import { describe, expect, it } from 'vitest';
import {
  buildRepoContext,
  buildReviewMessages,
  buildSummaryMessages,
  SUMMARY_MARKER
} from '../src/prompt.js';
import type { PrFile } from '../src/diff.js';
import type { RepoInfo } from '../src/github/reviews.js';

const repo: RepoInfo = {
  fullName: 'acme/widgets',
  visibility: 'private',
  description: 'Widget catalog API',
  defaultBranch: 'main',
  language: 'TypeScript',
  isFork: false,
  isArchived: false
};

function file(filename: string, patch = '@@ -1,2 +1,2 @@\n keep\n+added\n'): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, changes: 1, patch };
}

describe('SUMMARY_MARKER', () => {
  it('is the hidden HTML marker', () => {
    expect(SUMMARY_MARKER).toBe('<!-- ai-review:summary -->');
  });
});

describe('buildRepoContext', () => {
  it('renders one fact per line including visibility', () => {
    const ctx = buildRepoContext(repo);
    expect(ctx).toContain('repo: acme/widgets');
    expect(ctx).toContain('visibility: private');
    expect(ctx).toContain('description: Widget catalog API');
    expect(ctx).toContain('default branch: main');
    expect(ctx).toContain('primary language: TypeScript');
    expect(ctx).toContain('fork: no');
  });

  it('omits an empty description and marks unknown fields', () => {
    const ctx = buildRepoContext({
      fullName: 'a/b',
      visibility: 'public',
      description: '',
      defaultBranch: '',
      language: null,
      isFork: true,
      isArchived: true
    });
    expect(ctx).not.toContain('description:');
    expect(ctx).toContain('default branch: (unknown)');
    expect(ctx).toContain('primary language: (unknown)');
    expect(ctx).toContain('fork: yes');
    expect(ctx).toContain('archived: yes');
  });
});

describe('buildSummaryMessages', () => {
  const pr = { title: 'Add login flow', body: 'Implements OAuth login.\n\nCloses #12.' };
  const files = [file('src/auth.ts'), file('src/login.ts', '@@ -1 +1 @@\n+new\n')];

  it('returns a system + user pair', () => {
    const msgs = buildSummaryMessages(pr, files, 100000, repo);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('includes the summary_md JSON schema in the system prompt', () => {
    const [system] = buildSummaryMessages(pr, files, 100000, repo);
    expect(system.content).toContain('summary_md');
  });

  it('includes PR metadata and the changed-file list in the user message', () => {
    const [, user] = buildSummaryMessages(pr, files, 100000, repo);
    expect(user.content).toContain('Add login flow');
    expect(user.content).toContain('Implements OAuth login');
    expect(user.content).toContain('src/auth.ts');
    expect(user.content).toContain('src/login.ts');
  });

  it('includes the repo context (visibility) in the user message', () => {
    const [, user] = buildSummaryMessages(pr, files, 100000, repo);
    expect(user.content).toContain('Repository context:');
    expect(user.content).toContain('visibility: private');
    expect(user.content).toContain('acme/widgets');
  });

  it('includes the diff patches in the user message', () => {
    const [, user] = buildSummaryMessages(pr, files, 100000, repo);
    expect(user.content).toContain('+added');
    expect(user.content).toContain('+new');
  });

  it('respects the max patch-char budget with a truncation marker', () => {
    const [, user] = buildSummaryMessages(pr, files, 120, repo);
    expect(user.content.length).toBeLessThanOrEqual(500); // header slack, not the full budget
    expect(user.content).toMatch(/truncated/i);
    // the budget applies to the diff section; header/metadata may exceed it
    const diffIdx = user.content.indexOf('Diffs:');
    expect(user.content.length - diffIdx).toBeLessThanOrEqual(120 + 200);
  });
});

describe('buildReviewMessages', () => {
  const files = [file('src/auth.ts', '@@ -1 +1 @@\n+const t = getToken(req);\n')];

  it('returns a system + user pair', () => {
    const msgs = buildReviewMessages(files, 100000, repo);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('documents the findings schema and severity enum in the system prompt', () => {
    const [system] = buildReviewMessages(files, 100000, repo);
    expect(system.content).toContain('findings');
    expect(system.content).toContain('critical');
    expect(system.content).toContain('warning');
    expect(system.content).toContain('suggestion');
    expect(system.content).toContain('"path"');
    expect(system.content).toContain('"line"');
  });

  it('includes a few-shot example finding', () => {
    const [system] = buildReviewMessages(files, 100000, repo);
    expect(system.content.toLowerCase()).toContain('example');
  });

  it('tells the model to cite NEW-side line numbers', () => {
    const [system] = buildReviewMessages(files, 100000, repo);
    expect(system.content).toMatch(/new side/i);
  });

  it('puts the file list and patches in the user message', () => {
    const [, user] = buildReviewMessages(files, 100000, repo);
    expect(user.content).toContain('src/auth.ts');
    expect(user.content).toContain('getToken(req)');
  });

  it('prepends the repo context to the review user message', () => {
    const [, user] = buildReviewMessages(files, 100000, repo);
    expect(user.content.startsWith('Repository context:')).toBe(true);
    expect(user.content).toContain('visibility: private');
  });

  it('respects the max patch-char budget with a truncation marker', () => {
    const [, user] = buildReviewMessages(files, 80, repo);
    const diffIdx = user.content.indexOf('Diffs:');
    expect(user.content.length - diffIdx).toBeLessThanOrEqual(80 + 200);
    expect(user.content).toMatch(/truncated/i);
  });

  it('omits the previously-reported block when there are no previous comments', () => {
    const [, user] = buildReviewMessages(files, 100000, repo);
    expect(user.content).not.toContain('Previously reported');
  });

  it('includes a compact block of previously reported comments', () => {
    const previous = [
      { path: 'src/auth.ts', line: 12, body: 'SQL built by string concatenation is injectable.' }
    ];
    const [, user] = buildReviewMessages(files, 100000, repo, previous);
    expect(user.content).toContain('Previously reported');
    expect(user.content).toContain('src/auth.ts:12');
    expect(user.content).toContain('SQL built by string concatenation');
  });

  it('reserves budget for the previously-reported block', () => {
    // A large previous block must shrink the file/diff section so the block
    // and the diff do not exceed the prompt budget.
    const bigPrevious = Array.from({ length: 30 }, (_, i) => ({
      path: 'src/auth.ts',
      line: 12 + i,
      body: 'x'.repeat(120)
    }));
    const [, user] = buildReviewMessages(files, 300, repo, bigPrevious);
    const diffIdx = user.content.indexOf('Diffs:');
    const prevIdx = user.content.indexOf('Previously reported');
    expect(diffIdx).toBeGreaterThan(-1);
    expect(prevIdx).toBeGreaterThan(-1);
    // The diff section (from 'Diffs:' to the previous block) must be capped
    // down to the leftover budget, not carry the full diff.
    expect(user.content).toContain('truncated');
    expect(prevIdx - diffIdx).toBeLessThan(300);
  });

  it('escapes user-authored bodies as single-line JSON strings', () => {
    const previous = [
      { path: 'src/auth.ts', line: 12, body: 'Multi\nline with "quotes" and *markdown*' }
    ];
    const [, user] = buildReviewMessages(files, 100000, repo, previous);
    // Both the location and the body must be collapsed and JSON-quoted so they
    // cannot break the bullet block or inject prompt instructions.
    expect(user.content).toContain('"src/auth.ts:12" — "Multi line with \\"quotes\\" and *markdown*"');
    expect(user.content).not.toMatch(/Multi\s*\n/);
  });

  it('JSON-quotes the location so a crafted filename cannot inject markdown', () => {
    const previous = [
      { path: 'src/`evil`*.ts', line: 12, body: 'body' }
    ];
    const [, user] = buildReviewMessages(files, 100000, repo, previous);
    // The raw backticks/asterisks must be neutralized inside a JSON string
    // literal ("..."), not injected as raw markdown.
    expect(user.content).toContain('"src/`evil`*.ts:12" — "body"');
  });

  it('caps the previously-reported block at a bounded number of entries', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: 1,
      body: `issue number ${i}`
    }));
    const [, user] = buildReviewMessages(files, 100000, repo, many);
    const matches = user.content.match(/src\/f\d+\.ts:1/g) ?? [];
    expect(matches.length).toBeLessThan(200);
  });
});
