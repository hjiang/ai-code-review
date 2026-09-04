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

  it('prefers the outer payload over a fenced code example inside a string value', () => {
    // Regression: posta run 33876403722. The model emitted a valid findings
    // JSON object whose comment_md contained a fenced Rust block; the old
    // fence-first heuristic grabbed the inner block and failed with
    // "Expected property name or '}' in JSON at position 1".
    const reply = JSON.stringify({
      findings: [
        {
          path: 'tests/fixtures/src/generate.rs',
          line: 448,
          severity: 'warning',
          comment_md:
            '🟠 **Severity: warning**\n\nUse a proper runtime check:\n```rust\nif out.messages.len() as u64 != n {\n    return Err(SeedError::Generation(format!("{}", n)));\n}\n```',
        },
      ],
    });
    const parsed = extractJson(reply) as { findings: Array<{ path: string }> };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].path).toBe('tests/fixtures/src/generate.rs');
  });

  it('prefers the outer payload over a fenced pseudo-JSON example inside a string value', () => {
    const reply =
      '{\n  "findings": [\n    {"path": "a.rs", "comment_md": "example:\\n```json\\n{\'bad\': 1}\\n```"}\n  ]\n}';
    const parsed = extractJson(reply) as { findings: Array<{ path: string }> };
    expect(parsed.findings[0].path).toBe('a.rs');
  });

  it('still extracts the fenced block when the reply is prose-wrapped', () => {
    expect(extractJson('Review results:\n```json\n{"a":1}\n```\ndone')).toEqual({ a: 1 });
  });
});
