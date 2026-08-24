import { describe, expect, it } from 'vitest';
import { matchesGlob } from '../src/util/glob.js';

describe('matchesGlob', () => {
  it('matches exact patterns', () => {
    expect(matchesGlob('Cargo.lock', 'Cargo.lock')).toBe(true);
    expect(matchesGlob('Cargo.lock', 'sub/Cargo.lock')).toBe(false);
  });

  it('* matches within a single path segment', () => {
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
  });

  it('? matches a single char within a segment', () => {
    expect(matchesGlob('src/?oo.ts', 'src/foo.ts')).toBe(true);
    expect(matchesGlob('src/?oo.ts', 'src/fooo.ts')).toBe(false);
  });

  it('** matches across directories', () => {
    expect(matchesGlob('src/**.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/**.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matchesGlob('src/**.ts', 'other/a.ts')).toBe(false);
  });

  it('**/ matches zero or more leading directories', () => {
    expect(matchesGlob('**/*.lock', 'yarn.lock')).toBe(true);
    expect(matchesGlob('**/*.lock', 'a/b/yarn.lock')).toBe(true);
    expect(matchesGlob('**/*.lock', 'a/b/notes.txt')).toBe(false);
  });

  it('**/vendor/** matches vendored files at any depth', () => {
    expect(matchesGlob('**/vendor/**', 'vendor/x.js')).toBe(true);
    expect(matchesGlob('**/vendor/**', 'a/vendor/x/y.js')).toBe(true);
    expect(matchesGlob('**/vendor/**', 'src/main.js')).toBe(false);
  });

  it('matches dotted-suffix globs like *.min.*', () => {
    expect(matchesGlob('**/*.min.*', 'jquery.min.js')).toBe(true);
    expect(matchesGlob('**/*.min.*', 'a/b/app.min.css')).toBe(true);
    expect(matchesGlob('**/*.min.*', 'a/b/app.css')).toBe(false);
  });

  it('dist/** matches everything under dist', () => {
    expect(matchesGlob('dist/**', 'dist/bundle.js')).toBe(true);
    expect(matchesGlob('dist/**', 'dist/a/b.js')).toBe(true);
    expect(matchesGlob('dist/**', 'src/bundle.js')).toBe(false);
  });
});
