import { describe, expect, it } from 'vitest';
import { chunkFiles, filterFiles } from '../src/filter.js';
import type { PrFile } from '../src/diff.js';

function file(filename: string, over: Partial<PrFile> = {}): PrFile {
  return {
    filename,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1 +1 @@\n+hello\n',
    ...over
  };
}

const patchOfLen = (n: number): string => `@@ -1 +1 @@\n+${'x'.repeat(Math.max(0, n - 16))}\n`;

describe('filterFiles', () => {
  it('keeps normal modified files', () => {
    const res = filterFiles([file('src/a.ts')], { mode: 'review' });
    expect(res.kept).toHaveLength(1);
    expect(res.skipped).toHaveLength(0);
  });

  it('skips removed files in review mode but keeps them in summary mode', () => {
    const removed = file('src/gone.ts', { status: 'removed' });
    expect(filterFiles([removed], { mode: 'review' }).kept).toHaveLength(0);
    expect(filterFiles([removed], { mode: 'review' }).skipped[0].reason).toMatch(/removed/i);
    expect(filterFiles([removed], { mode: 'summary' }).kept).toHaveLength(1);
  });

  it('skips files with no patch (binary / too large)', () => {
    const binary = file('img/logo.png', { patch: null });
    const res = filterFiles([binary], { mode: 'review' });
    expect(res.kept).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/patch/i);
  });

  it('applies built-in excludes (lockfiles, dist, vendor, minified, snapshots)', () => {
    const files = [
      file('package-lock.json'),
      file('yarn.lock'),
      file('dist/bundle.js'),
      file('vendor/x.js'),
      file('jquery.min.js'),
      file('go.sum'),
      file('Cargo.lock'),
      file('poetry.lock'),
      file('a/snapshot.snap'),
      file('src/real.ts')
    ];
    const res = filterFiles(files, { mode: 'review' });
    expect(res.kept.map((f) => f.filename)).toEqual(['src/real.ts']);
    expect(res.skipped).toHaveLength(9);
  });

  it('applies user-provided exclude patterns', () => {
    const res = filterFiles([file('docs/readme.md'), file('src/a.ts')], {
      mode: 'review',
      exclude: ['**/*.md']
    });
    expect(res.kept.map((f) => f.filename)).toEqual(['src/a.ts']);
  });

  it('skips files whose patch exceeds the per-file cap', () => {
    const big = file('src/big.ts', { patch: patchOfLen(3000) });
    const res = filterFiles([big], { mode: 'review', maxPatchChars: 2000 });
    expect(res.kept).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/too large/i);
  });

  it('caps the number of kept files', () => {
    const files = [file('a.ts'), file('b.ts'), file('c.ts')];
    const res = filterFiles(files, { mode: 'review', maxFiles: 2 });
    expect(res.kept.map((f) => f.filename)).toEqual(['a.ts', 'b.ts']);
    expect(res.skipped.some((s) => /limit/i.test(s.reason))).toBe(true);
  });

  it('keeps zero files when maxFiles is 0', () => {
    const files = [file('a.ts'), file('b.ts')];
    const res = filterFiles(files, { mode: 'review', maxFiles: 0 });
    expect(res.kept).toHaveLength(0);
    expect(res.skipped.length).toBe(files.length);
    expect(res.skipped.every((s) => /limit/i.test(s.reason))).toBe(true);
  });

  it('does not over-attribute skip reasons when duplicate file objects appear', () => {
    const dup = file('src/dup.ts');
    const res = filterFiles([dup, dup], { mode: 'review', maxFiles: 1 });
    expect(res.kept).toHaveLength(1);
    expect(res.skipped.some((s) => /limit/i.test(s.reason))).toBe(true);
  });
});

describe('chunkFiles', () => {
  it('packs files into chunks under the char budget', () => {
    const files = [file('a.ts', { patch: patchOfLen(30) }), file('b.ts', { patch: patchOfLen(30) })];
    const chunks = chunkFiles(files, 50);
    expect(chunks).toHaveLength(2);
  });

  it('keeps a file spanning the boundary whole', () => {
    const files = [file('a.ts', { patch: patchOfLen(30) }), file('b.ts', { patch: patchOfLen(30) })];
    const chunks = chunkFiles(files, 55);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[1]).toHaveLength(1);
  });

  it('groups several small files into one chunk', () => {
    const files = [file('a.ts', { patch: patchOfLen(10) }), file('b.ts', { patch: patchOfLen(10) })];
    const chunks = chunkFiles(files, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it('truncates an oversized single file with a marker', () => {
    const big = file('a.ts', { patch: patchOfLen(200) });
    const chunks = chunkFiles([big], 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0][0].patch!.length).toBeLessThanOrEqual(50);
    expect(chunks[0][0].patch).toMatch(/\[…truncated\]$/);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkFiles([], 100)).toEqual([]);
  });
});
