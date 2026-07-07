import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileWatcher } from '../src/watcher';
import { indexProject } from '../src/indexer';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-watcher-test-')); }

describe('FileWatcher', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = createTempDir();
    // Seed the index so watcher has a DB to reload
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'seed.ts'), 'export function seed() {}\n');
    await indexProject(tempDir, { force: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('can be constructed with default options', () => {
    const w = new FileWatcher(tempDir);
    expect(w).toBeDefined();
  });

  it('stop() does not throw on a new watcher', () => {
    const w = new FileWatcher(tempDir);
    expect(() => { w.stop(); }).not.toThrow();
  });

  it('watcher can be constructed with callback options', () => {
    const w = new FileWatcher(tempDir, {
      debounceMs: 50,
      onSync: () => {},
      onError: () => {},
    });
    expect(w).toBeDefined();
    w.stop();
  });

  it('watcher constructed with bad path does not throw at construction', () => {
    const w = new FileWatcher(path.join(tempDir, 'nonexistent'));
    expect(w).toBeDefined();
    w.stop();
  });

  it('detects a source file change and triggers onSync after the debounce window', async () => {
    let syncResult: { files_changed: number; duration_ms: number } | null = null;
    const w = new FileWatcher(tempDir, {
      debounceMs: 100,
      onSync: (result) => { syncResult = result; },
      onError: () => {},
    });
    w.start();

    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      fs.writeFileSync(path.join(tempDir, 'src', 'seed.ts'), 'export function seed() { return 2; }\n');
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(syncResult).not.toBeNull();
      expect(syncResult!.files_changed).toBeGreaterThanOrEqual(1);
    } finally {
      w.stop();
    }
  }, 10_000);

  it('does not trigger onSync for changes after stop() is called', async () => {
    let syncCount = 0;
    const w = new FileWatcher(tempDir, {
      debounceMs: 100,
      onSync: () => { syncCount++; },
      onError: () => {},
    });
    w.start();
    w.stop();

    fs.writeFileSync(path.join(tempDir, 'src', 'seed.ts'), 'export function seed() { return 3; }\n');
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(syncCount).toBe(0);
  }, 10_000);
});
