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
});
