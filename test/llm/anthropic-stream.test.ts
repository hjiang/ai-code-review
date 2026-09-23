import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicChat } from '../../src/llm/anthropic.js';
import { callLLM } from '../../src/llm/client.js';
import { EmptyCompletionError } from '../../src/llm/types.js';
import type { LLMConfig, LLMMessage } from '../../src/llm/types.js';
import { anthropicSse, sseResponse, sseWire } from './sse-helpers.js';
import type { SSEEvent } from '../../src/llm/sse.js';

const cfg: LLMConfig = {
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-test',
  model: 'claude-test',
  maxTokens: 8192,
  temperature: 0.2
};

const userMsg: LLMMessage[] = [{ role: 'user', content: 'hi' }];

type RequestBody = Record<string, unknown>;

/** Parse a mocked fetch body; shape asserted inline per test via Record access. */
function jsonBody(init?: RequestInit): RequestBody {
  // JSON.parse returns `any`; pin it to a key-unknown record immediately.
  return JSON.parse(String(init?.body)) as RequestBody;
}

function textDelta(text: string, index = 0): SSEEvent {
  return {
    event: 'content_block_delta',
    data: JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
  };
}

function thinkingDelta(thinking: string, index = 0): SSEEvent {
  return {
    event: 'content_block_delta',
    data: JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
  };
}

/** Plain JSON (non-SSE) response, e.g. a gateway ignoring stream:true. */
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

describe('anthropicChat — SSE streaming', () => {
  it('accumulates text_delta events and posts a stream:true anthropic body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await anthropicChat(
      cfg,
      [
        { role: 'system', content: 'You are strict.' },
        { role: 'user', content: 'hi' }
      ],
      0
    );
    expect(result).toBe('{"ok":1}');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-test');
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = jsonBody(init);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-test');
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0.2);
    expect(body.system).toBe('You are strict.');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('user-supplied extraBody keys win over stream:true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await anthropicChat({ ...cfg, extraBody: { stream: false, top_k: 5 } }, userMsg, 0);
    const body = jsonBody(fetchMock.mock.calls[0][1] as RequestInit);
    expect(body.stream).toBe(false); // user explicitly disabled streaming
    expect(body.top_k).toBe(5);
  });

  it('reassembles text across chunk boundaries and multiple deltas', async () => {
    const wire = sseWire([
      { event: 'message_start', data: '{"type":"message_start","message":{"role":"assistant"}}' },
      textDelta('Hello'),
      textDelta(', streaming'),
      textDelta(' world'),
      { event: 'message_stop', data: '{"type":"message_stop"}' }
    ]);
    // Split at awkward offsets so JSON objects straddle chunk boundaries.
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire.slice(0, 40), wire.slice(40, 120), wire.slice(120)]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await anthropicChat(cfg, userMsg, 0);
    expect(result).toBe('Hello, streaming world');
  });

  it('terminates at EOF when the stream ends without message_stop', async () => {
    const wire = sseWire([{ event: 'message_start', data: '{"type":"message_start"}' }, textDelta('trailing')]);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await anthropicChat(cfg, userMsg, 0);
    expect(result).toBe('trailing');
  });

  it('ignores ping events', async () => {
    const wire = sseWire([
      { event: 'ping', data: '{"type":"ping"}' },
      textDelta('pong'),
      { event: 'ping', data: '{"type":"ping"}' },
      { event: 'message_stop', data: '{"type":"message_stop"}' }
    ]);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await anthropicChat(cfg, userMsg, 0);
    expect(result).toBe('pong');
  });

  it('counts only text_delta: thinking_delta never reaches output or empty detection', async () => {
    const wire = sseWire([
      { event: 'message_start', data: '{"type":"message_start"}' },
      { event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}' },
      thinkingDelta('deep thoughts'),
      thinkingDelta('more thoughts'),
      { event: 'content_block_stop', data: '{"type":"content_block_stop","index":0}' },
      { event: 'content_block_start', data: '{"type":"content_block_start","index":1,"content_block":{"type":"text"}}' },
      textDelta('answer', 1),
      { event: 'content_block_stop', data: '{"type":"content_block_stop","index":1}' },
      { event: 'message_stop', data: '{"type":"message_stop"}' }
    ]);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await anthropicChat(cfg, userMsg, 0);
    expect(result).toBe('answer');
  });

  it('thinking-only stream is an empty completion, not the thinking text', async () => {
    const logs: string[] = [];
    const wire = sseWire([
      { event: 'message_start', data: '{"type":"message_start"}' },
      thinkingDelta('deep thoughts'),
      { event: 'message_stop', data: '{"type":"message_stop"}' }
    ]);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(anthropicChat({ ...cfg, log: (m) => logs.push(m) }, userMsg, 0)).rejects.toBeInstanceOf(
      EmptyCompletionError
    );
    expect(logs.some((m) => /anthropic extraction failed \(empty completion\); events=\d+/.test(m))).toBe(true);
  });

  it('empty stream throws EmptyCompletionError with a diagnostic log', async () => {
    const logs: string[] = [];
    const fetchMock = vi.fn().mockResolvedValue(anthropicSse(''));
    vi.stubGlobal('fetch', fetchMock);
    await expect(anthropicChat({ ...cfg, log: (m) => logs.push(m) }, userMsg, 0)).rejects.toBeInstanceOf(
      EmptyCompletionError
    );
    expect(logs.some((m) => /anthropic extraction failed \(empty completion\); events=\d+/.test(m))).toBe(true);
  });

  it('whitespace-only text is still an empty completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicSse('   \n\t '));
    vi.stubGlobal('fetch', fetchMock);
    await expect(anthropicChat(cfg, userMsg, 0)).rejects.toBeInstanceOf(EmptyCompletionError);
  });

  it('mid-stream error event rejects with a retryable plain Error', async () => {
    const wire = sseWire([
      textDelta('partial'),
      {
        event: 'error',
        data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
      }
    ]);
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire]));
    vi.stubGlobal('fetch', fetchMock);
    const err = await anthropicChat(cfg, userMsg, 0).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('Error'); // plain Error, not LLMError/HttpError
    expect(err.message).toBe(
      'anthropic stream error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    );
  });

  it('mid-stream error retries: stream:true in both bodies, success on attempt 2', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter => exact 2s backoff
    const errorWire = sseWire([
      textDelta('partial'),
      { event: 'error', data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sseResponse([errorWire]))
      .mockResolvedValueOnce(anthropicSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const promise = callLLM(cfg, userMsg);
    const done = expect(promise).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => jsonBody(c[1] as RequestInit));
    expect(bodies[0].stream).toBe(true);
    expect(bodies[1].stream).toBe(true);
  });

  it('clamps the hard abort deadline to 2^31 - 1 ms', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(anthropicSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await anthropicChat(cfg, userMsg, 2 ** 40);
    expect(timeoutSpy).toHaveBeenCalledWith(2 ** 31 - 1);
  });

  it('timeoutMs 0 sends no abort signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(anthropicSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await anthropicChat(cfg, userMsg, 0);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeUndefined();
  });
});

