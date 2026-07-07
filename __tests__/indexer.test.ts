import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { indexProject } from '../src/indexer';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-indexer-test-')); }

describe('indexProject', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); });

  function writeFile(rel: string, content: string): void {
    const full = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  it('returns an IndexResult with expected shape', async () => {
    writeFile('src/hello.ts', 'export function hello() { return 42; }\n');
    const result = await indexProject(tempDir, { force: true });
    expect(result).toHaveProperty('files_scanned');
    expect(result).toHaveProperty('files_changed');
    expect(result).toHaveProperty('nodes_total');
    expect(result).toHaveProperty('edges_total');
    expect(result).toHaveProperty('duration_ms');
  });

  it('indexes TypeScript functions', async () => {
    writeFile('src/math.ts', 'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n');
    const result = await indexProject(tempDir, { force: true });
    expect(result.nodes_total).toBeGreaterThanOrEqual(2);
    expect(result.files_changed).toBeGreaterThanOrEqual(1);
  });

  it('incremental index does not re-parse unchanged files', async () => {
    writeFile('src/stable.ts', 'export function stable() {}\n');
    await indexProject(tempDir, { force: true });
    const second = await indexProject(tempDir, { force: false });
    expect(second.files_changed).toBe(0);
  });

  it('detects added file on re-index', async () => {
    writeFile('src/a.ts', 'export function a() {}\n');
    await indexProject(tempDir, { force: true });
    writeFile('src/b.ts', 'export function b() {}\n');
    const second = await indexProject(tempDir, { force: false });
    expect(second.files_changed).toBeGreaterThanOrEqual(1);
  });

  it('force flag re-indexes all files', async () => {
    writeFile('src/c.ts', 'export function c() {}\n');
    await indexProject(tempDir, { force: true });
    const forced = await indexProject(tempDir, { force: true });
    expect(forced.files_changed).toBeGreaterThanOrEqual(1);
  });

  it('uses the parallel parse path for large batches (>= worker threshold)', async () => {
    // WORKER_THRESHOLD in src/indexer.ts is 8 — write more files than that
    // so executeParsePhase routes through parseFilesParallel.
    for (let i = 0; i < 10; i++) {
      writeFile(`src/batch${i}.ts`, `export function batch${i}() { return ${i}; }\n`);
    }
    const result = await indexProject(tempDir, { force: true });
    expect(result.files_changed).toBeGreaterThanOrEqual(10);
    expect(result.nodes_total).toBeGreaterThanOrEqual(10);
  });
});
