/**
 * LRU cache for MCP tool results with optional disk persistence.
 * Avoids redundant graph traversals for repeated queries.
 */
import * as fs from 'fs';
import * as path from 'path';

interface CacheEntry<T> {
  key: string;
  value: T;
  timestamp: number;
}

interface DiskPayload<T> {
  version: 1;
  entries: Array<{ key: string; value: T; timestamp: number }>;
}

export class LRUCache<T = string> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private ttlMs: number;
  private persistPath: string | null = null;

  constructor(maxSize = 64, ttlMs = 30_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Enable disk persistence to a file (e.g. `.cgraph/cache.json`). */
  enablePersistence(filePath: string): void {
    this.persistPath = filePath;
    this.loadFromDisk();
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete first to reset position
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    this.cache.set(key, { key, value, timestamp: Date.now() });
  }

  /** Invalidate all entries (e.g. after re-index) */
  clear(): void {
    this.cache.clear();
    this.saveToDisk();
  }

  /** Check if a key exists and is not expired, without affecting LRU order. */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.cache.size;
  }

  /** Persist current cache to disk (if enabled). */
  saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload: DiskPayload<T> = {
        version: 1,
        entries: Array.from(this.cache.values()).map(e => ({
          key: e.key, value: e.value, timestamp: e.timestamp,
        })),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(payload), 'utf-8');
    } catch {
      // Silently ignore disk errors — cache is best-effort
    }
  }

  /** Load cache from disk, discarding expired entries. */
  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const payload = JSON.parse(raw) as DiskPayload<T>;
      if (payload.version !== 1) return;
      const now = Date.now();
      for (const e of payload.entries) {
        if (now - e.timestamp <= this.ttlMs) {
          this.cache.set(e.key, { key: e.key, value: e.value, timestamp: e.timestamp });
        }
      }
      // Trim to maxSize (keep most recent)
      while (this.cache.size > this.maxSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    } catch {
      // Corrupted file — start fresh
    }
  }
}
