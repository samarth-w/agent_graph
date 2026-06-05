import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LRUCache } from '../src/cache';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cache-test-')); }

describe('LRUCache', () => {
  it('returns undefined for missing key', () => {
    const c = new LRUCache<string>(10);
    expect(c.get('missing')).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    const c = new LRUCache<string>(10);
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
  });

  it('evicts least-recently-used when at capacity', () => {
    const c = new LRUCache<number>(3);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    c.set('d', 4); // evicts 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toBe(4);
  });

  it('has() returns true for live entry', () => {
    const c = new LRUCache<string>(10);
    c.set('x', 'y');
    expect(c.has('x')).toBe(true);
  });

  it('has() returns false for missing key', () => {
    const c = new LRUCache<string>(10);
    expect(c.has('nope')).toBe(false);
  });

  it('clear() removes all entries', () => {
    const c = new LRUCache<number>(10);
    c.set('a', 1); c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
  });

  it('accessing a key moves it to most-recently-used', () => {
    const c = new LRUCache<number>(2);
    c.set('a', 1); c.set('b', 2);
    c.get('a');    // 'a' is now MRU
    c.set('c', 3); // evicts 'b', not 'a'
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
  });

  it('expired entries are not returned', async () => {
    const c = new LRUCache<string>(10, 10); // 10ms TTL
    c.set('k', 'v');
    await new Promise(r => setTimeout(r, 30));
    expect(c.get('k')).toBeUndefined();
  });

  it('size reflects current entry count', () => {
    const c = new LRUCache<number>(10);
    expect(c.size).toBe(0);
    c.set('a', 1);
    expect(c.size).toBe(1);
  });

  describe('disk persistence', () => {
    let tempDir: string;
    afterEach(() => { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); });

    it('persists and reloads entries', () => {
      tempDir = createTempDir();
      const p = path.join(tempDir, 'cache.json');
      const c1 = new LRUCache<string>(10, 60_000);
      c1.enablePersistence(p);
      c1.set('hello', 'world');
      c1.saveToDisk();

      const c2 = new LRUCache<string>(10, 60_000);
      c2.enablePersistence(p);
      expect(c2.get('hello')).toBe('world');
    });
  });
});
