/**
 * Small text helpers for diagnostics and semantic comparison.
 */

/** One-line, newline-escaped, truncated view of arbitrary text for logs. */
export function excerpt(text: string, max = 600): string {
  const truncated =
    text.length > max ? `${text.slice(0, max)}…(+${text.length - max} more chars)` : text;
  return JSON.stringify(truncated);
}

/** Common English function words that carry no topical signal. */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself',
  'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just',
  'like', 'may', 'me', 'might', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of',
  'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself',
  'yourselves', 'make', 'makes', 'made', 'use', 'uses', 'using', 'used', 'add', 'adds',
  'added', 'need', 'needs', 'ensure', 'instead'
]);

/**
 * Normalize review-comment text into a set of topical tokens: strip severity
 * emoji and markdown decoration, lowercase, drop stopwords and single chars.
 * Used to detect when a new finding repeats a previously reported comment.
 */
export function normalizeTokens(text: string): Set<string> {
  const stripped = text
    .replace(/[🔴🟠🔵]/g, ' ')
    .replace(/[*_`#>]/g, ' ')
    .replace(/\[\]|\(.*?\)/g, ' ')
    .toLowerCase();
  const tokens = new Set<string>();
  for (const m of stripped.match(/[a-z0-9]+/g) ?? []) {
    if (m.length > 1 && !STOPWORDS.has(m)) tokens.add(m);
  }
  return tokens;
}

/**
 * Fraction of the smaller token set that is contained in the larger set.
 * 1 when one comment is a subset of the other, 0 when they are disjoint.
 */
export function tokenContainment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  let shared = 0;
  for (const t of smaller) if (larger.has(t)) shared++;
  return shared / smaller.size;
}
