/**
 * Minimal glob matcher supporting `*`, `**` and `?`.
 *
 * - `*` matches any characters within a single path segment (no `/`).
 * - `**` matches across path segments; when followed by `/` it matches zero or
 *   more leading directories.
 * - `?` matches exactly one character within a segment.
 * Patterns are anchored: the whole path must match.
 */

function escapeRegExp(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate a glob pattern into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` matches zero or more directories
          i += 2;
        } else {
          re += '.*'; // bare `**`
          i += 1;
        }
      } else {
        re += '[^/]*'; // single-segment `*`
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Return true when `path` matches `pattern`. */
export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}
