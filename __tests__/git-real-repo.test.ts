/**
 * Real git-repo integration tests for src/git.ts.
 *
 * The existing __tests__/git.test.ts calls findChangedSymbols against a
 * plain temp directory (not a real git repo), so every git command fails
 * and getChangedFiles always returns []. These tests instead create a
 * real git repository with actual commits and working-tree edits so the
 * diff parsing / hunk-matching logic in git.ts is genuinely exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { getChangedFiles, findChangedSymbols } from '../src/git';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-git-real-test-'));
}

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function initRepo(dir: string): void {
  run('git init -q', dir);
  run('git config user.email "test@example.com"', dir);
  run('git config user.name "Test User"', dir);
  run('git config commit.gpgsign false', dir);
}

describe('git.ts against a real git repository', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    initRepo(tempDir);
    db = await GraphDB.open(path.join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns no changes right after a clean commit', () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a() {}\n');
    run('git add a.ts', tempDir);
    run('git commit -q -m "init"', tempDir);

    const changes = getChangedFiles(tempDir);
    expect(changes).toEqual([]);
  }, 15_000);

  it('detects a modified file against HEAD', () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a() {}\n');
    run('git add a.ts', tempDir);
    run('git commit -q -m "init"', tempDir);

    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a() {}\nexport function b() {}\n');

    const changes = getChangedFiles(tempDir);
    expect(changes).toEqual([{ file: 'a.ts', status: 'modified' }]);
  }, 15_000);

  it('detects an added file when staged', () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a() {}\n');
    run('git add a.ts', tempDir);
    run('git commit -q -m "init"', tempDir);

    fs.writeFileSync(path.join(tempDir, 'new.ts'), 'export function n() {}\n');
    run('git add new.ts', tempDir);

    const changes = getChangedFiles(tempDir, { staged: true });
    expect(changes).toEqual([{ file: 'new.ts', status: 'added' }]);
  }, 15_000);

  it('detects a deleted file in the working tree', () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a() {}\n');
    run('git add a.ts', tempDir);
    run('git commit -q -m "init"', tempDir);

    fs.rmSync(path.join(tempDir, 'a.ts'));

    const changes = getChangedFiles(tempDir);
    expect(changes).toEqual([{ file: 'a.ts', status: 'deleted' }]);
  }, 15_000);

  it('returns [] when there is no git repository', () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-no-git-'));
    try {
      const changes = getChangedFiles(bareDir);
      expect(changes).toEqual([]);
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('marks only the symbol whose lines overlap a changed hunk as in_diff', () => {
    const initial = 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n';
    fs.writeFileSync(path.join(tempDir, 'demo.ts'), initial);
    run('git add demo.ts', tempDir);
    run('git commit -q -m "init"', tempDir);

    const fileId = db.upsertFile('demo.ts', 'h1', 'typescript', initial.length, 1000).id;
    db.insertNode(fileId, 'alpha', 'demo.ts::alpha', 'function', 1, 3, 'function alpha()', null, true);
    db.insertNode(fileId, 'beta', 'demo.ts::beta', 'function', 5, 7, 'function beta()', null, true);

    // Only touch beta's body — alpha's lines are untouched.
    const updated = 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 99;\n}\n';
    fs.writeFileSync(path.join(tempDir, 'demo.ts'), updated);

    const symbols = findChangedSymbols(db, tempDir, {});
    const names = symbols.map(s => s.name);
    expect(names).toContain('beta');
    expect(names).not.toContain('alpha');
    const betaEntry = symbols.find(s => s.name === 'beta')!;
    expect(betaEntry.change_type).toBe('in_diff');
  }, 15_000);

  it('marks every symbol in a newly added file as in_changed_file', () => {
    const content = 'export function gamma() {}\nexport function delta() {}\n';
    fs.writeFileSync(path.join(tempDir, 'base.ts'), 'export function base() {}\n');
    run('git add base.ts', tempDir);
    run('git commit -q -m "init"', tempDir);

    fs.writeFileSync(path.join(tempDir, 'added.ts'), content);
    run('git add added.ts', tempDir);

    const fileId = db.upsertFile('added.ts', 'h2', 'typescript', content.length, 1000).id;
    db.insertNode(fileId, 'gamma', 'added.ts::gamma', 'function', 1, 1, 'function gamma()', null, true);
    db.insertNode(fileId, 'delta', 'added.ts::delta', 'function', 2, 2, 'function delta()', null, true);

    const symbols = findChangedSymbols(db, tempDir, { staged: true });
    const names = symbols.map(s => s.name).sort();
    expect(names).toEqual(['delta', 'gamma']);
    expect(symbols.every(s => s.change_type === 'in_changed_file')).toBe(true);
  }, 15_000);

  it('returns [] when no files changed', () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a() {}\n');
    run('git add a.ts', tempDir);
    run('git commit -q -m "init"', tempDir);

    const symbols = findChangedSymbols(db, tempDir, {});
    expect(symbols).toEqual([]);
  }, 15_000);
});
