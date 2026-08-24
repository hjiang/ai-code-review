import { describe, expect, it } from 'vitest';
import { parsePatch, validAnchors } from '../src/diff.js';

describe('parsePatch', () => {
  it('parses a simple single-hunk patch with add/del/ctx', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2 changed',
      '+line3 added',
      ' line4',
      ''
    ].join('\n');
    const hunks = parsePatch(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].lines).toEqual([
      { type: 'ctx', oldLine: 1, newLine: 1, text: 'line1' },
      { type: 'del', oldLine: 2, text: 'line2' },
      { type: 'add', newLine: 2, text: 'line2 changed' },
      { type: 'add', newLine: 3, text: 'line3 added' },
      { type: 'ctx', oldLine: 3, newLine: 4, text: 'line4' }
    ]);
  });

  it('parses multiple hunks with newStart resetting per hunk', () => {
    const patch = [
      '@@ -5,2 +10,2 @@',
      ' ctxA',
      '+addedB',
      '@@ -20,1 +30,1 @@',
      ' ctxC',
      ''
    ].join('\n');
    const hunks = parsePatch(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].newStart).toBe(10);
    expect(hunks[0].lines).toEqual([
      { type: 'ctx', oldLine: 5, newLine: 10, text: 'ctxA' },
      { type: 'add', newLine: 11, text: 'addedB' }
    ]);
    expect(hunks[1].newStart).toBe(30);
    expect(hunks[1].lines).toEqual([
      { type: 'ctx', oldLine: 20, newLine: 30, text: 'ctxC' }
    ]);
  });

  it('parses hunk headers without counts', () => {
    const patch = '@@ -1 +1 @@\n+newline only\n';
    const hunks = parsePatch(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].lines).toEqual([{ type: 'add', newLine: 1, text: 'newline only' }]);
  });

  it('returns an empty array for empty or header-only patches', () => {
    expect(parsePatch('')).toEqual([]);
    expect(parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n')).toEqual([]);
  });

  it('handles patches without a trailing newline', () => {
    const hunks = parsePatch('@@ -1 +1 @@\n+hello');
    expect(hunks[0].lines).toEqual([{ type: 'add', newLine: 1, text: 'hello' }]);
  });

  it('only the first char decides line type (++ / -- content)', () => {
    const patch = '@@ -1,3 +1,3 @@\n+++weird\n--worse\n +plain\n';
    const hunks = parsePatch(patch);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, text: '++weird' },
      { type: 'del', oldLine: 1, text: '-worse' },
      { type: 'ctx', oldLine: 2, newLine: 2, text: '+plain' }
    ]);
  });

  it('ignores "no newline at end of file" markers', () => {
    const patch = '@@ -1 +1 @@\n+hello\n\\ No newline at end of file\n';
    const hunks = parsePatch(patch);
    expect(hunks[0].lines).toEqual([{ type: 'add', newLine: 1, text: 'hello' }]);
  });
});

describe('validAnchors', () => {
  it('collects all RIGHT-side (add + ctx) line numbers', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2 changed',
      '+line3 added',
      ' line4',
      ''
    ].join('\n');
    expect([...validAnchors(patch)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('is empty for empty patches', () => {
    expect(validAnchors('').size).toBe(0);
  });

  it('does not include deleted-line numbers', () => {
    const patch = '@@ -1,2 +1,1 @@\n-del1\n-del2\n+new\n';
    expect([...validAnchors(patch)]).toEqual([1]);
  });
});
