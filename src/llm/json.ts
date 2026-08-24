/**
 * Strict JSON extraction from a provider reply.
 *
 * Handles fenced ```json blocks and prose wrapped around a JSON payload.
 * Throws an Error (surfaced by `callLLM` as a re-ask) when no valid JSON can
 * be located.
 */

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start === -1 || end <= start) {
    throw new Error('no JSON object or array found in reply');
  }
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`malformed JSON in reply: ${(e as Error).message}`);
  }
}
