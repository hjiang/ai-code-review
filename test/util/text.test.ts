import { describe, expect, it } from 'vitest';
import { normalizeTokens, tokenContainment } from '../../src/util/text.js';

describe('normalizeTokens', () => {
  it('lowercases and keeps alphanumeric tokens', () => {
    expect(normalizeTokens('SQL Injection!')).toEqual(new Set(['sql', 'injection']));
  });

  it('strips severity emoji and markdown decoration', () => {
    expect(normalizeTokens('🔴 **Severity: critical**\n\nFix it.')).toEqual(
      new Set(['severity', 'critical', 'fix'])
    );
  });

  it('drops stopwords and single-character tokens', () => {
    expect(normalizeTokens('use a parameterized query')).toEqual(new Set(['parameterized', 'query']));
  });

  it('keeps content inside ordinary parentheses while collapsing markdown links', () => {
    expect(
      normalizeTokens('Use bind params (CWE-89) to prevent [SQL injection](https://example.com/x) HERE')
    ).toEqual(new Set(['bind', 'params', 'cwe', '89', 'prevent', 'sql', 'injection']));
  });
});

describe('tokenContainment', () => {
  it('is the fraction of the smaller set contained in the larger', () => {
    expect(tokenContainment(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c', 'd', 'e']))).toBe(1);
  });

  it('is symmetric and 0 for disjoint sets', () => {
    expect(tokenContainment(new Set(['a']), new Set(['b']))).toBe(0);
    expect(tokenContainment(new Set(['a', 'b']), new Set(['b']))).toBe(1);
  });
});
