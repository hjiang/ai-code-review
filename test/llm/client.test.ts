import { afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM, resolveProvider, LLMError } from '../../src/llm/client.js';
import type { LLMConfig } from '../../src/llm/types.js';
import { backoffMs, sleep } from '../../src/util/retry.js';

function resp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function openAiOk(content: string): Response {
  return resp(200, { choices: [{ message: { content } }] });
}

function anthropicOk(content: string): Response {
  return resp(200, { content: [{ type: 'text', text: content }] });
}

const baseCfg: LLMConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  maxTokens: 8192,
  temperature: 0.2,
  jsonMode: 'auto'
};

function jsonBody(init?: RequestInit): any {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveProvider', () => {
  it('honors explicit provider inputs', () => {
    expect(resolveProvider('openai', 'https://anywhere')).toBe('openai');
    expect(resolveProvider('anthropic', 'https://anywhere')).toBe('anthropic');
  });
  it('infers anthropic from api.anthropic.com in auto mode', () => {
    expect(resolveProvider('auto', 'https://api.anthropic.com/v1')).toBe('anthropic');
    expect(resolveProvider(undefined, 'https://api.anthropic.com')).toBe('anthropic');
  });
  it('defaults to openai for anything else in auto mode', () => {
    expect(resolveProvider('auto', 'https://api.openai.com/v1')).toBe('openai');
    expect(resolveProvider('auto', 'http://localhost:11434/v1')).toBe('openai');
    expect(resolveProvider(undefined, 'https://deepseek.example.com/v1')).toBe('openai');
  });
});

describe('callLLM — openai adapter', () => {
  it('posts the expected URL, headers and body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = jsonBody(init);
    expect(body.model).toBe('gpt-test');
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('retries once without response_format when the endpoint rejects it with 400', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(400, { error: { message: 'response_format is not supported' } }))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jsonBody(fetchMock.mock.calls[0][1]).response_format).toEqual({ type: 'json_object' });
    expect(jsonBody(fetchMock.mock.calls[1][1]).response_format).toBeUndefined();
  });

  it('does not send response_format in jsonMode off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await callLLM({ ...baseCfg, jsonMode: 'off' }, [{ role: 'user', content: 'hi' }]);
    expect(jsonBody(fetchMock.mock.calls[0][1]).response_format).toBeUndefined();
  });
});

describe('callLLM — anthropic adapter', () => {
  it('splits the system message and posts anthropic-shaped body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM(
      { ...baseCfg, provider: 'anthropic', baseUrl: 'https://api.anthropic.com' },
      [
        { role: 'system', content: 'You are strict.' },
        { role: 'user', content: 'hi' }
      ]
    );
    expect(result).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-test');
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = jsonBody(init);
    expect(body.system).toBe('You are strict.');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.response_format).toBeUndefined();
  });
});

