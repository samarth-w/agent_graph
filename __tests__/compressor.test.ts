import { describe, it, expect } from 'vitest';
import { CodeCompressor } from '../src/compression/CodeCompressor';

describe('CodeCompressor.skeletonize', () => {
  const simpleFunction = `
export function add(a: number, b: number): number {
  const result = a + b;
  return result;
}
`.trim();

  it('skeletonizes in coding mode', () => {
    const out = CodeCompressor.skeletonize(simpleFunction, 'coding');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('skeletonizes in thinking mode', () => {
    const out = CodeCompressor.skeletonize(simpleFunction, 'thinking');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('returns shorter output than input for a function with a body', () => {
    const out = CodeCompressor.skeletonize(simpleFunction, 'coding');
    expect(out.length).toBeLessThan(simpleFunction.length);
  });

  it('retains function signature', () => {
    const out = CodeCompressor.skeletonize(simpleFunction, 'coding');
    expect(out).toContain('add');
  });

  it('handles invalid code gracefully (returns original)', () => {
    const bad = 'this is not { valid code |||';
    const out = CodeCompressor.skeletonize(bad, 'coding');
    expect(out).toBe(bad);
  });

  it('strips comments in coding mode', () => {
    const code = `
// This is a comment
export function foo() {
  return 1;
}
`.trim();
    const out = CodeCompressor.skeletonize(code, 'coding');
    expect(out).not.toContain('This is a comment');
  });

  it('retains comments in thinking mode', () => {
    const code = `
// This is a comment
export function foo() {
  return 1;
}
`.trim();
    const out = CodeCompressor.skeletonize(code, 'thinking');
    expect(out).toContain('This is a comment');
  });

  it('handles empty string without throwing', () => {
    expect(() => CodeCompressor.skeletonize('', 'coding')).not.toThrow();
  });

  it('handles class with methods', () => {
    const code = `
export class Calc {
  add(a: number, b: number): number { return a + b; }
}
`.trim();
    const out = CodeCompressor.skeletonize(code, 'coding');
    expect(out).toContain('Calc');
  });
});
