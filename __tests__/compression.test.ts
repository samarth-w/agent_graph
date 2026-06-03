import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SmartCrusher } from '../src/compression/SmartCrusher';
import { CodeCompressor } from '../src/compression/CodeCompressor';
import { CCR } from '../src/compression/CCR';
import { GraphDB } from '../src/storage';

describe('SmartCrusher', () => {
  it('truncates arrays in coding mode', () => {
    const data = Array.from({ length: 15 }, (_, i) => i);
    const out = SmartCrusher.crush(data, 'coding', 'standard') as unknown[];
    expect(out.length).toBe(11);
    expect(String(out[10])).toContain('omitted');
  });

  it('keeps larger windows for thinking mode', () => {
    const data = Array.from({ length: 30 }, (_, i) => i);
    const out = SmartCrusher.crush(data, 'thinking', 'standard') as unknown[];
    expect(out.length).toBe(26);
  });
});

describe('CodeCompressor', () => {
  it('skeletonizes function bodies', () => {
    const code = 'function add(a:number,b:number){return a+b;}';
    const out = CodeCompressor.skeletonize(code, 'coding');
    expect(out).toContain('function add');
    expect(out).not.toContain('return a + b');
  });
});

describe('CCR', () => {
  it('stores and retrieves original payload', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-ccr-test-'));
    const dbPath = path.join(tempDir, 'test.db');
    const db = await GraphDB.open(dbPath);
    try {
      const id = CCR.save(db, { k: 'v' });
      const retrieved = CCR.retrieve(db, id);
      expect(retrieved).toBe('{"k":"v"}');
    } finally {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
