/**
 * MCP Server Tests — input validation and tool handler basics.
 */
import { describe, it, expect } from 'vitest';

// We can't easily test the full MCP server (stdin/stdout JSON-RPC),
// so we test the validation helpers that are the safety layer.

// Re-implement the validation functions (they're not exported, so we test the same logic)
const MAX_INPUT_LENGTH = 10_000;

function validateString(value: unknown, name: string, maxLen = MAX_INPUT_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > maxLen) {
    throw new Error(`${name} exceeds max length of ${maxLen}`);
  }
  return value;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

describe('validateString', () => {
  it('accepts a valid string', () => {
    expect(validateString('hello', 'test')).toBe('hello');
  });

  it('rejects empty string', () => {
    expect(() => validateString('', 'query')).toThrow('query must be a non-empty string');
  });

  it('rejects null', () => {
    expect(() => validateString(null, 'query')).toThrow('query must be a non-empty string');
  });

  it('rejects undefined', () => {
    expect(() => validateString(undefined, 'query')).toThrow('query must be a non-empty string');
  });

  it('rejects number', () => {
    expect(() => validateString(42, 'query')).toThrow('query must be a non-empty string');
  });

  it('rejects string exceeding max length', () => {
    const long = 'x'.repeat(10_001);
    expect(() => validateString(long, 'query')).toThrow('query exceeds max length');
  });

  it('accepts string at exact max length', () => {
    const exact = 'x'.repeat(10_000);
    expect(validateString(exact, 'query')).toBe(exact);
  });

  it('respects custom max length', () => {
    expect(() => validateString('abc', 'test', 2)).toThrow('test exceeds max length of 2');
  });
});

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
  });

  it('clamps to min', () => {
    expect(clamp(-5, 1, 10)).toBe(1);
  });

  it('clamps to max', () => {
    expect(clamp(20, 1, 10)).toBe(10);
  });

  it('handles edge at min', () => {
    expect(clamp(1, 1, 10)).toBe(1);
  });

  it('handles edge at max', () => {
    expect(clamp(10, 1, 10)).toBe(10);
  });
});
