import { describe, expect, it } from 'vitest';
import { buildReviewMessages, buildSummaryMessages, SUMMARY_MARKER } from '../src/prompt.js';
import type { PrFile } from '../src/diff.js';

function file(filename: string, patch = '@@ -1,2 +1,2 @@\n keep\n+added\n'): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, changes: 1, patch };
}

describe('SUMMARY_MARKER', () => {
  it('is the hidden HTML marker', () => {
    expect(SUMMARY_MARKER).toBe('<!-- ai-review:summary -->');
  });
});

describe('buildSummaryMessages', () => {
  const pr = { title: 'Add login flow', body: 'Implements OAuth login.\n\nCloses #12.' };
  const files = [file('src/auth.ts'), file('src/login.ts', '@@ -1 +1 @@\n+new\n')];

  it('returns a system + user pair', () => {
    const msgs = buildSummaryMessages(pr, files, 100000);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('includes the summary_md JSON schema in the system prompt', () => {
    const [system] = buildSummaryMessages(pr, files, 100000);
    expect(system.content).toContain('summary_md');
  });

  it('includes PR metadata and the changed-file list in the user message', () => {
    const [, user] = buildSummaryMessages(pr, files, 100000);
    expect(user.content).toContain('Add login flow');
    expect(user.content).toContain('Implements OAuth login');
    expect(user.content).toContain('src/auth.ts');
    expect(user.content).toContain('src/login.ts');
  });

  it('includes the diff patches in the user message', () => {
    const [, user] = buildSummaryMessages(pr, files, 100000);
    expect(user.content).toContain('+added');
    expect(user.content).toContain('+new');
  });

  it('respects the max patch-char budget with a truncation marker', () => {
    const [, user] = buildSummaryMessages(pr, files, 120);
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
    const msgs = buildReviewMessages(files, 100000);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('documents the findings schema and severity enum in the system prompt', () => {
    const [system] = buildReviewMessages(files, 100000);
    expect(system.content).toContain('findings');
    expect(system.content).toContain('critical');
    expect(system.content).toContain('warning');
    expect(system.content).toContain('suggestion');
    expect(system.content).toContain('"path"');
    expect(system.content).toContain('"line"');
  });

  it('includes a few-shot example finding', () => {
    const [system] = buildReviewMessages(files, 100000);
    expect(system.content.toLowerCase()).toContain('example');
  });

  it('tells the model to cite NEW-side line numbers', () => {
    const [system] = buildReviewMessages(files, 100000);
    expect(system.content).toMatch(/new side/i);
  });

  it('puts the file list and patches in the user message', () => {
    const [, user] = buildReviewMessages(files, 100000);
    expect(user.content).toContain('src/auth.ts');
    expect(user.content).toContain('getToken(req)');
  });

  it('respects the max patch-char budget with a truncation marker', () => {
    const [, user] = buildReviewMessages(files, 80);
    const diffIdx = user.content.indexOf('Diffs:');
    expect(user.content.length - diffIdx).toBeLessThanOrEqual(80 + 200);
    expect(user.content).toMatch(/truncated/i);
  });
});
