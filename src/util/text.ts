/**
 * Small text helpers for diagnostics.
 */

/** One-line, newline-escaped, truncated view of arbitrary text for logs. */
export function excerpt(text: string, max = 600): string {
  const truncated =
    text.length > max ? `${text.slice(0, max)}…(+${text.length - max} more chars)` : text;
  return JSON.stringify(truncated);
}