describe('anthropicChat — robustness', () => {
  it('falls back to a JSON (non-SSE) completion when the endpoint ignores stream:true', async () => {
    const logs: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(resp(200, { content: [{ type: 'text', text: '{"ok":1}' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM({ ...cfg, log: (m) => logs.push(m) }, userMsg);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toMatch(/not SSE/i);
  });

  it('skips a malformed content_block_delta payload instead of failing the request', async () => {
    // A truncated line (dropped connection, re-framing proxy) must not discard
    // an otherwise-usable stream.
    const events: SSEEvent[] = [
      { event: 'message_start', data: '{"type":"message_start"}' },
      { event: 'content_block_delta', data: '{"type":"content_block_delta","delta":{"type":"text_del' },
      textDelta('{"ok":'),
      textDelta('1}'),
      { event: 'message_stop', data: '{"type":"message_stop"}' }
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseWire(events)]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callLLM(cfg, userMsg)).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no whole-request retry
  });

  it('logs stop_reason and thinking presence on empty completions', async () => {
    const logs: string[] = [];
    const events: SSEEvent[] = [
      { event: 'message_start', data: '{"type":"message_start"}' },
      thinkingDelta('pondering the diff'),
      { event: 'message_delta', data: '{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}' },
      { event: 'message_stop', data: '{"type":"message_stop"}' }
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sseResponse([sseWire(events)]))
      .mockResolvedValueOnce(anthropicSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await callLLM({ ...cfg, log: (m) => logs.push(m) }, userMsg);
    expect(logs.join('\n')).toContain('stop_reason=max_tokens');
    expect(logs.join('\n')).toContain('thinking=yes');
  });

  it('retries once without extra_body when the provider rejects it with 400', async () => {
    const logs: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        resp(400, {
          error: {
            type: 'invalid_request_error',
            message: 'temperature may only be set to 1 when thinking is enabled'
          }
        })
      )
      .mockResolvedValueOnce(anthropicSse('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await callLLM(
      {
        ...cfg,
        extraBody: { thinking: { type: 'enabled', budget_tokens: 2048 } },
        log: (m) => logs.push(m)
      },
      userMsg
    );
    expect(out).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = jsonBody(fetchMock.mock.calls[1][1] as RequestInit);
    expect(retry.thinking).toBeUndefined(); // rejected param dropped
    expect(retry.temperature).toBe(0.2); // base fields retained
    expect(logs.join('\n')).toMatch(/extra_body/i);
  });
});
