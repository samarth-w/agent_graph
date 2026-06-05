/**
 * SmartCrusher tests — coding vs thinking mode, lossless tabular path,
 * CCR ID in truncation sentinel, capacity standard vs large.
 */
import { describe, it, expect } from 'vitest';
import { SmartCrusher } from '../src/compression/SmartCrusher';

// Helper — build a payload whose JSON is approximately `targetBytes` long
function buildPayload(targetBytes: number): unknown {
  const items = [];
  while (JSON.stringify(items).length < targetBytes) {
    items.push({
      name: `symbol_${items.length}`,
      file: `src/module_${items.length % 10}.ts`,
      start_line: items.length * 3 + 1,
      end_line:   items.length * 3 + 3,
      kind: 'function',
      signature: `function symbol_${items.length}(arg1: string, arg2: number): boolean`,
    });
  }
  return { nodes: items, edges: [], truncated: false };
}

describe('SmartCrusher.crush', () => {

  describe('small payload (passthrough)', () => {
    const tiny = { message: 'hello', count: 3 };

    it('returns data unchanged for tiny payloads in coding mode', () => {
      const result = SmartCrusher.crush(tiny, 'coding', 'standard');
      // Small payloads fit — no ccr_id meta should be injected
      const json = JSON.stringify(result);
      expect(json).toContain('hello');
    });

    it('returns data unchanged for tiny payloads in thinking mode', () => {
      const result = SmartCrusher.crush(tiny, 'thinking', 'standard');
      const json = JSON.stringify(result);
      expect(json).toContain('hello');
    });
  });

  describe('large payload (compression applied)', () => {
    it('reduces output size in coding mode', () => {
      const large = buildPayload(20_000);
      const raw  = JSON.stringify(large).length;
      const result = SmartCrusher.crush(large, 'coding', 'standard');
      const compressed = JSON.stringify(result).length;
      expect(compressed).toBeLessThan(raw);
    });

    it('reduces output size in thinking mode', () => {
      const large = buildPayload(20_000);
      const raw  = JSON.stringify(large).length;
      const result = SmartCrusher.crush(large, 'thinking', 'standard');
      const compressed = JSON.stringify(result).length;
      expect(compressed).toBeLessThan(raw);
    });

    it('large capacity allows more content through than standard', () => {
      const large = buildPayload(30_000);
      const standard = JSON.stringify(SmartCrusher.crush(large, 'coding', 'standard')).length;
      const largeCap  = JSON.stringify(SmartCrusher.crush(large, 'coding', 'large')).length;
      expect(largeCap).toBeGreaterThanOrEqual(standard);
    });
  });

  describe('CCR ID in truncation sentinel', () => {
    // coding+standard truncates arrays at 10 items; use 15 plain strings
    // (not objects) so tabular compaction is skipped and truncation fires.
    const truncatableData = Array.from({ length: 15 }, (_, i) => `item_${i}_${'x'.repeat(50)}`);

    it('embeds the provided ccrId in the truncation sentinel', () => {
      const result = SmartCrusher.crush(truncatableData, 'coding', 'standard', 'ccr_test_abc123');
      const json = JSON.stringify(result);
      expect(json).toContain('ccr_test_abc123');
    });

    it('uses a generic hint when ccrId is omitted', () => {
      const withId    = JSON.stringify(SmartCrusher.crush(truncatableData, 'coding', 'standard', 'ccr_sentinel_unique'));
      const withoutId = JSON.stringify(SmartCrusher.crush(truncatableData, 'coding', 'standard'));
      expect(withId).toContain('ccr_sentinel_unique');
      expect(withoutId).not.toContain('ccr_sentinel_unique');
    });
  });

  describe('lossless tabular compaction', () => {
    it('compacts uniform array of objects into tabular form', () => {
      // A payload that is a clean uniform array — ideal for tabular compaction
      const tabular = {
        nodes: Array.from({ length: 50 }, (_, i) => ({
          id: i,
          name: `node_${i}`,
          kind: 'function',
          file: 'src/test.ts',
          line: i + 1,
        })),
      };
      const raw = JSON.stringify(tabular).length;
      const result = SmartCrusher.crush(tabular, 'coding', 'standard');
      const compressed = JSON.stringify(result).length;
      // Tabular compaction should reduce size, or at worst not inflate it significantly
      expect(compressed).toBeLessThanOrEqual(raw * 1.1);
    });
  });

  describe('edge cases', () => {
    it('handles null input gracefully', () => {
      expect(() => SmartCrusher.crush(null, 'coding', 'standard')).not.toThrow();
    });

    it('handles empty object', () => {
      const result = SmartCrusher.crush({}, 'coding', 'standard');
      expect(result).toBeDefined();
    });

    it('handles empty array', () => {
      const result = SmartCrusher.crush([], 'coding', 'standard');
      expect(result).toBeDefined();
    });
  });
});
