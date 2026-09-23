/**
 * Minimal provider-agnostic SSE (server-sent events) parser.
 *
 * Contract:
 * - Pre: `body` is a `ReadableStream<Uint8Array>` of an SSE payload (UTF-8).
 * - Post: yields one `{event, data}` per complete event block. `event` is the
 *   named event or `''` when the block has no `event:` line; `data` is the
 *   concatenation of the block's `data:` lines joined with `\n` (`''` when
 *   the block has none, e.g. an Anthropic `ping`). Comment lines (leading
 *   `:`) are dropped. A final event without a trailing blank line is flushed
 *   when the stream closes.
 * - Provider-agnostic: no `[DONE]` or event-name special casing here.
 *
 * Caveat: consume the iterator to completion or break at a yield point.
 * Abandoning it (`gen.return()`) while a read is pending can surface a
 * `StreamStalledError` as a process-level uncaught exception instead of a
 * rejection. Current adapters only exit at yield points, so this is latent.
 */

export interface SSEEvent {
  /** Named event type, or `''` for anonymous (OpenAI-style) data blocks. */
  event: string;
  /** `data:` payload lines joined with `\n`; `''` when absent. */
  data: string;
}

/**
 * Abort if no bytes arrive for this long, so an uncapped request cannot hang
 * forever on a silently stalled stream. Generous enough to never fire on a
 * healthy reasoning stream (thinking deltas stream during reasoning).
 */
export const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Error thrown when the stream stalls (no bytes for `idleTimeoutMs`). */
export class StreamStalledError extends Error {
  constructor(idleMs: number) {
    super(`llm stream stalled: no bytes for ${idleMs}ms`);
    this.name = 'StreamStalledError';
  }
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS
): AsyncGenerator<SSEEvent, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let event = '';
  let dataLines: string[] = [];

  const flush = function* (): Generator<SSEEvent> {
    if (event === '' && dataLines.length === 0) return; // blank separator, not an event
    yield { event, data: dataLines.join('\n') };
    event = '';
    dataLines = [];
  };

  /** One read, racing the idle timer; a stall cancels the stream. */
  const read = () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        if (idleTimeoutMs > 0) {
          timer = setTimeout(() => {
            // Reject FIRST: cancelling first would resolve the pending read
            // with {done:true}, settling the race as a normal EOF instead of
            // a stall. Connection cleanup happens in the finally below.
            reject(new StreamStalledError(idleTimeoutMs));
            reader.cancel().catch(() => {});
          }, idleTimeoutMs);
        }
      })
    ]).finally(() => clearTimeout(timer));
  };

  try {
    for (;;) {
      const { done, value } = await read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          yield* flush();
        } else if (line.startsWith(':')) {
          // comment / keep-alive; ignore
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
        }
        // Unknown field names (e.g. `id:`, `retry:`) are ignored per SSE spec.
      }
    }
    buffer += decoder.decode(); // flush multi-byte sequence split across chunks
    if (buffer !== '') {
      // EOF without trailing newline: treat the remainder as a final line.
      if (buffer.startsWith('data:')) {
        dataLines.push(buffer.slice(5).startsWith(' ') ? buffer.slice(6) : buffer.slice(5));
      }
      buffer = '';
    }
    yield* flush();
  } finally {
    reader.cancel().catch(() => {}); // release the connection on early exit
  }
}