describe('callLLM — retries', () => {
  it('retries 429 with exponential backoff then succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter => exact 2s/8s/32s
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(429, 'rate limited'))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const promise = callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    const done = expect(promise).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up with LLMError after exhausting 5xx retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi.fn().mockImplementation(() => resp(503, 'down'));
    vi.stubGlobal('fetch', fetchMock);
    const promise = callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    const done = expect(promise).rejects.toBeInstanceOf(LLMError);
    await vi.advanceTimersByTimeAsync(10000);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shares a single 5-minute deadline across retry attempts (shrinking per attempt)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(429, 'rate limited'))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const promise = callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    await vi.advanceTimersByTimeAsync(2000); // first backoff (2s)
    await expect(promise).resolves.toEqual({ ok: 1 });
    const timeouts = timeoutSpy.mock.calls.map((c) => c[0] as number);
    expect(timeouts).toHaveLength(2);
    // Second attempt's remaining budget must be smaller than the first,
    // proving the deadline is shared (not a fresh 5-min per attempt).
    expect(timeouts[1]).toBeLessThan(timeouts[0]);
    expect(timeouts[0]).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('retries transient network errors', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const promise = callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    const done = expect(promise).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clamps the backoff sleep to the remaining deadline budget', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // backoff(0) = 2s exactly
    // Attempt 1 consumes 299s of the 5-minute deadline, leaving 1s.
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      await sleep(299_000);
      return resp(429, 'rate limited');
    });
    vi.stubGlobal('fetch', fetchMock);
    let settled = false;
    const promise = callLLM(baseCfg, [{ role: 'user', content: 'hi' }]).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.advanceTimersByTimeAsync(299_000); // first attempt finishes at t=299s
    await vi.advanceTimersByTimeAsync(1_000); // t=300s: deadline exhausted
    // The unclamped 2s backoff would still be pending here; the clamped sleep
    // (1s) has fired and the request gave up exactly at the deadline.
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await promise;
  });

  it('throws an explicit deadline-exceeded error when the budget is already exhausted', async () => {
    // Simulate the clock jumping past the deadline between the deadline
    // computation and the first attempt's remaining-budget check, so the loop
    // breaks before any attempt starts and `lastErr` stays undefined.
    const T0 = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(T0)
      .mockReturnValue(T0 + 5 * 60 * 1000 + 1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const promise = callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    await expect(promise).rejects.toThrow(/deadline exceeded/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('callLLM — JSON re-ask', () => {
  it('re-asks once with the parse error when the reply is not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiOk('I will narrate my thoughts instead'))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = jsonBody(fetchMock.mock.calls[1][1]);
    expect(secondBody.messages.at(-2).role).toBe('assistant');
    expect(secondBody.messages.at(-1).content).toMatch(/not valid JSON/);
  });

  it('throws LLMError after two invalid JSON replies, embedding both raw replies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiOk('still not json'))
      .mockResolvedValueOnce(openAiOk('still not json'));
    vi.stubGlobal('fetch', fetchMock);
    const err = (await callLLM(baseCfg, [{ role: 'user', content: 'hi' }]).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(LLMError);
    expect(String(err.message)).toMatch(/invalid JSON twice/);
    expect(String(err.message)).toContain('#1="still not json"');
    expect(String(err.message)).toContain('#2="still not json"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports each failed parse attempt with the raw reply via the log callback', async () => {
    const logs: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiOk('sorry, no json here\nline two'))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM({ ...baseCfg, log: (m) => logs.push(m) }, [
      { role: 'user', content: 'hi' }
    ]);
    expect(result).toEqual({ ok: 1 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/attempt #1 not strict JSON/);
    expect(logs[0]).toContain('sorry, no json here\\nline two');
  });

  it('truncates long raw replies in the logged excerpt', async () => {
    const logs: string[] = [];
    const long = 'x'.repeat(2000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiOk(long))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await callLLM({ ...baseCfg, log: (m) => logs.push(m) }, [{ role: 'user', content: 'hi' }]);
    expect(logs[0]).toContain('(+1400 more chars)');
  });
});

describe('callLLM — empty completions (reasoning-model budget burn)', () => {
  it('openai: retries once without response_format, then succeeds (same messages)', async () => {
    const logs: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiOk('')) // attempt (auto) → empty
      .mockResolvedValueOnce(openAiOk('{"ok":1}')); // retry without response_format
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM({ ...baseCfg, log: (m) => logs.push(m) }, [
      { role: 'user', content: 'hi' }
    ]);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jsonBody(fetchMock.mock.calls[0][1]).response_format).toEqual({ type: 'json_object' });
    expect(jsonBody(fetchMock.mock.calls[1][1]).response_format).toBeUndefined();
    // The retry sends the SAME original messages (no re-ask nudge yet).
    expect(jsonBody(fetchMock.mock.calls[1][1]).messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(logs.join('\n')).toMatch(/retrying the same prompt without response_format/);
  });

  it('openai: if still empty without response_format, recovers via the JSON re-ask nudge', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiOk('')) // auto → empty
      .mockResolvedValueOnce(openAiOk('')) // off → empty
      .mockResolvedValueOnce(openAiOk('{"ok":1}')); // re-ask nudge → success
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM(baseCfg, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdBody = jsonBody(fetchMock.mock.calls[2][1]);
    expect(thirdBody.messages.at(-1).content).toMatch(/not valid JSON/);
  });

  it('openai: logs the raw provider response (finish_reason/usage) on empty content', async () => {
    const logs: string[] = [];
    const raw = {
      id: 'chatcmpl-1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'thinking…' },
          finish_reason: 'length'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 }
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(200, raw))
      .mockResolvedValueOnce(openAiOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await callLLM({ ...baseCfg, log: (m) => logs.push(m) }, [{ role: 'user', content: 'hi' }]);
    expect(logs[0]).toMatch(/openai extraction failed .*empty completion/);
    expect(logs[0]).toContain('finish_reason');
    expect(logs[0]).toContain('length');
    expect(logs[0]).toContain('reasoning_content');
    expect(logs[0]).toContain('completion_tokens');
    expect(logs[0]).toContain('8192');
  });

  it('openai: gives up with invalid-JSON-twice (raw replies embedded) when every recovery fails', async () => {
    const fetchMock = vi.fn().mockImplementation(() => openAiOk('   '));
    vi.stubGlobal('fetch', fetchMock);
    const err = (await callLLM(baseCfg, [{ role: 'user', content: 'hi' }]).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(LLMError);
    expect(String(err.message)).toMatch(/invalid JSON twice/);
    // attempts: auto(empty) + off(empty) + re-ask(empty)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('openai: jsonMode off skips the response_format retry and re-asks directly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiOk('')) // off → empty
      .mockResolvedValueOnce(openAiOk('{"ok":1}')); // re-ask nudge → success
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM({ ...baseCfg, jsonMode: 'off' }, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jsonBody(fetchMock.mock.calls[0][1]).response_format).toBeUndefined();
    const secondBody = jsonBody(fetchMock.mock.calls[1][1]);
    expect(secondBody.messages.at(-1).content).toMatch(/not valid JSON/);
  });

  it('anthropic: an empty text block triggers the re-ask (no response_format involved) and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(anthropicOk(''))
      .mockResolvedValueOnce(anthropicOk('{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callLLM({ ...baseCfg, provider: 'anthropic' }, [
      { role: 'user', content: 'hi' }
    ]);
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = jsonBody(fetchMock.mock.calls[1][1]);
    expect(secondBody.messages.at(-1).content).toMatch(/not valid JSON/);
  });
});

describe('retry helpers', () => {
  it('backoffMs uses 2s/8s/32s with ±20% jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffMs(0)).toBe(2000);
    expect(backoffMs(1)).toBe(8000);
    expect(backoffMs(2)).toBe(32000);
    vi.spyOn(Math, 'random').mockReturnValue(0.0);
    expect(backoffMs(0)).toBe(1600);
    vi.spyOn(Math, 'random').mockReturnValue(1.0);
    expect(backoffMs(0)).toBe(2400);
  });

  it('sleep resolves after the delay', async () => {
    vi.useFakeTimers();
    const p = sleep(100);
    const done = vi.fn();
    p.then(done);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
