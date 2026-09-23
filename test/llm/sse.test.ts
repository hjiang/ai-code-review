import { describe, expect, it, vi } from 'vitest';
import { parseSSE } from '../../src/llm/sse.js';

/** Collect all events from a byte stream split into the given text chunks. */
async function collect(chunks: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  const events: { event: string; data: string }[] = [];
  for await (const ev of parseSSE(body)) events.push(ev);
  return events;
}

describe('parseSSE', () => {
  it('parses anonymous data events', async () => {
    expect(await collect(['data: {"a":1}\n\n'])).toEqual([{ event: '', data: '{"a":1}' }]);
  });

  it('parses named events', async () => {
    expect(await collect(['event: message_start\ndata: {"x":2}\n\n'])).toEqual([
      { event: 'message_start', data: '{"x":2}' }
    ]);
  });

  it('joins multiple data lines with newlines', async () => {
    expect(await collect(['data: line1\ndata: line2\n\n'])).toEqual([
      { event: '', data: 'line1\nline2' }
    ]);
  });

  it('handles CRLF line endings', async () => {
    expect(await collect(['event: ping\r\ndata: {"y":3}\r\n\r\n'])).toEqual([
      { event: 'ping', data: '{"y":3}' }
    ]);
  });

  it('ignores comment lines (keep-alive pings)', async () => {
    expect(await collect([': keep-alive\n\ndata: {"z":4}\n\n'])).toEqual([
      { event: '', data: '{"z":4}' }
    ]);
  });

  it('reassembles events split across stream chunks', async () => {
    const events = await collect(['data: {"par', 'tial":tr', 'ue}\n\n']);
    expect(events).toEqual([{ event: '', data: '{"partial":true}' }]);
  });

  it('flushes a final event lacking a trailing blank line', async () => {
    expect(await collect(['data: {"last":1}\n'])).toEqual([{ event: '', data: '{"last":1}' }]);
  });

  it('yields named events with empty data (e.g. anthropic ping)', async () => {
    expect(await collect(['event: ping\n\n'])).toEqual([{ event: 'ping', data: '' }]);
  });

  it('treats [DONE] as ordinary data (provider-agnostic parser)', async () => {
    expect(await collect(['data: [DONE]\n\n'])).toEqual([{ event: '', data: '[DONE]' }]);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect([])).toEqual([]);
  });

  it('rejects with StreamStalledError when no bytes arrive within the idle budget', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ start() {} }); // never yields, never closes
    const done = collect2(parseSSE(body, 1000));
    // Attach before advancing so the rejection is handled synchronously.
    const assertion = expect(done).rejects.toThrow(/stalled.*1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it('idle timer resets on every received chunk (slow but flowing stream survives)', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let push: (chunk: Uint8Array) => void = () => {};
    let close: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        close = () => controller.close();
      }
    });
    const done = collect2(parseSSE(body, 1000));
    await vi.advanceTimersByTimeAsync(900);
    push(encoder.encode('data: one\n\n'));
    await vi.advanceTimersByTimeAsync(900);
    push(encoder.encode('data: two\n\n'));
    await vi.advanceTimersByTimeAsync(900);
    push(encoder.encode('data: three\n'));
    close();
    const events = await done;
    expect(events.map((e) => e.data)).toEqual(['one', 'two', 'three']);
    vi.useRealTimers();
  });
});

/** Drain parseSSE events, capturing rejection for assertions. */
async function collect2(gen: AsyncGenerator<{ event: string; data: string }>) {
  const events: { event: string; data: string }[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}
