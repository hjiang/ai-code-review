import type { SSEEvent } from '../../src/llm/sse.js';

/**
 * Shared SSE test fixtures. The adapters are streaming-only, so every mocked
 * 200 response is an SSE `text/event-stream` body.
 */

const encoder = new TextEncoder();

/** Serialize events to SSE wire format (`data:` payload may be multi-line). */
export function sseWire(events: SSEEvent[]): string {
  return events
    .map((e) => {
      const dataPart = e.data.split('\n').map((l) => `data: ${l}`).join('\n');
      return e.event ? `event: ${e.event}\n${dataPart}\n\n` : `${dataPart}\n\n`;
    })
    .join('');
}

/** A 200 Response whose body is the given SSE text chunks, in order. */
export function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A 200 SSE Response whose body never yields bytes and never closes. */
export function stalledResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start() {} // never enqueues, never closes
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** OpenAI-style SSE completion carrying `content` (may be empty). */
export function openAiSse(content: string, extraChunks: SSEEvent[] = []): Response {
  const events: SSEEvent[] = [
    { event: '', data: JSON.stringify({ choices: [{ delta: { role: 'assistant', content } }] }) },
    ...extraChunks,
    { event: '', data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
    { event: '', data: '[DONE]' }
  ];
  return sseResponse([sseWire(events)]);
}

/** Anthropic-style SSE completion carrying `content` (may be empty). */
export function anthropicSse(content: string): Response {
  const events: SSEEvent[] = [
    { event: 'message_start', data: '{"type":"message_start","message":{"role":"assistant"}}' },
    { event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}' }
  ];
  if (content) {
    events.push({
      event: 'content_block_delta',
      data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } })
    });
  }
  events.push(
    { event: 'content_block_stop', data: '{"type":"content_block_stop","index":0}' },
    { event: 'message_delta', data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}' },
    { event: 'message_stop', data: '{"type":"message_stop"}' }
  );
  return sseResponse([sseWire(events)]);
}
