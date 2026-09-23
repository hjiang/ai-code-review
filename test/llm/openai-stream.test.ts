import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiChat } from '../../src/llm/openai.js';
import { callLLM } from '../../src/llm/client.js';
import { EmptyCompletionError, LLMError } from '../../src/llm/types.js';
import type { LLMConfig } from '../../src/llm/types.js';
import { STREAM_IDLE_TIMEOUT_MS } from '../../src/llm/sse.js';
import type { SSEEvent } from '../../src/llm/sse.js';
import { openAiSse, sseResponse, sseWire, stalledResponse } from './sse-helpers.js';

const baseCfg: LLMConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  maxTokens: 8192,
  temperature: 0.2,
  jsonMode: 'auto'
};

const msgs = [{ role: 'user' as const, content: 'hi' }];

function jsonBody(init?: RequestInit): Record<string, unknown> {
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

function resp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('openaiChat — SSE streaming', () => {
  it('accumulates delta.content across many raw byte chunks and posts stream:true', async () => {
    const events: SSEEvent[] = [
      { event: '', data: JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }) },
      { event: '', data: JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }) },
      { event: '', data: JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) },
      { event: '', data: JSON.stringify({ choices: [{ delta: { content: 'lo, ' } }] }) },
      { event: '', data: JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) },
      { event: '', data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
      { event: '', data: '[DONE]' }
    ];
    const wire = sseWire(events);
    // Cut the SSE text into 9-byte fragments so line/JSON boundaries never
    // align with chunk boundaries — proving cross-chunk reassembly upstream.
    const chunks = wire.match(/[\s\S]{1,9}/g) ?? [];
    expect(chunks.length).toBeGreaterThan(20);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(chunks));
    vi.stubGlobal('fetch', fetchMock);

    const text = await openaiChat(baseCfg, msgs, 'auto', 1000);

    expect(text).toBe('Hello, world'); // reasoning_content never leaks into the output
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = jsonBody(init);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toBeUndefined(); // minimize the 400-rejection surface
    expect(init.signal).toBeInstanceOf(AbortSignal); // finite budget → hard deadline present
  });

  it('stops reading at the [DONE] sentinel', async () => {
    // Events after [DONE] must never be parsed or accumulated.
    const events: SSEEvent[] = [
      { event: '', data: JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) },
      { event: '', data: '[DONE]' },
      { event: '', data: JSON.stringify({ choices: [{ delta: { content: 'IGNORED' } }] }) }
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([sseWire(events)])));
    await expect(openaiChat(baseCfg, msgs, 'off', 1000)).resolves.toBe('ok');
  });

  it('throws EmptyCompletionError with stream diagnostics on empty content', async () => {
    const logs: string[] = [];
    // Budget-burn signature: reasoning deltas streamed, no text content,
    // finish_reason=length.
    const burn: SSEEvent[] = [
      { event: '', data: JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) },
      { event: '', data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) }
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAiSse('', burn)));
    await expect(
      openaiChat({ ...baseCfg, log: (m) => logs.push(m) }, msgs, 'auto', 1000)
    ).rejects.toBeInstanceOf(EmptyCompletionError);
    expect(logs[0]).toMatch(/openai extraction failed .*empty completion/);
    expect(logs[0]).toContain('finish_reason=length');
    expect(logs[0]).toContain('reasoning_content=yes');

    // Plain empty stream: no reasoning, the provider's normal stop terminator.
    logs.length = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAiSse('')));
    await expect(
      openaiChat({ ...baseCfg, log: (m) => logs.push(m) }, msgs, 'auto', 1000)
    ).rejects.toBeInstanceOf(EmptyCompletionError);
    expect(logs[0]).toContain('finish_reason=stop');
    expect(logs[0]).toContain('reasoning_content=no');
  });

  it('throws EmptyCompletionError for a reasoning-only stream', async () => {
    const logs: string[] = [];
    const events: SSEEvent[] = [
      { event: '', data: JSON.stringify({ choices: [{ delta: { reasoning_content: 'let me think' } }] }) },
      { event: '', data: JSON.stringify({ choices: [{ delta: { reasoning_content: ' more' } }] }) },
      { event: '', data: '[DONE]' }
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([sseWire(events)])));
    await expect(
      openaiChat({ ...baseCfg, log: (m) => logs.push(m) }, msgs, 'off', 0)
    ).rejects.toBeInstanceOf(EmptyCompletionError);
    expect(logs[0]).toContain('reasoning_content=yes');
    expect(logs[0]).toContain('finish_reason=none');
  });

  it('surfaces a stalled stream as retryable: 3 attempts, then LLMError', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => stalledResponse());
    vi.stubGlobal('fetch', fetchMock);
    const cfg: LLMConfig = { ...baseCfg, timeoutMs: 0 }; // uncapped: stall detector is the only guard

    // Attach the rejection handler BEFORE advancing timers (unhandled-rejection noise).
    const pending = callLLM(cfg, msgs).catch((e: unknown) => e);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS); // one idle-stall per attempt
      await vi.advanceTimersByTimeAsync(40_000); // covers the largest backoff sleep
    }
    const err = (await pending) as Error;
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_HTTP_ATTEMPTS
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toMatch(/LLM request failed: StreamStalledError/);
  });

  it('clamps the hard abort deadline to 2**31-1 and omits it when uncapped', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockImplementation(() => openAiSse('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await openaiChat(baseCfg, msgs, 'off', 2 ** 40);
    expect(timeoutSpy).toHaveBeenCalledWith(2 ** 31 - 1);

    await openaiChat(baseCfg, msgs, 'off', 0);
    expect(timeoutSpy).toHaveBeenCalledTimes(1); // uncapped: no abort signal at all
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBeUndefined();
  });

  it('keeps stream:true and recomputes the body when retrying without response_format', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(400, { error: { message: 'response_format is not supported' } }))
      .mockResolvedValueOnce(openAiSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(openaiChat(baseCfg, msgs, 'auto', 1000)).resolves.toBe('{"ok":1}');
    const first = jsonBody(fetchMock.mock.calls[0][1]);
    expect(first.stream).toBe(true);
    expect(first.response_format).toEqual({ type: 'json_object' });
    const retry = jsonBody(fetchMock.mock.calls[1][1]);
    expect(retry.stream).toBe(true);
    expect(retry.response_format).toBeUndefined();
    expect(retry.messages).toEqual(msgs);
  });

  it('keeps stream:true when retrying without extra_body; a user stream key wins', async () => {
    const cfg: LLMConfig = {
      ...baseCfg,
      extraBody: { thinking: { type: 'disabled' } },
      log: () => {}
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(400, { error: { message: 'unknown param thinking' } }))
      .mockResolvedValueOnce(openAiSse('done'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(openaiChat(cfg, msgs, 'auto', 1000)).resolves.toBe('done');
    const retry = jsonBody(fetchMock.mock.calls[1][1]);
    expect(retry.stream).toBe(true);
    expect(retry.thinking).toBeUndefined();

    // extraBody is merged after `stream`, so a user-supplied stream:false wins.
    const fetch2 = vi.fn().mockResolvedValue(openAiSse('x'));
    vi.stubGlobal('fetch', fetch2);
    await openaiChat({ ...baseCfg, extraBody: { stream: false } }, msgs, 'off', 1000);
    expect(jsonBody(fetch2.mock.calls[0][1]).stream).toBe(false);
  });
});
