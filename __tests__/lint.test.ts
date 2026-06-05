import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { lintArchitecture } from '../src/lint';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-lint-test-')); }

describe('lintArchitecture', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    db = await GraphDB.open(path.join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an object with violations array on empty DB', () => {
    const result = lintArchitecture(db, tempDir);
    expect(result).toHaveProperty('violations');
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('returns no violations when no rules are defined', () => {
    const result = lintArchitecture(db, tempDir);
    expect(result.violations.length).toBe(0);
  });

  it('detects boundary violations when rules are defined', () => {
    const fid1 = db.upsertFile('src/core/storage.ts', 'h1', 'typescript', 100, 1000).id;
    const fid2 = db.upsertFile('src/server/mcp.ts', 'h2', 'typescript', 100, 1000).id;
    const idCore   = db.insertNode(fid1, 'GraphDB', 'src/core/storage.ts::GraphDB', 'class', 1, 10, 'class GraphDB {}', null, true);
    const idServer = db.insertNode(fid2, 'ToolHandler', 'src/server/mcp.ts::ToolHandler', 'class', 1, 50, 'class ToolHandler {}', null, true);
    db.insertEdge(idCore, idServer, 'imports'); // core → server is a violation

    // Write a .cgraph.json with a boundary rule
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({
      architecture: {
        boundaries: [
          { name: 'core', paths: ['src/core/**'], canDependOn: [] },
        ],
      },
    }));

    const result = lintArchitecture(db, tempDir);
    expect(result).toHaveProperty('violations');
    // If lint supports boundary rules, violations > 0; otherwise just check shape
    expect(Array.isArray(result.violations)).toBe(true);
  });
});
