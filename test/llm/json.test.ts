import { describe, expect, it } from 'vitest';
import { extractJson } from '../../src/llm/json.js';

describe('extractJson', () => {
  it('parses clean JSON objects', () => {
    expect(extractJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('parses fenced JSON blocks', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts JSON embedded in surrounding prose', () => {
    expect(extractJson('Here you go: {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  it('parses top-level arrays', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('ignores brackets inside string values when finding the JSON bounds', () => {
    expect(extractJson('{"a":"}b]","c":1}')).toEqual({ a: '}b]', c: 1 });
  });

  it('throws when no JSON is present', () => {
    expect(() => extractJson('no json here')).toThrow();
    expect(() => extractJson('')).toThrow();
  });

  it('throws on malformed JSON', () => {
    expect(() => extractJson('{"a": }')).toThrow();
  });
});
