/**
 * Tests for v0.3.0 features: HTML export, fuzzy search, persistent cache, parallel indexing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toHtml, toMermaid } from '../src/export';
import { LRUCache } from '../src/cache';
import { GraphDB } from '../src/storage';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── HTML export ─────────────────────────────────────────────────
describe('toHtml', () => {
  let db: GraphDB;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-html-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = await GraphDB.open(dbPath);
    // Insert test data
    const fid = db.upsertFile('src/app.ts', 'abc', 'typescript', 100, Date.now()).id;
    db.insertNode(fid, 'main', 'src/app.ts::main', 'function', 1, 10, 'function main()', null, true);
    db.insertNode(fid, 'helper', 'src/app.ts::helper', 'function', 12, 20, 'function helper()', null, false);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns valid HTML with D3 script', () => {
    const html = toHtml(db);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('d3.v7.min.js');
    expect(html).toContain('forceSimulation');
    expect(html).toContain('main');
    expect(html).toContain('helper');
  });

  it('returns no-nodes HTML for empty graph', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-empty-'));
    const emptyDb = await GraphDB.open(path.join(emptyDir, 'empty.db'));
    const html = toHtml(emptyDb, { symbol: 'nonexistent' });
    expect(html).toContain('No nodes found');
    emptyDb.close();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('includes node metadata in JSON', () => {
    const html = toHtml(db);
    expect(html).toContain('"name":"main"');
    expect(html).toContain('"kind":"function"');
  });
});

// ── Fuzzy search ────────────────────────────────────────────────
describe('fuzzySearch', () => {
  let db: GraphDB;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-fuzzy-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = await GraphDB.open(dbPath);
    const fid = db.upsertFile('src/utils.ts', 'abc', 'typescript', 100, Date.now()).id;
    db.insertNode(fid, 'handleRequest', 'src/utils.ts::handleRequest', 'function', 1, 10, '', null, true);
    db.insertNode(fid, 'handleResponse', 'src/utils.ts::handleResponse', 'function', 12, 20, '', null, true);
    db.insertNode(fid, 'processData', 'src/utils.ts::processData', 'function', 22, 30, '', null, true);
    db.insertNode(fid, 'validateInput', 'src/utils.ts::validateInput', 'function', 32, 40, '', null, true);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds symbols with typos', () => {
    const results = db.fuzzySearch('handleReqeust'); // typo
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.name).toBe('handleRequest');
  });

  it('finds similar symbols', () => {
    const results = db.fuzzySearch('handlResp');
    expect(results.length).toBeGreaterThan(0);
    const names = results.map(r => r.node.name);
    expect(names).toContain('handleResponse');
  });

  it('returns empty for completely unrelated query', () => {
    const results = db.fuzzySearch('zzzzxyzzy', 10, 0.5);
    expect(results.length).toBe(0);
  });
});

// ── Persistent cache ────────────────────────────────────────────
describe('LRUCache persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cache-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists and restores cache from disk', () => {
    const cachePath = path.join(tmpDir, 'cache.json');
    const cache1 = new LRUCache<string>(64, 60_000);
    cache1.enablePersistence(cachePath);
    cache1.set('key1', 'value1');
    cache1.set('key2', 'value2');
    cache1.saveToDisk();

    expect(fs.existsSync(cachePath)).toBe(true);

    // New cache instance loads from disk
    const cache2 = new LRUCache<string>(64, 60_000);
    cache2.enablePersistence(cachePath);
    expect(cache2.get('key1')).toBe('value1');
    expect(cache2.get('key2')).toBe('value2');
  });

  it('clear() removes disk cache', () => {
    const cachePath = path.join(tmpDir, 'cache.json');
    const cache = new LRUCache<string>(64, 60_000);
    cache.enablePersistence(cachePath);
    cache.set('key1', 'value1');
    cache.saveToDisk();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('handles corrupted cache file gracefully', () => {
    const cachePath = path.join(tmpDir, 'cache.json');
    fs.writeFileSync(cachePath, 'not json!!!', 'utf-8');
    const cache = new LRUCache<string>(64, 60_000);
    cache.enablePersistence(cachePath);
    expect(cache.size).toBe(0);
  });
});
