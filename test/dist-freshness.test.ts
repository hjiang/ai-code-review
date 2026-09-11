import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The GitHub Action executes the committed `dist/index.js` bundle, never
 * `src/`. A `src/` change without `npm run build` therefore ships the OLD
 * behavior to consumers while local tests (which run against `src/`) stay
 * green — exactly what happened in posta PR #45, where the extractJson fix
 * (94a0621) landed in src+tests but the stale bundle kept failing runs with
 * "Expected property name or '}' in JSON at position 1".
 *
 * Guard: distinctive code signatures of the current src must appear in the
 * committed bundle. If this fails, run `npm run build` and commit dist/.
 */
describe('dist freshness', () => {
  const dist = readFileSync(join(__dirname, '..', 'dist', 'index.js'), 'utf8');

  it('contains the compiled current extractJson candidate ordering', () => {
    // Unique to the fixed src/llm/json.ts (94a0621): fenced blocks are
    // candidates AFTER the bare reply, never a fence-first heuristic.
    expect(dist).toContain('candidates.push(...fenced)');
  });

  it('no longer bundles the old fence-first extractJson heuristic', () => {
    // Signature of the pre-94a0621 src/llm/json.ts. If this trips on future
    // legitimate code, update the assertion together with that change — but
    // first make sure dist/ is not simply stale (npm run build).
    expect(dist).not.toContain('.exec(text)');
  });
});
