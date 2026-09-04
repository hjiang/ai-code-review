/**
 * Strict JSON extraction from a provider reply.
 *
 * Handles fenced ```json blocks and prose wrapped around a JSON payload.
 * Throws an Error (surfaced by `callLLM` as a re-ask) when no valid JSON can
 * be located.
 *
 * Candidate order matters: models routinely embed fenced code EXAMPLES
 * (Rust patches, JSON snippets) inside `comment_md` string values, so a
 * fenced block found anywhere in the reply must never win over the outer
 * payload itself. The bare reply is tried first whenever it looks like a
 * JSON document; fenced blocks (and finally the bare reply with
 * bounds-slicing) serve as fallbacks for prose-wrapped replies. Without
 * this ordering, a reply like `{"findings":[{"comment_md":"use
 * ```rust\nif x { y }\n```"}]}` made the fence-first heuristic grab the
 * inner Rust block and fail with "Expected property name or '}' in JSON
 * at position 1" (posta run 33876403722).
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates: string[] = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    candidates.push(trimmed);
  }
  candidates.push(...fenced);
  candidates.push(trimmed);
  let lastError: unknown;
  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start === -1 || end <= start) {
      continue;
    }
    const slice = candidate.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    lastError instanceof Error
      ? `malformed JSON in reply: ${lastError.message}`
      : 'no JSON object or array found in reply',
  );
}
